"""OddsPortal / Stake pre-game odds collector for Sportbetting-PLUS.

The browser visits normal OddsPortal event pages and interacts with the public UI.
It never calls Stake directly and never stores browser cookies or credentials.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse


TW = timezone(timedelta(hours=8))
BASE_URL = "https://www.oddsportal.com"
ALLOWED_HOST = "www.oddsportal.com"
BOOKMAKER = "Stake.com"
ACTIVE_WINDOW_HOURS = 18
LEAGUE_URLS = {
    "mlb": "/baseball/usa/mlb/",
    "npb": "/baseball/japan/npb/",
    "kbo": "/baseball/south-korea/kbo/",
    "cpbl": "/baseball/taiwan/cpbl/",
}


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


TEAM_ALIASES = {
    # MLB
    "Arizona Diamondbacks": "響尾蛇", "Pittsburgh Pirates": "海盜",
    "Baltimore Orioles": "金鶯", "Detroit Tigers": "老虎",
    "Philadelphia Phillies": "費城人", "Miami Marlins": "馬林魚",
    "Texas Rangers": "遊騎兵", "Tampa Bay Rays": "光芒",
    "Toronto Blue Jays": "藍鳥", "Washington Nationals": "國民",
    "Atlanta Braves": "勇士", "New York Mets": "大都會",
    "Cleveland Guardians": "守護者", "Cincinnati Reds": "紅人",
    "Kansas City Royals": "皇家", "Minnesota Twins": "雙城",
    "New York Yankees": "洋基", "Chicago White Sox": "白襪",
    "Chicago Cubs": "小熊", "St.Louis Cardinals": "紅雀",
    "St. Louis Cardinals": "紅雀", "Houston Astros": "太空人",
    "Los Angeles Angels": "天使", "Boston Red Sox": "紅襪",
    "Athletics": "運動家", "Oakland Athletics": "運動家",
    "Colorado Rockies": "落磯", "San Diego Padres": "教士",
    "Milwaukee Brewers": "釀酒人", "San Francisco Giants": "巨人",
    "Seattle Mariners": "水手", "Los Angeles Dodgers": "道奇",
    # NPB
    "Yomiuri Giants": "巨人", "Hanshin Tigers": "阪神",
    "Yokohama BayStars": "橫濱", "Yokohama DeNA BayStars": "橫濱",
    "Hiroshima Carp": "廣島", "Hiroshima Toyo Carp": "廣島",
    "Yakult Swallows": "養樂多", "Tokyo Yakult Swallows": "養樂多",
    "Chunichi Dragons": "中日", "Fukuoka SoftBank Hawks": "軟銀",
    "SoftBank Hawks": "軟銀", "Nippon Ham Fighters": "火腿",
    "Hokkaido Nippon-Ham Fighters": "火腿", "Orix Buffaloes": "歐力士",
    "Chiba Lotte Marines": "羅德", "Seibu Lions": "西武",
    "Saitama Seibu Lions": "西武", "Rakuten Gold. Eagles": "樂天",
    "Rakuten Golden Eagles": "樂天", "Tohoku Rakuten Golden Eagles": "樂天",
    # KBO
    "Doosan Bears": "斗山熊", "SSG Landers": "登陸者",
    "Kiwoom Heroes": "培證", "LG Twins": "雙子", "KT Wiz": "巫師",
    "NC Dinos": "恐龍", "Samsung Lions": "三星獅",
    "Hanwha Eagles": "華老鷹", "KIA Tigers": "起亞虎",
    "Lotte Giants": "樂天",
    # CPBL
    "CTBC Brothers": "兄弟", "Chinatrust Brothers": "兄弟",
    "TSG Hawks": "台鋼", "Tainan TSG GhostHawks": "台鋼",
    "Wei Chuan Dragons": "味全", "Fubon Guardians": "富邦",
    "Rakuten Monkeys": "樂天", "Uni Lions": "統一",
    "Uni-President Lions": "統一",
}
TEAM_ALIASES_NORM = {_norm(key): value for key, value in TEAM_ALIASES.items()}
TEAM_ALIASES_NORM[_norm("Fukuoka S. Hawks")] = TEAM_ALIASES_NORM[_norm("Fukuoka SoftBank Hawks")]
TEAM_ALIASES_NORM[_norm("KT Wiz Suwon")] = TEAM_ALIASES_NORM[_norm("KT Wiz")]


def team_zh(name: str) -> str | None:
    return TEAM_ALIASES_NORM.get(_norm(name))


def build_event_key(
    league: str,
    date: str,
    away: str,
    home: str,
    start_time: str,
    event_id: str,
) -> str:
    """A doubleheader-safe key. Never collapse two same-day events by pair alone."""
    return "|".join([
        str(league).lower(), str(date)[:10], str(away), str(home),
        str(start_time)[:5], str(event_id),
    ])


def _favorite(snapshot: dict[str, Any]) -> str | None:
    return (((snapshot.get("markets") or {}).get("hd") or {}).get("active") or {}).get("favorite")


def reduce_handicap_switches(snapshots: Iterable[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        (copy.deepcopy(item) for item in snapshots if _favorite(item) in {"away", "home"}),
        key=lambda item: str(item.get("observedAt") or ""),
    )
    if not ordered:
        return {
            "ever": False, "count": 0, "initialFavorite": None,
            "currentFavorite": None, "first": None, "last": None,
        }
    initial = _favorite(ordered[0])
    current = initial
    changes = []
    for item in ordered[1:]:
        nxt = _favorite(item)
        if nxt == current:
            continue
        changes.append({
            "from": current,
            "to": nxt,
            "detectedAt": item.get("observedAt"),
            "precision": "poll",
        })
        current = nxt
    return {
        "ever": bool(changes),
        "count": len(changes),
        "initialFavorite": initial,
        "currentFavorite": current,
        "first": changes[0] if changes else None,
        "last": changes[-1] if changes else None,
    }


def _market_has_data(value: Any) -> bool:
    return isinstance(value, dict) and any(v not in (None, "", [], {}) for v in value.values())


def _merge_market(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(old or {})
    for key, value in (new or {}).items():
        if value in (None, "", [], {}):
            continue
        if key == "open" and _market_has_data(merged.get("open")):
            continue
        merged[key] = copy.deepcopy(value)
    return merged


def _combine_switches(*states: dict[str, Any] | None) -> dict[str, Any]:
    valid = [copy.deepcopy(state) for state in states if isinstance(state, dict)]
    if not valid:
        return reduce_handicap_switches([])
    best = max(valid, key=lambda state: int(state.get("count") or 0))
    result = copy.deepcopy(best)
    result["ever"] = any(bool(state.get("ever")) for state in valid)
    firsts = [state.get("first") for state in valid if state.get("first")]
    lasts = [state.get("last") for state in valid if state.get("last")]
    if firsts:
        result["first"] = min(firsts, key=lambda x: str(x.get("detectedAt") or x.get("estimatedAt") or ""))
    if lasts:
        result["last"] = max(lasts, key=lambda x: str(x.get("detectedAt") or x.get("estimatedAt") or ""))
    for state in reversed(valid):
        if state.get("currentFavorite") in {"away", "home"}:
            result["currentFavorite"] = state["currentFavorite"]
            break
    return result


def merge_game_snapshot(old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    """Union merge: a partial/empty scrape can update evidence, never erase it."""
    old = copy.deepcopy(old or {})
    markets = new.get("markets") if isinstance(new, dict) else None
    if not isinstance(markets, dict) or not any(_market_has_data(v) for v in markets.values()):
        return old

    merged = old
    for key in (
        "eventId", "league", "date", "startTime", "startISO", "awayTeam",
        "homeTeam", "sourceUrl", "observedAt",
    ):
        if new.get(key) not in (None, ""):
            merged[key] = copy.deepcopy(new[key])
    merged["markets"] = copy.deepcopy(merged.get("markets") or {})
    for market, value in markets.items():
        if _market_has_data(value):
            merged["markets"][market] = _merge_market(merged["markets"].get(market) or {}, value)

    old_state = old.get("handicapSwitch") or {}
    observed = _favorite(new)
    previous = old_state.get("currentFavorite")
    observed_state = copy.deepcopy(old_state) if old_state else reduce_handicap_switches([])
    if observed in {"away", "home"}:
        if previous in {"away", "home"} and previous != observed:
            change = {
                "from": previous, "to": observed,
                "detectedAt": new.get("observedAt"), "precision": "poll",
            }
            observed_state.update({
                "ever": True,
                "count": int(old_state.get("count") or 0) + 1,
                "initialFavorite": old_state.get("initialFavorite") or previous,
                "currentFavorite": observed,
                "first": old_state.get("first") or change,
                "last": change,
            })
        else:
            observed_state["initialFavorite"] = observed_state.get("initialFavorite") or observed
            observed_state["currentFavorite"] = observed
    merged["handicapSwitch"] = _combine_switches(
        old.get("handicapSwitch"), new.get("handicapSwitch"), observed_state,
    )
    return merged


def _parse_number(text: Any) -> float | None:
    match = re.search(r"[-+]?\d+(?:\.\d+)?", str(text or "").replace(",", ""))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _parse_history_time(value: str, event_start: datetime) -> str | None:
    value = str(value or "").strip().replace("  ", " ")
    for fmt in ("%d %b, %H:%M", "%d %b %Y, %H:%M"):
        try:
            if "%Y" not in fmt:
                parsed = datetime.strptime(
                    f"{value} {event_start.year}", f"{fmt} %Y"
                ).replace(tzinfo=TW)
                if parsed - event_start > timedelta(days=180):
                    parsed = parsed.replace(year=event_start.year - 1)
            else:
                parsed = datetime.strptime(value, fmt).replace(tzinfo=TW)
            return parsed.isoformat(timespec="seconds")
        except ValueError:
            pass
    return None


def _assert_oddsportal_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != ALLOWED_HOST:
        raise ValueError(f"拒絕非 OddsPortal URL: {url}")
    return url


def _event_id_from_href(href: str) -> str | None:
    match = re.search(r"#([A-Za-z0-9]+)", str(href or ""))
    return match.group(1) if match else None


def _is_pregame_listing(text: str) -> bool:
    lowered = str(text or "").lower()
    closed_markers = ("finished", "| fin |", "live", "postponed", "cancelled", "canceled", "awarded")
    return not any(marker in lowered for marker in closed_markers)


def _parse_listing_date(text: str, now: datetime) -> str | None:
    match = re.search(
        r"(?:Yesterday|Today|Tomorrow),\s*(\d{1,2})\s+([A-Za-z]{3})(?:\s+(\d{4}))?",
        str(text or ""), re.IGNORECASE,
    )
    if not match:
        return None
    year = int(match.group(3) or now.year)
    try:
        parsed = datetime.strptime(f"{match.group(1)} {match.group(2)} {year}", "%d %b %Y").date()
    except ValueError:
        return None
    if not match.group(3):
        if (parsed - now.date()).days > 180:
            parsed = parsed.replace(year=year - 1)
        elif (now.date() - parsed).days > 180:
            parsed = parsed.replace(year=year + 1)
    return parsed.isoformat()


def _listing_matches_schedule(event: dict[str, Any], schedule: list[dict[str, Any]]) -> bool:
    candidates = [
        row for row in schedule
        if row.get("league") == event.get("league")
        and row.get("date") == event.get("listingDate")
        and row.get("awayTeam") == event.get("awayTeam")
        and row.get("homeTeam") == event.get("homeTeam")
    ]
    event_match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(event.get("listingTime") or ""))
    if not candidates or not event_match:
        return False
    wanted = int(event_match.group(1)) * 60 + int(event_match.group(2))
    for row in candidates:
        match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(row.get("startTime") or ""))
        if match and abs(wanted - (int(match.group(1)) * 60 + int(match.group(2)))) <= 120:
            return True
    return False


def _listing_start(event: dict[str, Any]) -> datetime | None:
    date = str(event.get("listingDate") or "")
    time_text = str(event.get("listingTime") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or not re.fullmatch(r"\d{2}:\d{2}", time_text):
        return None
    try:
        return datetime.fromisoformat(f"{date}T{time_text}:00+08:00")
    except ValueError:
        return None


def _discover_events(response: Any, league: str, now: datetime | None = None) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    current_date = None
    now = now or datetime.now(TW)
    for container in response.css('div.eventRow[id]'):
        container_text = container.get_all_text(separator=" | ", strip=True)
        current_date = _parse_listing_date(container_text, now) or current_date
        row = container.css('div.group[data-testid="game-row"]').first
        if not row:
            continue
        if not _is_pregame_listing(row.get_all_text(separator=" | ", strip=True)):
            continue
        link = row.css('a[href*="/baseball/h2h/"]').first
        if not link:
            continue
        href = link.attrib.get("href") or ""
        event_id = str(container.attrib.get("id") or "") or _event_id_from_href(href)
        names = [img.attrib.get("alt") for img in row.css('[data-testid="event-participants"] img[alt]')]
        names = [name for name in names if name]
        if not event_id or len(names) < 2:
            continue
        # OddsPortal baseball event rows are home first, away second; the board
        # and pregame_data use away @ home.
        home, away = team_zh(names[0]), team_zh(names[1])
        if not away or not home:
            continue
        time_match = re.search(r"\b(\d{1,2}:\d{2})\b", row.get_all_text(separator=" | ", strip=True))
        url = _assert_oddsportal_url(urljoin(BASE_URL, href))
        found[event_id] = {
            "eventId": event_id,
            "league": league,
            "awayTeam": away,
            "homeTeam": home,
            "sourceUrl": url,
            "sourceNamesHomeAway": names[:2],
            "listingDate": current_date,
            "listingTime": time_match.group(1).zfill(5) if time_match else None,
        }
    return list(found.values())


def _row_history(cell: Any, page: Any, event_start: datetime, with_history: bool) -> dict[str, Any]:
    if not with_history:
        return {"opening": None, "movements": []}
    try:
        cell.hover(timeout=5000)
        cell.locator("h3").filter(has_text="Odds movement").first.wait_for(state="attached", timeout=4000)
        raw = cell.evaluate(
            r"""el => {
              const h = [...el.querySelectorAll('h3')].find(x => x.textContent.trim() === 'Odds movement');
              if (!h) return {opening:null, movements:[]};
              const box = h.parentElement;
              const openingBox = [...box.children].find(x => x.textContent.includes('Opening odds:'));
              let opening = null;
              if (openingBox) {
                const leaves = [...openingBox.querySelectorAll('div')]
                  .filter(x => x.children.length === 0).map(x => x.textContent.trim());
                const date = leaves.find(x => /^\d{1,2} [A-Za-z]{3}(?: \d{4})?, \d{2}:\d{2}$/.test(x));
                const odd = [...leaves].reverse().find(x => /^\d+(?:\.\d+)?$/.test(x));
                if (date && odd) opening = {at:date, odds:odd};
              }
              const movementBox = [...box.children].find(x => x.classList.contains('flex-row'));
              const movements = [];
              if (movementBox && movementBox.children.length >= 2) {
                const times = [...movementBox.children[0].children].map(x => x.textContent.trim());
                const odds = [...movementBox.children[1].children].map(x => x.textContent.trim());
                for (let i=0; i<Math.min(times.length, odds.length); i++) {
                  if (times[i] && odds[i]) movements.push({at:times[i], odds:odds[i]});
                }
              }
              return {opening, movements};
            }"""
        )
    except Exception:
        return {"opening": None, "movements": []}
    opening = raw.get("opening") if isinstance(raw, dict) else None
    moves = raw.get("movements") if isinstance(raw, dict) else []
    out_open = None
    if opening:
        out_open = {
            "at": _parse_history_time(opening.get("at"), event_start),
            "odds": _parse_number(opening.get("odds")),
        }
    out_moves = []
    for item in moves or []:
        at = _parse_history_time(item.get("at"), event_start)
        odds = _parse_number(item.get("odds"))
        if at and odds is not None:
            out_moves.append({"at": at, "odds": odds})
    return {"opening": out_open, "movements": out_moves}


def _capture_stake_row(row: Any, page: Any, event_start: datetime, with_history: bool, selected: bool = False) -> dict[str, Any]:
    total = row.get_by_test_id("total-container")
    line = _parse_number(total.first.inner_text()) if total.count() else None
    cells = row.get_by_test_id("odd-container")
    sides = []
    for index in range(min(cells.count(), 2)):
        cell = cells.nth(index)
        direct = cell.locator("a.odds-link, p.odds-text")
        odds = _parse_number(direct.first.inner_text()) if direct.count() else None
        sides.append({
            "odds": odds,
            "active": cell.locator("a.odds-link").count() > 0,
            "struck": cell.locator(".line-through").count() > 0,
            "history": _row_history(cell, page, event_start, with_history),
        })
    if len(sides) != 2:
        return {}
    return {
        "line": line,
        # Column 1/2 are home/away for Home-Away and Asian Handicap.
        # For Over-Under they are over/under; normalize that in _market_summary.
        "first": sides[0],
        "second": sides[1],
        "active": all(side["active"] for side in sides),
        "struck": all(side["struck"] for side in sides),
        "selected": bool(selected),
    }


def _wait_for_market_navigation(page: Any) -> None:
    page.get_by_test_id("bet-types-nav").wait_for(state="visible", timeout=20000)


def _collect_market(page: Any, label: str, event_start: datetime, with_history: bool) -> list[dict[str, Any]]:
    nav = page.get_by_test_id("bet-types-nav")
    tab = nav.get_by_text(label, exact=True)
    if not tab.count():
        return []
    tab.first.click(timeout=8000)
    if label == "Home/Away":
        page.wait_for_timeout(1200)
    else:
        # The hash changes before OddsPortal has replaced the previous market's
        # rows. Waiting on a label from the requested market prevents us from
        # reading stale Over/Under rows as an empty Asian Handicap market.
        page.get_by_test_id("over-under-collapsed-row").filter(
            has_text=label,
        ).first.wait_for(state="visible", timeout=8000)
    collected: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()

    def capture_visible(selected: bool = False) -> None:
        rows = page.get_by_test_id("over-under-expanded-row")
        for index in range(rows.count()):
            row = rows.nth(index)
            if row.locator('img[alt="Stake.com"]').count() == 0:
                continue
            item = _capture_stake_row(row, page, event_start, with_history, selected=selected)
            if not item:
                continue
            sig = (item.get("line"), item["first"].get("odds"), item["second"].get("odds"), item.get("active"), item.get("struck"))
            if sig not in seen:
                seen.add(sig)
                collected.append(item)

    if label == "Home/Away":
        capture_visible(selected=True)
        return collected

    collapsed = page.get_by_test_id("over-under-collapsed-row")
    candidates = []
    for index in range(collapsed.count()):
        row = collapsed.nth(index)
        option = row.get_by_test_id("over-under-collapsed-option-box")
        lines = option.first.inner_text().splitlines() if option.count() else row.inner_text().splitlines()
        label_text = lines[0].strip() if lines else ""
        count = int(lines[-1].strip()) if lines and lines[-1].strip().isdigit() else 0
        if label == "Asian Handicap":
            number = _parse_number(label_text)
            if number is None or abs(abs(number) - 1.5) > 0.001:
                continue
        candidates.append((label_text, count))
    if label == "Over/Under":
        candidates.sort(key=lambda item: item[1], reverse=True)

    tried: set[str] = set()
    for target_label, _ in candidates:
        if not target_label or target_label in tried:
            continue
        tried.add(target_label)
        current = page.get_by_test_id("over-under-collapsed-row").filter(has_text=target_label)
        if not current.count():
            continue
        try:
            current.first.click(timeout=5000)
            page.wait_for_timeout(500)
            before = len(collected)
            capture_visible(selected=(label == "Over/Under" and before == 0))
            if label == "Over/Under" and len(collected) > before:
                break
        except Exception:
            continue
    return collected


def _opening_side(row: dict[str, Any], side: str) -> dict[str, Any] | None:
    history = (row.get(side) or {}).get("history") or {}
    opening = history.get("opening")
    return opening if isinstance(opening, dict) and opening.get("at") and opening.get("odds") is not None else None


def _regime_open_at(row: dict[str, Any]) -> str | None:
    times = [item.get("at") for item in (_opening_side(row, "first"), _opening_side(row, "second")) if item]
    return min(times) if times else None


def favorite_for_line(line: Any) -> str | None:
    number = _parse_number(line)
    if number is None or number == 0:
        return None
    return "home" if number < 0 else "away"


def _inferred_switches(rows: list[dict[str, Any]], observed_at: str) -> dict[str, Any]:
    regimes = []
    for row in rows:
        line_number = _parse_number(row.get("line"))
        if line_number is None or abs(abs(line_number) - 1.5) > 0.001:
            continue
        favorite = favorite_for_line(row.get("line"))
        opened = _regime_open_at(row)
        if favorite and opened and (row.get("active") or row.get("struck")):
            regimes.append({"favorite": favorite, "at": opened, "active": bool(row.get("active"))})
    regimes.sort(key=lambda item: item["at"])
    active = next((item for item in regimes if item["active"]), None)
    sequence = []
    for item in regimes:
        if not sequence or sequence[-1]["favorite"] != item["favorite"]:
            sequence.append(item)
    if active and sequence and sequence[-1]["favorite"] != active["favorite"]:
        sequence.append({"favorite": active["favorite"], "at": observed_at, "active": True, "detected": True})
    changes = []
    for before, after in zip(sequence, sequence[1:]):
        changes.append({
            "from": before["favorite"], "to": after["favorite"],
            "estimatedAt": after["at"],
            "detectedAt": observed_at if after.get("detected") else None,
            "precision": "detected-after-old-line" if after.get("detected") else "line-open-time",
        })
    if not changes:
        active_row = next((row for row in rows if row.get("active") and favorite_for_line(row.get("line"))), None)
        active_favorite = favorite_for_line(active_row.get("line")) if active_row else None
        struck_opposite = next((
            row for row in rows
            if row.get("struck") and favorite_for_line(row.get("line"))
            and favorite_for_line(row.get("line")) != active_favorite
        ), None)
        if active_favorite and struck_opposite:
            prior_favorite = favorite_for_line(struck_opposite.get("line"))
            change = {
                "from": prior_favorite, "to": active_favorite,
                "estimatedAt": None, "detectedAt": observed_at,
                "precision": "struck-opposite-detected",
            }
            return {
                "ever": True, "count": 1,
                "initialFavorite": prior_favorite,
                "currentFavorite": active_favorite,
                "first": change, "last": change,
            }
    return {
        "ever": bool(changes), "count": len(changes),
        "initialFavorite": sequence[0]["favorite"] if sequence else None,
        "currentFavorite": active["favorite"] if active else (sequence[-1]["favorite"] if sequence else None),
        "first": changes[0] if changes else None,
        "last": changes[-1] if changes else None,
    }


def _market_summary(rows: list[dict[str, Any]], market: str, observed_at: str) -> dict[str, Any]:
    usable = rows
    if market == "hd":
        usable = [row for row in rows if row.get("line") is not None and abs(abs(float(row["line"])) - 1.5) <= 0.001]
    if market == "ou":
        selected = next((row for row in rows if row.get("selected") and row.get("active")), None)
        usable = [selected] if selected else rows
    active = next((row for row in usable if row.get("active")), None)
    candidates = [(row, _regime_open_at(row)) for row in usable]
    candidates = [(row, at) for row, at in candidates if at]
    opening_row = min(candidates, key=lambda item: item[1])[0] if candidates else active
    result: dict[str, Any] = {"rows": usable}
    if opening_row:
        first_open = _opening_side(opening_row, "first")
        second_open = _opening_side(opening_row, "second")
        if first_open and second_open:
            result["open"] = {"at": min(first_open["at"], second_open["at"])}
            if market == "ou":
                result["open"].update({"over": first_open["odds"], "under": second_open["odds"]})
            else:
                result["open"].update({"home": first_open["odds"], "away": second_open["odds"]})
            if market != "ml":
                result["open"]["line"] = opening_row.get("line")
            if market == "hd":
                result["open"]["favorite"] = favorite_for_line(opening_row.get("line"))
    if active:
        result["active"] = {"at": observed_at}
        if market == "ou":
            result["active"].update({"over": active["first"].get("odds"), "under": active["second"].get("odds")})
        else:
            result["active"].update({"home": active["first"].get("odds"), "away": active["second"].get("odds")})
        if market != "ml":
            result["active"]["line"] = active.get("line")
        if market == "hd":
            result["active"]["favorite"] = favorite_for_line(active.get("line"))
        result["close"] = copy.deepcopy(result["active"])
    return result


def _missing_market_diagnostic(captured: dict[str, Any]) -> str:
    counts = " ".join(
        f"{name}={len(captured.get(name) or [])}" for name in ("ml", "hd", "ou")
    )
    visible = ",".join(str(item) for item in (captured.get("visibleBookmakers") or [])[:12])
    return (
        f"Stake.com 無可用盤口 ({counts}); "
        f"目前頁面可見 bookmaker/logo: {visible or 'none'}"
    )


def _extract_start(response: Any) -> datetime | None:
    match = re.search(r'"startDate":(\d{9,12})', str(response.html_content))
    if not match:
        return None
    return datetime.fromtimestamp(int(match.group(1)), tz=TW)


def _load_schedule(path: Path, now: datetime) -> list[dict[str, Any]]:
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"pregame_data 無法讀取，拒絕抓取：{exc}") from exc
    if not isinstance(rows, list):
        raise RuntimeError("pregame_data 必須是陣列")
    # Never sample after first pitch: OddsPortal may already expose in-play prices,
    # while this feed promises a pre-game closing snapshot.
    start = now.isoformat()
    # The first in-window scrape hydrates earlier movements from OddsPortal's
    # hover history, so polling farther ahead only wastes the 15-minute budget.
    end = (now + timedelta(hours=ACTIVE_WINDOW_HOURS)).isoformat()
    out = []
    for row in rows:
        league = str(row.get("league") or "").lower()
        date = str(row.get("date") or "")[:10]
        time_text = str(row.get("gameTime") or row.get("time") or "")
        match = re.search(r"\d{1,2}:\d{2}", time_text)
        if league not in LEAGUE_URLS or not date or not match:
            continue
        hhmm = match.group(0).zfill(5)
        start_iso = f"{date}T{hhmm}:00+08:00"
        if start <= start_iso <= end:
            out.append({
                "league": league, "date": date, "startTime": hhmm,
                "startISO": start_iso, "awayTeam": row.get("awayTeam"),
                "homeTeam": row.get("homeTeam"), "officialId": row.get("officialId"),
            })
    return out


def _match_schedule(event: dict[str, Any], start: datetime, schedule: list[dict[str, Any]]) -> dict[str, Any] | None:
    candidates = [row for row in schedule if row["league"] == event["league"] and row["awayTeam"] == event["awayTeam"] and row["homeTeam"] == event["homeTeam"]]
    if not candidates:
        return None
    return min(candidates, key=lambda row: abs(datetime.fromisoformat(row["startISO"]) - start))


def scrape_event(session: Any, event: dict[str, Any], schedule: list[dict[str, Any]], observed_at: str, with_history: bool = True) -> dict[str, Any] | None:
    captured: dict[str, Any] = {}
    listing_start = _listing_start(event)

    def action(page: Any) -> None:
        # H2H HTML contains historical events; the first embedded startDate can
        # belong to yesterday. The league listing is already keyed to eventId.
        event_start = listing_start
        if event_start is None:
            stamp = page.evaluate("() => { const m=document.documentElement.innerHTML.match(/\\\"startDate\\\":(\\d{9,12})/); return m?Number(m[1]):null; }")
            event_start = datetime.fromtimestamp(stamp, tz=TW) if stamp else datetime.now(TW)
        _wait_for_market_navigation(page)
        captured["ml"] = _collect_market(page, "Home/Away", event_start, with_history)
        captured["ou"] = _collect_market(page, "Over/Under", event_start, with_history)
        captured["hd"] = _collect_market(page, "Asian Handicap", event_start, with_history)
        try:
            captured["visibleBookmakers"] = page.locator(
                '[data-testid="over-under-expanded-row"] img[alt]'
            ).evaluate_all(
                "els => [...new Set(els.map(el => el.getAttribute('alt')).filter(Boolean))]"
            )
        except Exception:
            captured["visibleBookmakers"] = []

    response = session.fetch(
        _assert_oddsportal_url(event["sourceUrl"]),
        page_action=action,
        network_idle=True,
        wait=250,
        timeout=90000,
        disable_resources=False,
    )
    start = listing_start or _extract_start(response)
    if not start:
        return None
    official = _match_schedule(event, start, schedule)
    if not official or abs(datetime.fromisoformat(official["startISO"]) - start) > timedelta(minutes=120):
        return None
    markets = {
        name: _market_summary(captured.get(name) or [], name, observed_at)
        for name in ("ml", "hd", "ou")
    }
    markets = {key: value for key, value in markets.items() if _market_has_data(value)}
    if not markets:
        raise RuntimeError(_missing_market_diagnostic(captured))
    switch = _inferred_switches(captured.get("hd") or [], observed_at)
    return {
        **{key: official[key] for key in ("league", "date", "startTime", "startISO", "awayTeam", "homeTeam")},
        "eventId": event["eventId"], "sourceUrl": event["sourceUrl"],
        "observedAt": observed_at, "markets": markets,
        "handicapSwitch": switch,
    }


def _load_summary(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "source": "OddsPortal", "bookmaker": BOOKMAKER, "updatedAt": None, "games": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"{path} 已損壞，拒絕從空檔覆寫：{exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("games"), dict):
        raise RuntimeError(f"{path} 結構不合法，拒絕覆寫")
    return data


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    json.loads(temp.read_text(encoding="utf-8"))
    temp.replace(path)


def _append_daily_archive(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing: list[str] = []
    if path.exists():
        try:
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                existing = [line.rstrip("\n") for line in handle if line.strip()]
        except Exception as exc:
            raise RuntimeError(f"{path} 已損壞，拒絕覆寫：{exc}") from exc
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    run_id = record.get("observedAt")
    if any(json.loads(item).get("observedAt") == run_id for item in existing):
        return
    payload = ("\n".join(existing + [line]) + "\n").encode("utf-8")
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
            zipped.write(payload)
    with gzip.open(temp, "rt", encoding="utf-8") as handle:
        [json.loads(item) for item in handle if item.strip()]
    temp.replace(path)


def _has_opening_summary(summary: dict[str, Any], event_id: str) -> bool:
    game = next((item for item in (summary.get("games") or {}).values() if item.get("eventId") == event_id), None)
    markets = (game or {}).get("markets") or {}
    return all(_market_has_data((markets.get(name) or {}).get("open")) for name in ("ml", "hd", "ou"))


def _compact_for_summary(game: dict[str, Any]) -> dict[str, Any]:
    compact = {key: copy.deepcopy(value) for key, value in game.items() if key != "markets"}
    compact["markets"] = {}
    for name, market in (game.get("markets") or {}).items():
        kept = {}
        for key in ("open", "close", "active"):
            if _market_has_data(market.get(key)):
                kept[key] = copy.deepcopy(market[key])
        if kept:
            compact["markets"][name] = kept
    return compact


def _partition_batches(items: list[dict[str, Any]], worker_count: int) -> list[list[dict[str, Any]]]:
    if not items:
        return []
    count = max(1, min(int(worker_count or 1), len(items)))
    return [items[index::count] for index in range(count)]


def _stealth_session_factory(fetchers: Any) -> tuple[Any, dict[str, Any]]:
    """Return the protected-browser session and its cloud-safe defaults."""
    return fetchers.StealthySession, {
        "headless": True,
        "block_ads": True,
        "locale": "en-US",
        "timezone_id": "Asia/Taipei",
        "solve_cloudflare": True,
        "block_webrtc": True,
        "hide_canvas": True,
        "allow_webgl": True,
        "google_search": True,
    }


def run_once(summary_path: Path, history_dir: Path, schedule_path: Path, leagues: list[str]) -> dict[str, Any]:
    try:
        import scrapling.fetchers as fetchers
    except ImportError as exc:
        raise RuntimeError("尚未安裝 Scrapling；請先 pip install -r requirements-scraping.txt") from exc

    SessionClass, session_options = _stealth_session_factory(fetchers)

    now = datetime.now(TW)
    observed_at = now.isoformat(timespec="seconds")
    schedule = _load_schedule(schedule_path, now)
    summary = _load_summary(summary_path)
    discovered: list[dict[str, Any]] = []
    successes: list[dict[str, Any]] = []
    errors: list[str] = []

    with SessionClass(**session_options) as session:
        for league in leagues:
            try:
                listing = session.fetch(
                    _assert_oddsportal_url(urljoin(BASE_URL, LEAGUE_URLS[league])),
                    network_idle=True, wait=1200, timeout=90000, disable_resources=False,
                )
                for event in _discover_events(listing, league, now):
                    if _listing_matches_schedule(event, schedule):
                        discovered.append(event)
            except Exception as exc:
                errors.append(f"{league} discovery: {exc}")

    unique = {event["eventId"]: event for event in discovered}

    def scrape_batch(batch: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
        batch_successes: list[dict[str, Any]] = []
        batch_errors: list[str] = []
        with SessionClass(**session_options) as session:
            for event in batch:
                try:
                    game = scrape_event(
                        session, event, schedule, observed_at,
                        with_history=not _has_opening_summary(summary, event["eventId"]),
                    )
                    if game:
                        batch_successes.append(game)
                except Exception as exc:
                    batch_errors.append(f"{event['league']} {event['eventId']}: {exc}")
        return batch_successes, batch_errors

    batches = _partition_batches(list(unique.values()), 2)
    if batches:
        with ThreadPoolExecutor(max_workers=len(batches), thread_name_prefix="oddsportal") as executor:
            for batch_successes, batch_errors in executor.map(scrape_batch, batches):
                successes.extend(batch_successes)
                errors.extend(batch_errors)

    if not successes:
        raise RuntimeError("OddsPortal 本輪 0 場有效資料；保留舊檔並以失敗結束。" + (" | " + " | ".join(errors[:5]) if errors else ""))

    for game in successes:
        key = build_event_key(game["league"], game["date"], game["awayTeam"], game["homeTeam"], game["startTime"], game["eventId"])
        summary["games"][key] = merge_game_snapshot(summary["games"].get(key), _compact_for_summary(game))
    summary.update({
        "version": 1, "source": "OddsPortal", "bookmaker": BOOKMAKER,
        "updatedAt": observed_at,
        "health": {
            "scheduled": len(schedule), "discovered": len({item['eventId'] for item in discovered}),
            "succeeded": len(successes), "failed": len(errors), "errors": errors[:20],
        },
    })
    _write_json_atomic(summary_path, summary)
    archive_record = {
        "observedAt": observed_at, "source": "OddsPortal", "bookmaker": BOOKMAKER,
        "games": successes, "errors": errors,
    }
    _append_daily_archive(history_dir / f"{now.date().isoformat()}.jsonl.gz", archive_record)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", default="data/oddsportal_summary.json")
    parser.add_argument("--history-dir", default="data/oddsportal_history")
    parser.add_argument("--schedule", default="data/pregame_data.json")
    parser.add_argument("--leagues", default=",".join(LEAGUE_URLS))
    args = parser.parse_args(argv)
    leagues = [item.strip().lower() for item in args.leagues.split(",") if item.strip()]
    unknown = [item for item in leagues if item not in LEAGUE_URLS]
    if unknown:
        parser.error(f"未知聯盟: {','.join(unknown)}")
    try:
        result = run_once(Path(args.summary), Path(args.history_dir), Path(args.schedule), leagues)
        print(json.dumps(result.get("health"), ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
