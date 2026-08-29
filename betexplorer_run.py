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
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import betexplorer as BE
import official_times as OT

TW = BE.TW
# 2026-08-13 使用者拍板：讓分/大小收盤＝【開賽前最後一組】（與獨贏同義）。
# 擴盤造成的多線歧義不靠時間切點解決，改「照卡片上的讓分線取對應賠率」
# （_active_line 本來就挑絕對值最小＝卡片 ±1.5 主盤）。舊的 T−150 規則作廢。
HD_CLOSE_LEAD_MIN = 0


def game_start_tw(game, offset):
    """取得比賽台灣時間；若已用排盤賽程校正，優先採用校正值。"""
    corrected = game.get("_startTw")
    if isinstance(corrected, datetime):
        return corrected
    return (game["siteStart"] + timedelta(hours=offset)).replace(tzinfo=TW)


def reconcile_scheduled_starts(games, offset, schedule):
    """同聯盟、日期、對戰組合數量一致時，按場次順序套用排盤賽程時間。

    這能保留同隊雙重賽：例如來源列 04:05／13:05，排盤列 04:05／10:05，
    第二場會校正為 10:05；若場數對不上則不猜，交給官方時間逐場隔離。
    """
    scheduled: dict[tuple[str, str, str, str], list[datetime]] = {}
    for row in schedule or []:
        league = str(row.get("league") or "").lower()
        date = str(row.get("date") or "")
        text = str(row.get("time") or row.get("gameTime") or "")
        hit = re.search(r"(\d{1,2}):(\d{2})", text)
        away, home = row.get("awayTeam"), row.get("homeTeam")
        if not league or not away or not home or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or not hit:
            continue
        hour, minute = int(hit.group(1)), int(hit.group(2))
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            continue
        start = datetime.fromisoformat(f"{date}T{hour:02d}:{minute:02d}").replace(tzinfo=TW)
        scheduled.setdefault((league, date, away, home), []).append(start)

    discovered: dict[tuple[str, str, str, str], list[dict]] = {}
    for game in games:
        start = game_start_tw(game, offset)
        key = (str(game.get("league") or "").lower(), start.date().isoformat(),
               game.get("awayZh"), game.get("homeZh"))
        discovered.setdefault(key, []).append(game)

    corrections = []
    for key, group in discovered.items():
        targets = scheduled.get(key) or []
        if len(group) != len(targets):
            continue
        ordered_games = sorted(group, key=lambda game: game_start_tw(game, offset))
        for game, target in zip(ordered_games, sorted(targets)):
            current = game_start_tw(game, offset)
            if current == target:
                continue
            game["_startTw"] = target
            corrections.append({
                "matchId": game.get("matchId"),
                "from": current.strftime("%H:%M"),
                "to": target.strftime("%H:%M"),
            })
    return corrections


def partition_official_times(games, offset, official):
    """按官方時間的場次數逐一放行；無法配對者單場隔離，不拖垮整批。"""
    if official is None or not official:
        return list(games), []
    remaining = Counter(official)
    accepted, rejected = [], []
    for game in games:
        hhmm = game_start_tw(game, offset).strftime("%H:%M")
        if remaining[hhmm] > 0:
            remaining[hhmm] -= 1
            accepted.append(game)
        else:
            rejected.append(game)
    return accepted, rejected


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
    """從完整賠率序列挑一筆：cutoff 為 None → 最舊（初盤）；否則 → cutoff 前最後一筆（收盤）。

    2026-08-14 v3（與收割器同步修正）：archive-odds 端點只回「目前值之前的變動」，
    真正的最後一組賠率在【儲存格 data-odd＋data-created】（開賽後凍結）。
    只取變動史尾巴＝拿到開賽前好幾小時的價（與使用者手填收盤一致率僅 10%）。
    完整序列 = 變動史 ＋ 儲存格現值；抽驗 25 場 v3 與使用者手填 20 場完全一致。"""
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
    rows.sort()
    try:
        cell_val = float(cell.get("data-odd"))
    except (TypeError, ValueError):
        cell_val = None
    if cell_val is not None:
        cell_at = None
        raw = cell.get("data-created")
        if raw:
            try:
                cell_at = (BE.parse_data_dt(raw) + timedelta(hours=offset)).replace(tzinfo=TW)
            except ValueError:
                cell_at = None
        if cell_at is not None and (not rows or cell_at >= rows[-1][0]):
            rows.append((cell_at, cell_val))            # 序列最新一筆＝儲存格現值
    if not rows:
        if cell_val is None:
            return None, None
        return cell_val, None
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


def _cell_close(cell, offset, start_tw):
    """收盤＝儲存格現值（BetExplorer 開賽即凍結）。時戳晚於開賽視為異常回 None。
    2026-08-14 v3：變動史端點只含早期變動，別再從那裡拿收盤。"""
    try:
        val = float(cell.get("data-odd"))
    except (TypeError, ValueError):
        return None, None
    at = None
    raw = cell.get("data-created")
    if raw:
        try:
            at = (BE.parse_data_dt(raw) + timedelta(hours=offset)).replace(tzinfo=TW)
        except ValueError:
            at = None
    if at is not None and at > start_tw + timedelta(minutes=5):
        return None, None
    return val, (at.isoformat(timespec="seconds") if at else None)


def collect(game, offset, now_tw):
    """回傳 summary 用的一筆 game 物件。"""
    start_tw = game_start_tw(game, offset)
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
            ch, at_h = _cell_close(home_cell, offset, start_tw)
            ca, _ = _cell_close(away_cell, offset, start_tw)
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
        if started:
            ch, cat = _cell_close(first, offset, start_tw)
            ca, _ = _cell_close(second, offset, start_tw)
            if ch is not None and ca is not None:
                block["close"] = {"at": cat, "home": ch, "away": ca, "line": line,
                                  "favorite": favorite, "final": True}
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
        if started:
            co, cat = _cell_close(over_cell, offset, start_tw)
            cu, _ = _cell_close(under_cell, offset, start_tw)
            if co is not None and cu is not None:
                block["close"] = {"at": cat, "over": co, "under": cu,
                                  "line": main_ou["line"], "final": True}
        markets["ou"] = block

    bet365 = None
    try:
        bet365 = BE.bet365_summary(
            BE.bet365_lines(game["matchId"]), offset,
            observed_at=now_tw.isoformat(timespec="seconds"),
        )
    except Exception:
        bet365 = None                      # bet365 缺列不影響其他市場（Titan 作複查備援）

    return {
        "bet365": bet365,
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

    corrections = reconcile_scheduled_starts(games, offset, schedule)
    for item in corrections:
        print(f"INFO 排盤時間校正 {item['matchId']}: {item['from']} → {item['to']}", file=sys.stderr)

    # 第三重（2026-08-07 使用者要求）：換算成台灣時間後，再跟官方賽事網對照。
    # 官方不一致的場次只隔離該場；其餘已核對成功的場次照常寫入。
    rejected_games = []
    for league in sorted({g["league"] for g in games}):
        same_day = [g for g in games if g["league"] == league]
        by_date: dict[str, list[dict]] = {}
        for g in same_day:
            start = game_start_tw(g, offset)
            by_date.setdefault(start.date().isoformat(), []).append(g)
        for date, day_games in by_date.items():
            times = [game_start_tw(g, offset).strftime("%H:%M") for g in day_games]
            result = OT.cross_check(league, date, times)
            mark = {True: "三重一致", False: "不一致", None: "僅雙重（無官方來源）"}[result["ok"]]
            print(f"INFO 官方對照 {league} {date}: {mark}"
                  f"｜我們 {sorted(set(result['ours']))}｜官方 {sorted(set(result['official'] or []))[:8]}",
                  file=sys.stderr)
            if result["ok"] is False:
                _, rejected = partition_official_times(day_games, offset, result["official"])
                rejected_games.extend(rejected)
    if rejected_games:
        rejected_ids = {g["matchId"] for g in rejected_games}
        games = [g for g in games if g["matchId"] not in rejected_ids]
        for game in rejected_games:
            start = game_start_tw(game, offset)
            print(f"WARN 官方時間無法配對，僅隔離此場：{game['awayZh']}@{game['homeZh']} "
                  f"{start.strftime('%Y-%m-%d %H:%M')} ({game['matchId']})", file=sys.stderr)

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
            if entry.get("bet365") is not None:
                old["bet365"] = entry["bet365"]      # 警示條 bet365 軸（2026-08-15 拍板 BE 為主）
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
