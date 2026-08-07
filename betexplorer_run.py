"""BetExplorer 每日抓取（初盤／收盤／讓分對調警示）→ 併入 data/oddsportal_summary.json

用法：
  python betexplorer_run.py                      # 今天＋明天上架的四聯盟
  python betexplorer_run.py --leagues npb,cpbl   # 指定聯盟
  python betexplorer_run.py --dry-run            # 只印不寫檔

輸出沿用既有 summary 結構（board 端不必改）：
  markets.ml/hd/ou 各有 open（初盤）與 active（現行）；已開賽的場另存 close。
  stakeSwap 只放警示，永不勾任何狀態（2026-08-05 使用者鐵則）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import betexplorer as BE
import official_times as OT

TW = BE.TW
HD_CLOSE_LEAD_MIN = 150       # 讓分/大小的收盤切點＝開賽前 150 分（避開 Stake 擴盤；使用者 8/5 拍板）


def _team_zh():
    import importlib.util
    spec = importlib.util.spec_from_file_location("ops", str(Path(__file__).with_name("oddsportal_scraper.py")))
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    return ops.team_zh


def _hist_dt(text: str, year_hint: int) -> datetime | None:
    """變動史時間 '06.08. 21:15' → 站方 naive datetime（年份用比賽年份補）。"""
    hit = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.?\s+(\d{1,2}):(\d{2})", str(text or "").strip())
    if not hit:
        return None
    day, month, hour, minute = (int(hit.group(i)) for i in (1, 2, 3, 4))
    if not (1 <= month <= 12 and 1 <= day <= 31 and 0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return datetime(year_hint, month, day, hour, minute)


def _pick(history, cell, offset, year_hint, cutoff_tw=None):
    """從變動史挑一筆：cutoff 為 None → 最舊（初盤）；否則 → cutoff 之前最後一筆（收盤）。
    回傳 (odd, iso_tw)。"""
    rows = []
    for item in (history or []):
        stamp = _hist_dt(item.get("date"), year_hint)
        if stamp is None:
            continue
        tw = (stamp + timedelta(hours=offset)).replace(tzinfo=TW)
        try:
            rows.append((tw, float(item.get("odd"))))
        except (TypeError, ValueError):
            continue
    if not rows:
        try:
            value = float(cell.get("data-odd"))
        except (TypeError, ValueError):
            return None, None
        return value, None
    rows.sort()
    if cutoff_tw is None:
        stamp, odd = rows[0]
    else:
        before = [r for r in rows if r[0] <= cutoff_tw]
        if not before:
            return None, None
        stamp, odd = before[-1]
    return odd, stamp.isoformat(timespec="seconds")


def _active_line(lines):
    """現行盤口：優先取仍在架上的；同側多條取絕對值最小（主盤）。"""
    live = [x for x in lines if x.get("active") and x.get("line") is not None]
    if not live:
        live = [x for x in lines if x.get("line") is not None]
    if not live:
        return None
    return sorted(live, key=lambda x: abs(x["line"]))[0]


def collect(game, offset, now_tw):
    """回傳 summary 用的一筆 game 物件。"""
    start_tw = (game["siteStart"] + timedelta(hours=offset)).replace(tzinfo=TW)
    year_hint = start_tw.year
    started = now_tw >= start_tw
    markets: dict[str, dict] = {}

    ha = BE.stake_lines(game["matchId"], "ha")
    if ha:
        home_cell, away_cell = ha[0]["first"], ha[0]["second"]
        hh, ha_at = _pick(BE.archive_history(home_cell), home_cell, offset, year_hint)
        aa, _ = _pick(BE.archive_history(away_cell), away_cell, offset, year_hint)
        block = {"open": {"at": ha_at, "home": hh, "away": aa}}
        try:
            block["active"] = {"at": now_tw.isoformat(timespec="seconds"),
                               "home": float(home_cell.get("data-odd")),
                               "away": float(away_cell.get("data-odd"))}
        except (TypeError, ValueError):
            pass
        if started:
            ch, at_h = _pick(BE.archive_history(home_cell), home_cell, offset, year_hint, start_tw)
            ca, _ = _pick(BE.archive_history(away_cell), away_cell, offset, year_hint, start_tw)
            if ch is not None and ca is not None:
                block["close"] = {"at": at_h, "home": ch, "away": ca, "final": True}
        markets["ml"] = block

    ah = BE.stake_lines(game["matchId"], "ah")
    swap = BE.handicap_swap(ah)
    main = _active_line(ah)
    if main:
        first, second = main["first"], main["second"]
        line = abs(main["line"])
        favorite = "home" if main["line"] < 0 else "away"
        oh, at_h = _pick(BE.archive_history(first), first, offset, year_hint)
        oa, _ = _pick(BE.archive_history(second), second, offset, year_hint)
        block = {"open": {"at": at_h, "home": oh, "away": oa, "line": line, "favorite": favorite}}
        try:
            block["active"] = {"at": now_tw.isoformat(timespec="seconds"),
                               "home": float(first.get("data-odd")), "away": float(second.get("data-odd")),
                               "line": line, "favorite": favorite}
        except (TypeError, ValueError):
            pass
        cutoff = start_tw - timedelta(minutes=HD_CLOSE_LEAD_MIN)
        if now_tw >= cutoff:
            ch, cat = _pick(BE.archive_history(first), first, offset, year_hint, cutoff)
            ca, _ = _pick(BE.archive_history(second), second, offset, year_hint, cutoff)
            if ch is not None and ca is not None:
                block["close"] = {"at": cat, "home": ch, "away": ca, "line": line,
                                  "favorite": favorite, "final": started}
        markets["hd"] = block

    ou = BE.stake_lines(game["matchId"], "ou")
    main_ou = _active_line(ou)
    if main_ou:
        over_cell, under_cell = main_ou["first"], main_ou["second"]
        oo, at_o = _pick(BE.archive_history(over_cell), over_cell, offset, year_hint)
        uu, _ = _pick(BE.archive_history(under_cell), under_cell, offset, year_hint)
        block = {"open": {"at": at_o, "over": oo, "under": uu, "line": main_ou["line"]}}
        try:
            block["active"] = {"at": now_tw.isoformat(timespec="seconds"),
                               "over": float(over_cell.get("data-odd")),
                               "under": float(under_cell.get("data-odd")), "line": main_ou["line"]}
        except (TypeError, ValueError):
            pass
        cutoff = start_tw - timedelta(minutes=HD_CLOSE_LEAD_MIN)
        if now_tw >= cutoff:
            co, cat = _pick(BE.archive_history(over_cell), over_cell, offset, year_hint, cutoff)
            cu, _ = _pick(BE.archive_history(under_cell), under_cell, offset, year_hint, cutoff)
            if co is not None and cu is not None:
                block["close"] = {"at": cat, "over": co, "under": cu,
                                  "line": main_ou["line"], "final": started}
        markets["ou"] = block

    return {
        "eventId": game["matchId"], "league": game["league"],
        "date": start_tw.date().isoformat(), "startTime": start_tw.strftime("%H:%M"),
        "startISO": start_tw.isoformat(timespec="seconds"),
        "awayTeam": game["awayZh"], "homeTeam": game["homeZh"],
        "sourceUrl": game["url"], "observedAt": now_tw.isoformat(timespec="seconds"),
        "source": "BetExplorer",
        "markets": markets,
        "stakeSwap": {"ever": swap["ever"], "activeSide": swap["activeSide"],
                      "struckSide": swap["struckSide"], "lines": swap["lines"]},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--leagues", default="mlb,npb,kbo,cpbl")
    parser.add_argument("--summary", default="data/oddsportal_summary.json")
    parser.add_argument("--schedule", default="data/pregame_data.json")
    parser.add_argument("--horizon-hours", type=float, default=36.0,
                        help="賽程頁只取這個時數內的場次（預設 36 小時＝今天＋明天）")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    leagues = [x.strip() for x in args.leagues.split(",") if x.strip()]
    team_zh = _team_zh()
    now_tw = datetime.now(TW)

    # 時差是「全站屬性」，用所有聯盟一起推（只挑一個聯盟時常常湊不到 3 場可比對）
    all_games = BE.discover_upcoming(team_zh)
    games = [g for g in all_games if g["league"] in leagues]

    schedule = json.loads(Path(args.schedule).read_text(encoding="utf-8"))
    # 基準＝我們的賽程檔 ∪ 官方 statsapi。深夜時我們的檔還沒有隔日場次，官方已經有，
    # 少了這一段就會因「可比對場次不足」整輪中止（2026-08-07 23:3x 實例）。
    reference = list(schedule)
    for date in sorted({(g["siteStart"]).date().isoformat() for g in all_games} |
                       {now_tw.date().isoformat(), (now_tw + timedelta(days=1)).date().isoformat()}):
        try:
            for (away, home), hhmm in OT.mlb_start_map(date, team_zh).items():
                reference.append({"awayTeam": away, "homeTeam": home, "time": hhmm})
        except Exception:
            pass
    offset = BE.detect_offset_hours(reference, all_games)  # 第二重：對不上就丟例外，不猜
    print(f"INFO 首頁發現 {len(games)} 場、站方時差 {offset:+.1f}h", file=sys.stderr)

    # 2026-08-07 使用者反映「8/8 美職初盤沒填」：/baseball/ 首頁只列少數場次
    # （當時 8/8 美職只有 3 場），完整隔日賽程要讀各聯盟的 fixtures 頁。
    # 時差先由首頁的絕對 data-dt 推出來，再用它換算 fixtures 頁的 Today/Tomorrow。
    site_today = (now_tw - timedelta(hours=offset)).date()
    seen = {g["matchId"] for g in games}
    horizon = now_tw + timedelta(hours=float(args.horizon_hours))
    for league in leagues:
        try:
            for game in BE.discover_fixtures(league, team_zh, site_today):
                if game["matchId"] in seen:
                    continue
                start = (game["siteStart"] + timedelta(hours=offset)).replace(tzinfo=TW)
                if not (now_tw - timedelta(hours=6) <= start <= horizon):
                    continue                              # 只要近期的，不抓整季賽程
                seen.add(game["matchId"])
                games.append(game)
        except Exception as exc:
            print(f"WARN {league} 賽程頁讀取失敗（不影響其他聯盟）：{str(exc)[:80]}", file=sys.stderr)
    print(f"INFO 併入賽程頁後共 {len(games)} 場", file=sys.stderr)

    # 第三重（2026-08-07 使用者要求）：換算成台灣時間後，再跟官方賽事網對照。
    # 官方說不一致就中止本輪——寧可沒資料，也不要寫錯日期/時間進資料庫。
    checks = []
    for league in sorted({g["league"] for g in games}):
        same_day = [g for g in games if g["league"] == league]
        by_date: dict[str, list[str]] = {}
        for g in same_day:
            start = (g["siteStart"] + timedelta(hours=offset)).replace(tzinfo=TW)
            by_date.setdefault(start.date().isoformat(), []).append(start.strftime("%H:%M"))
        for date, times in by_date.items():
            result = OT.cross_check(league, date, times)
            checks.append((league, date, result))
            mark = {True: "三重一致", False: "不一致", None: "僅雙重（無官方來源）"}[result["ok"]]
            print(f"INFO 官方對照 {league} {date}: {mark}"
                  f"｜我們 {sorted(set(result['ours']))}｜官方 {sorted(set(result['official'] or []))[:8]}",
                  file=sys.stderr)
    mismatched = [f"{lg} {d}" for lg, d, r in checks if r["ok"] is False]
    if mismatched:
        raise SystemExit(f"ERROR 官方時間對照不一致（{', '.join(mismatched)}），本輪中止不寫檔")

    collected, failed = [], []
    for game in games:
        try:
            entry = collect(game, offset, now_tw)
            if not any((entry["markets"].get(k) or {}).get("open") or (entry["markets"].get(k) or {}).get("active")
                       for k in ("ml", "hd", "ou")):
                continue          # Stake 還沒開盤（常見於後天的場）→ 不寫空殼進資料庫
            collected.append(entry)
        except Exception as exc:
            failed.append(f"{game['awayZh']}@{game['homeZh']}: {str(exc)[:90]}")

    summary_path = Path(args.summary)
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    added = updated = 0
    for entry in collected:
        key = "|".join([entry["league"], entry["date"], entry["awayTeam"],
                        entry["homeTeam"], entry["startTime"], entry["eventId"]])
        if key in summary["games"]:
            old = summary["games"][key]
            for market, block in entry["markets"].items():
                slot = old.setdefault("markets", {}).setdefault(market, {})
                for name, value in block.items():
                    if name == "open" and slot.get("open"):      # 初盤只寫一次，永不覆蓋
                        continue
                    slot[name] = value
            old["stakeSwap"] = entry["stakeSwap"]
            old["observedAt"] = entry["observedAt"]
            updated += 1
        else:
            summary["games"][key] = entry
            added += 1
    summary["updatedAt"] = now_tw.isoformat(timespec="seconds")

    health = {"discovered": len(games), "succeeded": len(collected),
              "failed": len(failed), "added": added, "updated": updated, "errors": failed}
    if args.dry_run:
        for entry in collected:
            ml = (entry["markets"].get("ml") or {}).get("open") or {}
            hd = (entry["markets"].get("hd") or {}).get("open") or {}
            ou = (entry["markets"].get("ou") or {}).get("open") or {}
            mark = " ⚠曾對調" if entry["stakeSwap"]["ever"] else ""
            print(f"  {entry['league']:4s} {entry['date']} {entry['startTime']} "
                  f"{entry['awayTeam']}@{entry['homeTeam']}  "
                  f"ml {ml.get('away')}/{ml.get('home')}  "
                  f"hd {hd.get('line')}{hd.get('favorite','')} {hd.get('away')}/{hd.get('home')}  "
                  f"ou {ou.get('line')} {ou.get('over')}/{ou.get('under')}{mark}")
    else:
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(health, ensure_ascii=False))
    return 0 if collected else 1


if __name__ == "__main__":
    raise SystemExit(main())
