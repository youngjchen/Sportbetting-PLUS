"""OddsPortal 的 BET365 欄＝棒球 BET365 第二道備援（2026-10-12 使用者規格）。

來源順序（使用者拍板）：BET365 官網 → BetExplorer 的 BET365 欄（第一道備援）
→ OddsPortal 的 BET365 欄（第二道備援）→ Titan 最後。
「BetExplorer 沒抓到就抓 OddsPortal」：BetExplorer 該場沒有可用的 bet365 讓分列，
或 90 分鐘沒更新（網站當機，10/11 晚上實例），本程式才去 OddsPortal 抓。

- OddsPortal 與 BetExplorer 同一家公司，比賽編號共用（OArdFvm3、8KICHMzo 兩站相同）。
- 頁面要瀏覽器渲染 → scrapling 真 Chrome，只在使用者電腦跑（local_failover 每 30 分）。
- 讓分頁會保留莊家撤下的舊線（劃線）＝對調證據，與 BetExplorer 同語意
  （10/12 樂天@斗山熊：bet365 −1.5 劃線、+1.5 現行，兩站一致）。
- 線是「主隊視角」：負＝主隊讓、正＝主隊受讓。
- 只抓未開賽的場（開賽後頁面會混入場中盤）。

產出 data/oddsportal_bet365.json，games[key].bet365 與 BetExplorer 摘要的 bet365 同形，
baseball_bet365_odds.js 用同一套規則轉成 provider 'oddsportal-bet365'。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

TW = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "oddsportal_bet365.json"
BE_SUMMARY = ROOT / "data" / "oddsportal_summary.json"
LEAGUE_URLS = {
    "mlb": "https://www.oddsportal.com/baseball/usa/mlb/",
    "npb": "https://www.oddsportal.com/baseball/japan/npb/",
    "kbo": "https://www.oddsportal.com/baseball/south-korea/kbo/",
    "cpbl": "https://www.oddsportal.com/baseball/taiwan/cpbl/",
}
BE_STALE_MIN = 90          # BetExplorer 的 bet365 超過這麼久沒更新＝視同沒抓到
KEEP_DAYS = 3              # 開賽超過幾天的紀錄清掉
HISTORY_CAP = 30
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def iso(dt: datetime) -> str:
    return dt.astimezone(TW).isoformat(timespec="seconds")


def parse_iso(text: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=TW)


def _team_zh():
    spec = importlib.util.spec_from_file_location("ops", str(ROOT / "oddsportal_scraper.py"))
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    return ops.team_zh


def event_id_of(url: str) -> str | None:
    hit = re.search(r"#([A-Za-z0-9]{6,12})/?$", str(url or ""))
    return hit.group(1) if hit else None


def game_key(league: str, start_tw: datetime, away: str, home: str, event_id: str) -> str:
    return "|".join([league, start_tw.strftime("%Y-%m-%d"), away, home, start_tw.strftime("%H:%M"), event_id])


# ── 純函式（有單元測試）──────────────────────────────────────────────
def schedule_from_events(league: str, events: list[dict], team_zh, now: datetime,
                         horizon_hours: float) -> tuple[list[dict], list[str]]:
    """聯盟頁 JSON-LD → 未開賽、視窗內的比賽。name 是「主隊 - 客隊」。"""
    games, unmapped = [], []
    for ev in events or []:
        start = parse_iso(ev.get("d"))
        event_id = event_id_of(ev.get("u"))
        parts = [x.strip() for x in str(ev.get("n") or "").split(" - ")]
        if not start or not event_id or len(parts) != 2:
            continue
        start_tw = start.astimezone(TW)
        if not (now + timedelta(minutes=2) < start_tw <= now + timedelta(hours=horizon_hours)):
            continue
        home_en, away_en = parts
        home, away = team_zh(home_en), team_zh(away_en)
        if not home or not away:
            unmapped.append(f"{league}:{away_en}@{home_en}")
            continue
        games.append({
            "eventId": event_id, "league": league,
            "date": start_tw.strftime("%Y-%m-%d"), "startTime": start_tw.strftime("%H:%M"),
            "startISO": iso(start_tw), "awayTeam": away, "homeTeam": home,
            "awayEn": away_en, "homeEn": home_en, "url": str(ev.get("u")).rstrip("/"),
        })
    return games, unmapped


def betexplorer_covered(summary: dict, now: datetime, stale_min: int = BE_STALE_MIN) -> tuple[set, set]:
    """BetExplorer 已經抓到（有方向、非雙向、且夠新）的場：回傳 (eventId 集合, (聯盟,日期,客,主) 集合)。"""
    ids, keys = set(), set()
    for game in (summary or {}).get("games", {}).values():
        b = (game or {}).get("bet365") or {}
        if b.get("side") not in ("home", "away") or b.get("ambiguous"):
            continue
        seen = parse_iso(b.get("observedAt") or game.get("observedAt"))
        if not seen or now - seen > timedelta(minutes=stale_min):
            continue
        if game.get("eventId"):
            ids.add(game["eventId"])
        keys.add((str(game.get("league", "")).lower(), game.get("date"), game.get("awayTeam"), game.get("homeTeam")))
    return ids, keys


def pick_targets(games: list[dict], covered_ids: set, covered_keys: set, max_visits: int) -> list[dict]:
    todo = [g for g in games if g["eventId"] not in covered_ids and
            (g["league"], g["date"], g["awayTeam"], g["homeTeam"]) not in covered_keys]
    todo.sort(key=lambda g: g["startISO"])
    return todo[:max_visits]


def _side(line: float) -> str:
    return "home" if line < 0 else "away"


def summarize_bet365(rows: list[dict], observed_at: str) -> dict | None:
    """OddsPortal 讓分頁 bet365 列 → 與 BetExplorer 摘要同形的 bet365 物件。
    rows: [{"line": "-1.5", "home": "2.20", "away": "1.63", "struck": bool}]"""
    parsed = []
    for row in rows or []:
        try:
            line = float(row.get("line"))
        except (TypeError, ValueError):
            continue
        if line == 0:
            continue

        def price(value):
            try:
                number = float(value)
            except (TypeError, ValueError):
                return None
            return number if number > 1 else None
        parsed.append({"line": line, "active": not row.get("struck"),
                       "home": price(row.get("home")), "away": price(row.get("away"))})
    active = [x for x in parsed if x["active"]]
    if not active:
        return None
    main = sorted(active, key=lambda x: abs(x["line"]))[0]
    side = _side(main["line"])
    sides_at_main = {_side(x["line"]) for x in active if abs(x["line"]) == abs(main["line"])}
    struck = [{"line": x["line"], "side": _side(x["line"]), "at": None} for x in parsed if not x["active"]]
    out = {
        "side": side, "line": abs(main["line"]), "at": observed_at,
        "flipEver": any(x["side"] != side for x in struck),
        "ambiguous": len(sides_at_main) > 1,
        "struck": struck,
        "observedAt": observed_at,
    }
    if main["home"] and main["away"]:
        out["odds"] = {"home": main["home"], "away": main["away"]}
    return out


def merge_bet365(old: dict | None, new: dict | None) -> dict | None:
    """跨輪合併：看過的對調證據只增不減；兩輪之間讓分方變了（舊線被直接撤掉、頁面沒留劃線）也記成對調。"""
    if not new:
        return old
    if not old:
        merged = dict(new)
        merged["history"] = [{"observedAt": new["observedAt"], "side": new["side"], "line": new["line"],
                              "odds": new.get("odds")}]
        return merged
    merged = dict(new)
    struck, seen = [], set()
    for row in list(old.get("struck") or []) + list(new.get("struck") or []):
        key = (row.get("line"), row.get("side"))
        if key in seen:
            continue
        seen.add(key)
        struck.append(dict(row))
    same_side = old.get("side") == new["side"]
    if not same_side and old.get("side") in ("home", "away") and not old.get("ambiguous") and not new.get("ambiguous"):
        line = old.get("line")
        signed = -abs(line) if old["side"] == "home" and line is not None else (abs(line) if line is not None else None)
        key = (signed, old["side"])
        if key not in seen:
            struck.append({"line": signed, "side": old["side"], "at": old.get("at"), "observed": True})
    merged["struck"] = struck
    merged["flipEver"] = bool(old.get("flipEver") or new.get("flipEver") or
                              any(row.get("side") != new["side"] for row in struck))
    merged["at"] = old.get("at") if same_side and old.get("at") else new["at"]   # 目前這一方「從何時開始」
    history = list(old.get("history") or [])
    last = history[-1] if history else {}
    snap = {"observedAt": new["observedAt"], "side": new["side"], "line": new["line"], "odds": new.get("odds")}
    if (last.get("side"), last.get("line"), last.get("odds")) != (snap["side"], snap["line"], snap["odds"]):
        history.append(snap)
    merged["history"] = history[-HISTORY_CAP:]
    return merged


def prune(games: dict, now: datetime) -> dict:
    out = {}
    for key, game in (games or {}).items():
        start = parse_iso((game or {}).get("startISO"))
        if start and now - start > timedelta(days=KEEP_DAYS):
            continue
        out[key] = game
    return out


def page_date_ok(page_text: str, start_tw: datetime, tolerance_min: int = 90) -> bool | None:
    """頁首「12 Oct 2026, 13:00」（瀏覽器時區＝台灣）要對得上預定開賽；找不到日期回 None。"""
    hit = re.search(r"(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}),?\s+(\d{1,2}):(\d{2})",
                    str(page_text or ""))
    if not hit:
        return None
    shown = datetime(int(hit.group(3)), MONTHS[hit.group(2)], int(hit.group(1)),
                     int(hit.group(4)), int(hit.group(5)), tzinfo=TW)
    return abs((shown - start_tw).total_seconds()) <= tolerance_min * 60


# ── 瀏覽器（scrapling 真 Chrome；一個瀏覽器跑完全部頁面）────────────────────
JS_LEAGUE = """
() => {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent) } catch(e){ return null } }).filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));
  return ld.filter(o => o && /Event/i.test(String(o['@type'])))
           .map(e => ({ n: e.name, d: e.startDate, u: e.url }));
}
"""
JS_INFO = """
() => {
  const h1 = document.querySelector('h1');
  const main = document.querySelector('main') || document.body;
  return { header: h1 ? h1.innerText.replace(/\\s+/g,' ').trim() : '', hash: location.hash,
           top: (main.innerText || '').slice(0, 600) };
}
"""
JS_CLICK_TAB = """
(label) => {
  const hit = [...document.querySelectorAll('div,a,li,button,span,p')]
    .filter(e => e.children.length === 0 && e.textContent.trim() === label);
  for (const e of hit) { let n = e;
    for (let i = 0; i < 4 && n; i++) { const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { n.click(); return 'ok'; } n = n.parentElement; } }
  return 'notfound';
}
"""
# 2026-10 版面：讓分頁每條線一個可點的表頭列「Asian Handicap -1.5」，點開才列出各莊家。
JS_AH_HEADS = """
() => [...document.querySelectorAll('tr')]
  .filter(tr => /^Asian Handicap [+-]?\\d/.test(tr.textContent.replace(/\\s+/g,' ').trim())).length
"""
# 每個表頭是否已展開（表頭之後、下一個表頭之前出現「Bookmakers」欄名列＝已展開）。
# 2026-10-12 實測：一次連點全部表頭偶爾有幾組沒展開 → bet365 列漏抓、被誤判成「沒有 bet365」。
JS_AH_STATE = """
() => { const st = []; let cur = -1;
  for (const tr of document.querySelectorAll('tr')) {
    const t = tr.textContent.replace(/\\s+/g,' ').trim();
    if (/^Asian Handicap [+-]?\\d/.test(t)) { cur += 1; st.push(false); continue; }
    if (cur >= 0 && /^Bookmakers/.test(t)) st[cur] = true;
  }
  return st; }
"""
JS_AH_CLICK = """
(i) => { const hs = [...document.querySelectorAll('tr')]
  .filter(tr => /^Asian Handicap [+-]?\\d/.test(tr.textContent.replace(/\\s+/g,' ').trim()));
  if (hs[i]) { hs[i].click(); return true; } return false; }
"""
JS_AH_HARVEST = """
() => {
  let line = null; const out = [];
  for (const tr of document.querySelectorAll('tr')) {
    const t = tr.textContent.replace(/\\s+/g,' ').trim();
    const m = t.match(/^Asian Handicap ([+-]?\\d+(?:\\.\\d+)?)/);
    if (m) { line = m[1]; continue; }
    const nm = tr.querySelector('a p, p');
    if (!nm || line === null) continue;
    const nums = [...tr.querySelectorAll('p,span,a,div')]
      .filter(e => !e.children.length && /^[+-]?\\d+(\\.\\d+)?$/.test(e.textContent.trim()));
    if (nums.length < 3) continue;
    const struck = nums.some(e => { let p = e;
      for (let i = 0; i < 4 && p; i++) { const cs = getComputedStyle(p);
        if (/line-through/.test(cs.textDecorationLine || '') || p.tagName === 'S' || p.tagName === 'DEL') return true;
        p = p.parentElement; }
      return false; });
    const vals = nums.map(e => e.textContent.trim());
    out.push({ book: nm.textContent.trim(), line, home: vals[1], away: vals[2], struck });
  }
  return out;
}
"""


def _dismiss_consent(page):
    try:
        button = page.query_selector("#onetrust-reject-all-handler")
        if button:
            button.click(timeout=4000)
            page.wait_for_timeout(800)
    except Exception:
        pass


def _goto(page, url: str, settle_ms: int):
    page.goto("about:blank")                                   # 同一 h2h 路徑只換 # 時強制整頁重載
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(settle_ms)
    _dismiss_consent(page)


def browse(leagues: list[str], plan_visits, log) -> tuple[dict, dict]:
    """一個瀏覽器：先讀各聯盟頁拿賽程，plan_visits(賽程) 決定要開哪些比賽頁，再逐場讀 bet365 讓分列。"""
    from scrapling.fetchers import StealthyFetcher
    hold: dict[str, Any] = {"events": {}, "visits": {}}

    def action(page):
        for lg in leagues:
            hold["events"][lg] = []
            for attempt in range(2):                     # 聯盟頁偶爾整頁沒有賽程資料（10/12 美職實例）→ 重讀一次
                try:
                    _goto(page, LEAGUE_URLS[lg], 4000 + 3000 * attempt)
                    for _ in range(3):
                        page.evaluate("() => window.scrollBy(0, 1600)")
                        page.wait_for_timeout(600)
                    hold["events"][lg] = page.evaluate(JS_LEAGUE) or []
                except Exception as exc:
                    log(f"WARN {lg} 聯盟頁讀取失敗：{str(exc)[:100]}")
                if hold["events"][lg]:
                    break
        for game in plan_visits(hold["events"]):
            visit: dict[str, Any] = {"rows": [], "err": None}
            hold["visits"][game["eventId"]] = visit
            try:
                _goto(page, game["url"].split("#")[0] + "#" + game["eventId"], 6500)
                info = page.evaluate(JS_INFO)
                header = (info.get("header") or "").lower()
                if game["homeEn"].lower() not in header or game["awayEn"].lower() not in header:
                    visit["err"] = "wrong-match:" + (info.get("header") or "")[:60]
                    continue
                if not str(info.get("hash") or "").startswith("#" + game["eventId"]):
                    visit["err"] = "event-switched:" + str(info.get("hash"))[:30]
                    continue
                date_ok = page_date_ok(info.get("top"), parse_iso(game["startISO"]))
                if date_ok is False:
                    visit["err"] = "date-mismatch"
                    continue
                if page.evaluate(JS_CLICK_TAB, "Asian Handicap") != "ok":
                    visit["err"] = "no-ah-tab"
                    continue
                heads, previous = 0, -1                     # 等表頭數穩定（最多約 12 秒）
                for _ in range(8):
                    page.wait_for_timeout(1500)
                    heads = int(page.evaluate(JS_AH_HEADS) or 0)
                    if heads and heads == previous:
                        break
                    previous = heads
                closed = []
                for _ in range(3):                           # 只點還沒展開的（點已展開的會收起來）
                    closed = [i for i, ok in enumerate(page.evaluate(JS_AH_STATE) or []) if not ok]
                    if not closed:
                        break
                    for i in closed:
                        page.evaluate(JS_AH_CLICK, i)
                        page.wait_for_timeout(500)
                    page.wait_for_timeout(2000)
                closed = [i for i, ok in enumerate(page.evaluate(JS_AH_STATE) or []) if not ok]
                visit["heads"] = heads
                visit["closed"] = len(closed)
                visit["rows"] = page.evaluate(JS_AH_HARVEST) or []
            except Exception as exc:
                visit["err"] = str(exc)[:160]
        return page

    first = LEAGUE_URLS[leagues[0]]
    StealthyFetcher.fetch(first, page_action=action, headless=True, real_chrome=True, network_idle=True,
                          locale="en-US", timezone_id="Asia/Taipei", timeout=240000)
    return hold["events"], hold["visits"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--leagues", default="mlb,npb,kbo,cpbl")
    parser.add_argument("--horizon-hours", type=float, default=36)
    parser.add_argument("--max-visits", type=int, default=10)
    parser.add_argument("--be-summary", default=str(BE_SUMMARY))
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    leagues = [x.strip() for x in args.leagues.split(",") if x.strip() in LEAGUE_URLS]
    now = datetime.now(TW)
    observed_at = iso(now)
    team_zh = _team_zh()
    try:
        be_summary = json.loads(Path(args.be_summary).read_text(encoding="utf-8"))
    except Exception:
        be_summary = {"games": {}}
    covered_ids, covered_keys = betexplorer_covered(be_summary, now)
    try:
        previous = json.loads(Path(args.out).read_text(encoding="utf-8"))
    except Exception:
        previous = {"games": {}}

    plan: dict[str, Any] = {"games": [], "targets": [], "unmapped": []}

    def plan_visits(events_by_league):
        for lg in leagues:
            games, unmapped = schedule_from_events(lg, events_by_league.get(lg), team_zh, now, args.horizon_hours)
            plan["games"].extend(games)
            plan["unmapped"].extend(unmapped)
        plan["targets"] = pick_targets(plan["games"], covered_ids, covered_keys, args.max_visits)
        return plan["targets"]

    _, visits = browse(leagues, plan_visits, log)

    games = dict(previous.get("games") or {})
    captured, no_bet365, failed, errors = 0, 0, 0, []
    for game in plan["targets"]:
        visit = visits.get(game["eventId"]) or {"err": "not-visited", "rows": []}
        start_tw = parse_iso(game["startISO"])
        key = game_key(game["league"], start_tw, game["awayTeam"], game["homeTeam"], game["eventId"])
        if visit.get("err"):
            failed += 1
            errors.append(f"{game['awayTeam']}@{game['homeTeam']}: {visit['err']}")
            continue
        rows = [r for r in visit.get("rows") or [] if "bet365" in str(r.get("book", "")).lower()]
        if visit.get("closed"):
            # 有表頭沒展開＝這頁沒讀完整：bet365 列（或它的劃線舊線）可能就在沒展開的那組，不能下結論
            failed += 1
            errors.append(f"{game['awayTeam']}@{game['homeTeam']}: {visit['closed']}/{visit.get('heads')} 組讓分沒展開")
            continue
        if not visit.get("rows"):
            # 一家莊家列都讀不到＝讓分盤還沒開，或 OddsPortal 又改版（8 月版的讀法 10 月已失效）。
            # 不能報成「沒有 bet365」，否則改版後每場都靜默變空。
            failed += 1
            errors.append(f"{game['awayTeam']}@{game['homeTeam']}: 讀不到任何莊家讓分列（{visit.get('heads', 0)} 組表頭；未開盤或版面改了）")
            continue
        summary = summarize_bet365(rows, observed_at)
        old = (games.get(key) or {}).get("bet365")
        entry = {k: game[k] for k in ("eventId", "league", "date", "startTime", "startISO", "awayTeam", "homeTeam", "url")}
        entry["observedAt"] = observed_at
        entry["bookmakerRows"] = len(visit.get("rows") or [])
        entry["bet365"] = merge_bet365(old, summary)
        games[key] = entry
        if summary:
            captured += 1
            flag = "⚠曾對調" if entry["bet365"].get("flipEver") else ""
            log(f"  {game['league']} {game['date']} {game['startTime']} {game['awayTeam']}@{game['homeTeam']}"
                f" bet365 {summary['side']}讓{summary['line']} {flag}")
        else:
            no_bet365 += 1
            log(f"  {game['league']} {game['date']} {game['startTime']} {game['awayTeam']}@{game['homeTeam']}"
                f" OddsPortal 也沒有 bet365 讓分列（莊家列 {entry['bookmakerRows']}）")

    health = {
        "discovered": len(plan["games"]), "coveredByBetExplorer": len(plan["games"]) - len(
            [g for g in plan["games"] if g["eventId"] not in covered_ids and
             (g["league"], g["date"], g["awayTeam"], g["homeTeam"]) not in covered_keys]),
        "targets": len(plan["targets"]), "captured": captured, "noBet365": no_bet365,
        "failed": failed, "errors": errors[:8], "unmapped": plan["unmapped"][:8],
    }
    output = {
        "version": 1, "source": "OddsPortal", "bookmaker": "bet365",
        "updatedAt": observed_at, "health": health, "games": prune(games, now),
    }
    print(json.dumps(health, ensure_ascii=False))
    if args.dry_run:
        return 0
    # 直接寫（不留 .tmp）：備援 clone 遇到不認得的未追蹤檔會整個拒跑；半寫壞檔由 workspace 自癒丟棄重來
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0 if failed == 0 or captured or no_bet365 else 1


if __name__ == "__main__":
    raise SystemExit(main())
