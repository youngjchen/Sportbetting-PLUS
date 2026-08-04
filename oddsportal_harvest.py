"""OddsPortal RESULTS 歷史賠率收割器（2026-08-05 使用者拍板：4/1 至今、四聯盟、
ml/hd/ou 初盤+收盤進結算畫面、波動記幕後）。

與日常閘（oddsportal_scraper.py）分工：
· 日常閘＝賽程驅動（pregame_data 撮合）、寫 data/oddsportal_summary.json（近況）。
· 收割器＝結果頁翻頁「發現驅動」（無賽程可撮合的歷史場），寫月檔：
    - data/oddsportal_archive/YYYY-MM.json    壓縮版（open/close/switch，結算畫面吃這份）
    - data/oddsportal_history/harvest-YYYY-MM.jsonl.gz  完整列+走勢史（幕後分析）
· 風險紀律：單線程、事件間 0.6~1.2s 間隔、連續 5 場失敗熔斷、--max-games 每批上限；
  斷點狀態 data/oddsportal_harvest_state.json（cursor 逐日往回走到 --from-date 為止）。
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from oddsportal_scraper import (
    TW, BASE_URL, LEAGUE_URLS, BOOKMAKER,
    team_zh, build_event_key, merge_game_snapshot, _compact_for_summary,
    _append_daily_archive, _assert_oddsportal_url, _collect_market,
    _market_summary, _market_has_data, _inferred_switches,
    _wait_for_market_navigation, _dismiss_consent, _stealth_session_factory,
    _write_json_atomic,
)
from urllib.parse import urljoin

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def parse_header_date(text: str, now: datetime) -> str | None:
    """結果頁日期標頭：'Today, 05 Aug' / 'Yesterday, 04 Aug' / '28 Jul' / '28 Jul 2026'。"""
    m = re.search(r"(?:(?:Yesterday|Today|Tomorrow),\s*)?(\d{1,2})\s+([A-Za-z]{3})(?:\s+(\d{4}))?", str(text or ""))
    if not m or m.group(2) not in MONTHS:
        return None
    year = int(m.group(3) or now.year)
    try:
        d = datetime(year, MONTHS[m.group(2)], int(m.group(1)), tzinfo=TW).date()
    except ValueError:
        return None
    if not m.group(3):  # 無年份→取距今最近的那個年份（跨年防呆）
        if (d - now.date()).days > 180:
            d = d.replace(year=year - 1)
        elif (now.date() - d).days > 180:
            d = d.replace(year=year + 1)
    return d.isoformat()


def collect_result_rows(page: Any, league: str, now: datetime, max_pages: int, oldest_date: str) -> list[dict[str, Any]]:
    """在瀏覽器內逐頁擷取結果列（純 JS 取結構化資料，翻頁用分頁鈕），直到日期早於 oldest_date。"""
    rows: list[dict[str, Any]] = []
    for page_no in range(1, max_pages + 1):
        page.wait_for_timeout(900)
        raw = page.evaluate(r"""() => {
          const out = [];
          let header = null;
          for (const ev of document.querySelectorAll('div.eventRow[id]')) {
            const t = ev.textContent || '';
            const hm = t.match(/(?:(?:Yesterday|Today|Tomorrow),\s*)?\d{1,2}\s+[A-Za-z]{3}(?:\s+\d{4})?/);
            // 標頭列與比賽列同容器：eventRow 首列常帶日期字樣
            const g = ev.querySelector('div.group[data-testid="game-row"]');
            if (hm && (!g || t.indexOf(hm[0]) < 60)) header = hm[0];
            if (!g) continue;
            const alts = [...g.querySelectorAll('[data-testid="event-participants"] img[alt]')].map(i => i.alt).filter(Boolean);
            const link = g.querySelector('a[href*="/baseball/h2h/"]');
            if (!link || alts.length < 2) continue;
            out.push({
              header, eventId: ev.id || ((link.getAttribute('href') || '').match(/#([A-Za-z0-9]+)/) || [])[1] || null,
              namesHomeAway: alts.slice(0, 2), href: link.getAttribute('href'),
            });
          }
          return out;
        }""")
        stop = False
        for item in raw or []:
            date = parse_header_date(item.get("header"), now)
            if not date or not item.get("eventId") or not item.get("href"):
                continue
            if date < oldest_date:
                stop = True
                continue
            if date >= now.date().isoformat():
                continue  # 今天的交給日常閘
            home, away = team_zh(item["namesHomeAway"][0]), team_zh(item["namesHomeAway"][1])
            if not home or not away:
                continue
            rows.append({
                "league": league, "date": date, "awayTeam": away, "homeTeam": home,
                "eventId": item["eventId"], "sourceUrl": _assert_oddsportal_url(urljoin(BASE_URL, item["href"])),
            })
        if stop:
            break
        # 翻頁：找「下一頁」數字鈕
        moved = page.evaluate(r"""() => {
          const links = [...document.querySelectorAll('a[data-number]')];
          const cur = links.find(a => a.classList.contains('active'))
            || [...document.querySelectorAll('a')].find(a => /pagination/i.test(a.className) && a.getAttribute('aria-current'));
          let curNo = cur ? Number(cur.getAttribute('data-number') || cur.textContent) : null;
          if (!curNo) {
            const hash = location.hash.match(/page\/(\d+)/);
            curNo = hash ? Number(hash[1]) : 1;
          }
          const next = links.find(a => Number(a.getAttribute('data-number')) === curNo + 1);
          if (next) { next.click(); return true; }
          return false;
        }""")
        if not moved:
            break
    # 去重（同 eventId 只留一筆）
    uniq: dict[str, dict[str, Any]] = {}
    for r in rows:
        uniq.setdefault(r["eventId"], r)
    return list(uniq.values())


def scrape_event_harvest(session: Any, event: dict[str, Any], observed_at: str) -> dict[str, Any] | None:
    """歷史場抓取：無賽程可撮合 → 開賽時間取「頁內 startDate 中與列表日期同日者」。"""
    captured: dict[str, Any] = {}

    def action(page: Any) -> None:
        _wait_for_market_navigation(page)
        _dismiss_consent(page)
        stub = datetime.fromisoformat(event["date"] + "T12:00:00+08:00")
        captured["ml"] = _collect_market(page, "Home/Away", stub, True)
        captured["ou"] = _collect_market(page, "Over/Under", stub, True)
        captured["hd"] = _collect_market(page, "Asian Handicap", stub, True)

    response = session.fetch(
        event["sourceUrl"], page_action=action,
        network_idle=True, wait=250, timeout=90000, disable_resources=False,
    )
    stamps = [int(x) for x in re.findall(r'"startDate":(\d{9,12})', str(response.html_content))]
    starts = [datetime.fromtimestamp(x, tz=TW) for x in stamps]
    same_day = [s for s in starts if s.date().isoformat() == event["date"]]
    if not same_day:
        return None
    start = min(same_day)
    start_iso = start.isoformat(timespec="seconds")
    markets = {
        name: _market_summary(captured.get(name) or [], name, observed_at, start_iso=start_iso)
        for name in ("ml", "hd", "ou")
    }
    markets = {k: v for k, v in markets.items() if _market_has_data(v)}
    if not markets:
        raise RuntimeError("Stake 無任何盤口資料")
    return {
        "league": event["league"], "date": event["date"],
        "startTime": start.strftime("%H:%M"), "startISO": start_iso,
        "awayTeam": event["awayTeam"], "homeTeam": event["homeTeam"],
        "eventId": event["eventId"], "sourceUrl": event["sourceUrl"],
        "observedAt": observed_at, "markets": markets,
        "handicapSwitch": _inferred_switches(captured.get("hd") or [], observed_at),
    }


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def archive_has_final(archive_cache: dict[str, dict], archive_dir: Path, game_key_parts: tuple[str, str, str, str]) -> bool:
    lg, date, away, home = game_key_parts
    month = date[:7]
    if month not in archive_cache:
        archive_cache[month] = load_json(archive_dir / f"{month}.json", {"games": {}})
    for key, g in (archive_cache[month].get("games") or {}).items():
        if g.get("league") == lg and g.get("date") == date and g.get("awayTeam") == away and g.get("homeTeam") == home:
            ml = (g.get("markets") or {}).get("ml") or {}
            if (ml.get("close") or {}).get("final") and _market_has_data(ml.get("open")):
                return True
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", default="", help="留空＝依 state 自動選（mlb→npb→kbo→cpbl 依序清）")
    parser.add_argument("--from-date", default="2026-04-01")
    parser.add_argument("--max-games", type=int, default=350)
    parser.add_argument("--max-pages", type=int, default=14)
    parser.add_argument("--archive-dir", default="data/oddsportal_archive")
    parser.add_argument("--history-dir", default="data/oddsportal_history")
    parser.add_argument("--state", default="data/oddsportal_harvest_state.json")
    args = parser.parse_args(argv)

    state_path = Path(args.state)
    state = load_json(state_path, {})
    league = args.league
    if not league:
        for lg in ("mlb", "npb", "kbo", "cpbl"):
            if not (state.get(lg) or {}).get("done"):
                league = lg
                break
        else:
            print(json.dumps({"note": "harvest-all-done"}))
            return 0
    if league not in LEAGUE_URLS:
        parser.error(f"未知聯盟 {league}")

    import scrapling.fetchers as fetchers
    SessionClass, session_options = _stealth_session_factory(fetchers)
    now = datetime.now(TW)
    observed_at = now.isoformat(timespec="seconds")
    cursor = (state.get(league) or {}).get("cursor") or now.date().isoformat()

    rows: list[dict[str, Any]] = []

    def listing_action(page: Any) -> None:
        _dismiss_consent(page)
        rows.extend(collect_result_rows(page, league, now, args.max_pages, args.from_date))

    archive_dir = Path(args.archive_dir)
    archive_cache: dict[str, dict] = {}
    successes: list[dict[str, Any]] = []
    errors: list[str] = []
    consecutive_fail = 0

    with SessionClass(**session_options) as session:
        session.fetch(
            _assert_oddsportal_url(urljoin(BASE_URL, LEAGUE_URLS[league].rstrip("/") + "/results/")),
            page_action=listing_action, network_idle=True, wait=1500, timeout=90000, disable_resources=False,
        )
        # cursor 之後(較新)的日期已收割過 → 只處理 date <= cursor；缺口(補漏)仍會因 archive_has_final=False 被重抓
        todo = [r for r in rows if r["date"] <= cursor]
        todo.sort(key=lambda r: (r["date"], r["awayTeam"]), reverse=True)  # 由新到舊逐日
        print(f"INFO {league} 結果頁發現 {len(rows)} 場、cursor({cursor}) 內待辦 {len(todo)} 場", file=sys.stderr)
        done_count = 0
        oldest_done: str | None = None
        for event in todo:
            if done_count >= args.max_games:
                break
            if archive_has_final(archive_cache, archive_dir, (league, event["date"], event["awayTeam"], event["homeTeam"])):
                oldest_done = event["date"]
                continue
            try:
                game = scrape_event_harvest(session, event, observed_at)
                if game is None:
                    errors.append(f"{event['eventId']} 起始時間對不上列表日期")
                    consecutive_fail += 1
                else:
                    successes.append(game)
                    done_count += 1
                    oldest_done = event["date"]
                    consecutive_fail = 0
            except Exception as exc:
                errors.append(f"{event['eventId']} {str(exc).splitlines()[0][:160]}")
                consecutive_fail += 1
            if consecutive_fail >= 5:
                errors.append("連續 5 場失敗＝熔斷，本批中止（可能被限流）")
                break
            time.sleep(random.uniform(0.6, 1.2))

    # 寫月檔（壓縮版＋幕後波動）
    by_month: dict[str, list[dict[str, Any]]] = {}
    for game in successes:
        by_month.setdefault(game["date"][:7], []).append(game)
    for month, games in by_month.items():
        arch_path = archive_dir / f"{month}.json"
        arch = archive_cache.get(month) or load_json(arch_path, {})
        arch.setdefault("version", 1)
        arch.setdefault("source", "OddsPortal")
        arch.setdefault("bookmaker", BOOKMAKER)
        arch.setdefault("games", {})
        for game in games:
            key = build_event_key(game["league"], game["date"], game["awayTeam"], game["homeTeam"], game["startTime"], game["eventId"])
            arch["games"][key] = merge_game_snapshot(arch["games"].get(key), _compact_for_summary(game))
        arch["updatedAt"] = observed_at
        _write_json_atomic(arch_path, arch)
        archive_cache[month] = arch
        _append_daily_archive(Path(args.history_dir) / f"harvest-{month}.jsonl.gz", {
            "observedAt": observed_at, "source": "OddsPortal", "bookmaker": BOOKMAKER,
            "games": games, "errors": [],
        })

    # 推進 cursor：本批處理到的最舊日期；若批內全數完成且已到底 → 標 done
    if oldest_done:
        st = state.get(league) or {}
        st["cursor"] = oldest_done
        if oldest_done <= args.from_date or (done_count < args.max_games and consecutive_fail < 5 and oldest_done <= args.from_date):
            st["done"] = True
        state[league] = st
    if oldest_done and oldest_done <= args.from_date:
        state[league]["done"] = True
    # 待辦清空且沒熔斷＝此聯盟結果頁已走到 from-date 之前 → done
    if not successes and not errors and cursor <= args.from_date:
        state.setdefault(league, {})["done"] = True
    _write_json_atomic(state_path, state) if state else None

    health = {"league": league, "harvested": len(successes), "failed": len(errors),
              "cursor": (state.get(league) or {}).get("cursor"), "done": bool((state.get(league) or {}).get("done")),
              "errors": errors[:8]}
    print(json.dumps(health, ensure_ascii=False))
    return 0 if (successes or not errors) else 1


if __name__ == "__main__":
    raise SystemExit(main())
