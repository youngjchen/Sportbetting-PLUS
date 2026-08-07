"""BetExplorer 歷史收割（4/1 至今，四聯盟）→ data/oddsportal_archive/YYYY-MM.json

2026-08-07 使用者拍板從 OddsPortal 搬過來。實測差距：
  探索：結果頁 ?month=YYYY-MM 一次請求 ~3 秒 ~400 場（OddsPortal 要 Playwright 逐頁真點擊）
  單場：三市場＋初盤 5 次 HTTP ~8 秒（OddsPortal ~60 秒）→ 約 7 倍
  一致性：兩站 eventId 共用（7 月 350 場中 347 場相同）、初盤抽驗 5/5 完全相同

日期不猜：月份來自網址參數，列上 DD.MM. 必須同月，否則整列拒收（見 betexplorer.parse_result_date）。
狀態檔：data/betexplorer_harvest_state.json（每聯盟記已完成的月份，可中斷續跑）。

用法：
  python betexplorer_harvest.py --month 2026-07 --league mlb
  python betexplorer_harvest.py --max-games 200          # 自動挑未完成的月份接著跑
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import betexplorer as BE

TW = BE.TW
HD_CLOSE_LEAD_MIN = 150
LEAGUES = ("mlb", "npb", "kbo", "cpbl")
SEASON_MONTHS = ("2026-04", "2026-05", "2026-06", "2026-07", "2026-08")


def _team_zh():
    import importlib.util
    spec = importlib.util.spec_from_file_location("ops", str(Path(__file__).with_name("oddsportal_scraper.py")))
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    return ops.team_zh


def _hist_rows(history, year_hint, offset):
    """變動史 → [(台灣時間, 賠率)]，由舊到新。"""
    rows = []
    for item in (history or []):
        hit = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.?\s+(\d{1,2}):(\d{2})", str(item.get("date") or "").strip())
        if not hit:
            continue
        day, month, hour, minute = (int(hit.group(i)) for i in (1, 2, 3, 4))
        if not (1 <= month <= 12 and 1 <= day <= 31 and 0 <= hour <= 23 and 0 <= minute <= 59):
            continue
        try:
            stamp = datetime(year_hint, month, day, hour, minute) + timedelta(hours=offset)
            rows.append((stamp.replace(tzinfo=TW), float(item.get("odd"))))
        except (TypeError, ValueError):
            continue
    rows.sort()
    return rows


def _open_close(cell, year_hint, offset, cutoff_tw):
    """初盤＝變動史最舊一筆；收盤＝cutoff 前最後一筆。

    2026-08-07 修正：查不到變動史時（該列已下架且無 data-oid），我們手上只有
    「最後一筆賠率＋它的建立時間」。那是【收盤】不是初盤——舊版把它當初盤記錄，
    等於把收盤數字寫進初盤欄位污染走向分析。改成記成收盤、初盤留空。"""
    rows = _hist_rows(BE.archive_history(cell), year_hint, offset)
    if not rows:
        try:
            value = float(cell.get("data-odd"))
        except (TypeError, ValueError):
            return (None, None), (None, None)
        stamp = None
        raw = cell.get("data-created")
        if raw:
            try:
                stamp = (BE.parse_data_dt(raw) + timedelta(hours=offset)).replace(tzinfo=TW)
            except ValueError:
                stamp = None
        if stamp is not None and stamp <= cutoff_tw:
            return (None, None), (value, stamp.isoformat(timespec="seconds"))
        return (None, None), (None, None)
    open_at, open_odd = rows[0]
    before = [r for r in rows if r[0] <= cutoff_tw]
    if before:
        close_at, close_odd = before[-1]
        return (open_odd, open_at.isoformat(timespec="seconds")), (close_odd, close_at.isoformat(timespec="seconds"))
    return (open_odd, open_at.isoformat(timespec="seconds")), (None, None)


def _start_tw(row: dict, offset: float) -> datetime:
    """歷史場的開賽時刻：從【該場自己的網址】抓站方時間再換算。
    2026-08-07 實測教訓：原本用捏造路徑 /baseball/x/x/{id}/ 去抓，撈到別場的 data-dt，
    中職 18:35 的比賽被寫成 02:00、收盤時戳還晚於開賽 → 收盤切點全錯。
    防火牆：換算後若不落在該列日期當天，一律退回當日 23:59（保守切點＝當天最後一刻）。"""
    date = row["date"]
    year, month, day = (int(x) for x in date.split("-"))
    fallback = datetime(year, month, day, 23, 59, tzinfo=TW)
    try:
        page = BE._open(row["url"])
    except Exception:
        return fallback
    for raw in re.findall(r'data-dt="(\d{1,2},\d{1,2},\d{4},\d{1,2},\d{2})"', page):
        try:
            start = (BE.parse_data_dt(raw) + timedelta(hours=offset)).replace(tzinfo=TW)
        except ValueError:
            continue
        if start.date().isoformat() == date:          # 必須是這一天，否則不是這場的時間
            return start
    return fallback


def _pick_line(lines, prefer_abs=None):
    """挑主盤。2026-08-07 實測教訓：原本只按「線值接近目標」挑，會挑到沒有 data-oid 的那條，
    查不到變動史 ⇒ 整場沒有收盤（大小分收盤覆蓋率只剩 11%）。
    優先序：仍在架上 → 查得到變動史(primary) → 線值最接近目標（大小分則取賠率最平衡的）。"""
    cand = [x for x in lines if x.get("line") is not None]
    if not cand:
        return None

    def key(item):
        not_active = 0 if item.get("active") else 1
        no_history = 0 if item.get("primary") else 1
        if prefer_abs is not None:
            dist = abs(abs(item["line"]) - prefer_abs)
        else:
            try:
                first = float(item["first"].get("data-odd"))
                second = float(item["second"].get("data-odd"))
                dist = abs(first - second)          # 賠率最接近的＝市場主盤
            except (TypeError, ValueError):
                dist = 99.0
        return (not_active, no_history, dist)

    return sorted(cand, key=key)[0]


def harvest_game(row: dict, offset: float) -> dict:
    match_id, date = row["matchId"], row["date"]
    start_tw = _start_tw(row, offset)
    year_hint = start_tw.year
    markets: dict[str, dict] = {}

    ha = BE.stake_lines(match_id, "ha")
    if ha:
        (oh, oh_at), (ch, ch_at) = _open_close(ha[0]["first"], year_hint, offset, start_tw)
        (oa, _), (ca, _) = _open_close(ha[0]["second"], year_hint, offset, start_tw)
        block = {}
        if oh is not None or oa is not None:
            block["open"] = {"at": oh_at, "home": oh, "away": oa}
        if ch is not None and ca is not None:
            block["close"] = {"at": ch_at, "home": ch, "away": ca, "final": True}
        markets["ml"] = block

    cutoff = start_tw - timedelta(minutes=HD_CLOSE_LEAD_MIN)
    ah = BE.stake_lines(match_id, "ah")
    swap = BE.handicap_swap(ah)
    main = _pick_line(ah, prefer_abs=1.5)          # 棒球卡片盤口＝±1.5（使用者拍板）
    if main:
        (oh, oh_at), (ch, ch_at) = _open_close(main["first"], year_hint, offset, cutoff)
        (oa, _), (ca, _) = _open_close(main["second"], year_hint, offset, cutoff)
        favorite = "home" if main["line"] < 0 else "away"
        block = {}
        if oh is not None or oa is not None:
            block["open"] = {"at": oh_at, "home": oh, "away": oa,
                             "line": abs(main["line"]), "favorite": favorite}
        if ch is not None and ca is not None:
            block["close"] = {"at": ch_at, "home": ch, "away": ca,
                              "line": abs(main["line"]), "favorite": favorite, "final": True}
        markets["hd"] = block

    ou = BE.stake_lines(match_id, "ou")
    main_ou = _pick_line(ou)                       # 大小分主盤＝賠率最平衡的那條
    if main_ou:
        (oo, oo_at), (co, co_at) = _open_close(main_ou["first"], year_hint, offset, cutoff)
        (uu, _), (cu, _) = _open_close(main_ou["second"], year_hint, offset, cutoff)
        block = {}
        if oo is not None or uu is not None:
            block["open"] = {"at": oo_at, "over": oo, "under": uu, "line": main_ou["line"]}
        if co is not None and cu is not None:
            block["close"] = {"at": co_at, "over": co, "under": cu,
                              "line": main_ou["line"], "final": True}
        markets["ou"] = block

    return {
        "eventId": match_id, "league": row["league"], "date": date,
        "startTime": start_tw.strftime("%H:%M"), "startISO": start_tw.isoformat(timespec="seconds"),
        "awayTeam": row["awayZh"], "homeTeam": row["homeZh"],
        "sourceUrl": row["url"], "source": "BetExplorer",
        "markets": markets,
        "stakeSwap": {"ever": swap["ever"], "activeSide": swap["activeSide"],
                      "struckSide": swap["struckSide"]},
    }


def _load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", default="")
    parser.add_argument("--month", default="")
    parser.add_argument("--max-games", type=int, default=400)
    parser.add_argument("--offset", type=float, default=7.0,
                        help="站方時區→台灣的時差；日常抓取會反推，收割用固定值（歷史頁無法反推）")
    parser.add_argument("--archive-dir", default="data/oddsportal_archive")
    parser.add_argument("--state", default="data/betexplorer_harvest_state.json")
    parser.add_argument("--season-start", default="2026-04-01")
    args = parser.parse_args()

    team_zh = _team_zh()
    state_path = Path(args.state)
    state = _load(state_path, {})

    today_tw = datetime.now(TW).replace(tzinfo=None)
    total_new = 0
    # 整季模式（預設）：?month=all 一次拿全季（美職 1731 場 3 秒）。中職站方只留近期，
    # 其餘由 OddsPortal 舊檔補（8/1 前）。指定 --month 才走單月頁。
    targets = [args.league] if args.league else list(LEAGUES)
    for league in targets:
        if args.month:
            rows = BE.discover_month(league, args.month, team_zh, today_tw=today_tw)
        else:
            rows = BE.discover_season(league, team_zh, args.season_start, today_tw=today_tw)
        by_month: dict[str, list[dict]] = {}
        for row in rows:
            by_month.setdefault(row["date"][:7], []).append(row)
        for month in sorted(by_month, reverse=True):
            if total_new >= args.max_games:
                break
            total_new = _harvest_month(league, month, by_month[month], args, state, state_path, total_new)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({"totalHarvested": total_new}, ensure_ascii=False))
    return 0


def _harvest_month(league, month, rows, args, state, state_path, total_new):
        archive_path = Path(args.archive_dir) / f"{month}.json"
        archive = _load(archive_path, {"version": 1, "source": "BetExplorer",
                                       "bookmaker": "Stake.com", "games": {}})
        archive.setdefault("games", {})
        def _complete(game):
            """齊全＝三市場都有收盤，且不存在「沒有時戳的初盤」。
            後者是舊版把收盤誤標成初盤留下的殘骸，必須重抓修正。"""
            markets = game.get("markets") or {}
            if not all((markets.get(k) or {}).get("close") for k in ("ml", "hd", "ou")):
                return False
            for k in ("ml", "hd", "ou"):
                opened = (markets.get(k) or {}).get("open")
                if opened and opened.get("at") is None:
                    return False
            return True
        have, refill = set(), set()
        for game in archive["games"].values():
            eid = game.get("eventId")
            if not eid:
                continue
            if _complete(game) or game.get("refilled"):
                have.add(eid)                       # 齊全、或已補過一次就不再重抓
            else:
                refill.add(eid)
        pending = [r for r in rows if r["matchId"] not in have]
        if refill:
            print(f"INFO   其中 {len(refill)} 場缺收盤，重抓一次補齊", file=sys.stderr)
        print(f"INFO {league} {month}: 結果頁 {len(rows)} 場、待抓 {len(pending)} 場", file=sys.stderr)

        done_count = fail = 0
        for row in pending:
            if total_new >= args.max_games:
                break
            try:
                game = harvest_game(row, args.offset)
            except Exception as exc:
                fail += 1
                if fail >= 5:
                    print(f"WARN {league} {month} 連續失敗過多，中止本月：{str(exc)[:80]}", file=sys.stderr)
                    break
                continue
            fail = 0
            key = "|".join([game["league"], game["date"], game["awayTeam"],
                            game["homeTeam"], game["startTime"], game["eventId"]])
            if row["matchId"] in refill:
                game["refilled"] = True             # 補過一次就打標，避免永遠重抓
            archive["games"][key] = game
            done_count += 1
            total_new += 1
            if done_count % 20 == 0:
                archive_path.parent.mkdir(parents=True, exist_ok=True)
                archive_path.write_text(json.dumps(archive, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
                print(f"INFO   ...已落盤 {done_count} 場", file=sys.stderr)

        archive["updatedAt"] = datetime.now(TW).isoformat(timespec="seconds")
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        archive_path.write_text(json.dumps(archive, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

        if not pending or done_count >= len(pending):
            slot = state.setdefault(league, {})
            months = set(slot.get("months") or [])
            months.add(month)
            slot["months"] = sorted(months)
            slot["updatedAt"] = datetime.now(TW).isoformat(timespec="seconds")
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(json.dumps({"league": league, "month": month, "found": len(rows),
                          "harvested": done_count, "totalInMonth": len(archive["games"])},
                         ensure_ascii=False))
        return total_new


if __name__ == "__main__":
    raise SystemExit(main())
