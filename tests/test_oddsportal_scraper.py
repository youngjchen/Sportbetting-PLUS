import gzip
import json
import tempfile
import unittest
import warnings
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from oddsportal_scraper import (
    build_event_key,
    favorite_for_line,
    merge_game_snapshot,
    _parse_history_time,
    _inferred_switches,
    _compact_for_summary,
    _append_daily_archive,
    _is_pregame_listing,
    _listing_matches_schedule,
    _missing_market_diagnostic,
    _parse_listing_date,
    _partition_batches,
    _stealth_session_factory,
    _wait_for_market_navigation,
    _load_schedule,
    reduce_handicap_switches,
    team_zh,
    TW,
)


def snapshot(at, favorite, event_id="evt-1"):
    return {
        "eventId": event_id,
        "observedAt": at,
        "league": "mlb",
        "date": "2026-08-01",
        "startTime": "07:05",
        "awayTeam": "金鶯",
        "homeTeam": "費城人",
        "markets": {
            "hd": {
                "active": {
                    "favorite": favorite,
                    "line": -1.5 if favorite == "away" else 1.5,
                    "away": 2.5,
                    "home": 1.53,
                }
            }
        },
    }


class HandicapSwitchTests(unittest.TestCase):
    def test_listing_rejects_finished_and_live_rows_before_opening_event_pages(self):
        self.assertFalse(_is_pregame_listing("Finished | FIN | Team A | 6 | Team B | 1"))
        self.assertFalse(_is_pregame_listing("Live | 7th inning | Team A | Team B"))
        self.assertTrue(_is_pregame_listing("13:00 | Team A | Team B | 1.47 | 2.92"))

    def test_listing_date_and_doubleheader_time_are_matched_before_event_fetch(self):
        now = datetime(2026, 8, 1, 3, 0, tzinfo=TW)
        self.assertEqual(_parse_listing_date("Today, 01 Aug", now), "2026-08-01")
        self.assertEqual(_parse_listing_date("Tomorrow, 02 Aug", now), "2026-08-02")
        schedule = [
            {"league": "kbo", "date": "2026-08-01", "startTime": "14:00", "awayTeam": "雙子", "homeTeam": "斗山熊"},
            {"league": "kbo", "date": "2026-08-01", "startTime": "17:00", "awayTeam": "雙子", "homeTeam": "斗山熊"},
        ]
        event = {"league": "kbo", "listingDate": "2026-08-01", "listingTime": "17:00", "awayTeam": "雙子", "homeTeam": "斗山熊"}
        self.assertTrue(_listing_matches_schedule(event, schedule))
        event["listingTime"] = "11:00"
        self.assertFalse(_listing_matches_schedule(event, schedule))

    def test_current_oddsportal_team_aliases_map_to_project_names(self):
        self.assertEqual(team_zh("Fukuoka S. Hawks"), team_zh("Fukuoka SoftBank Hawks"))
        self.assertEqual(team_zh("KT Wiz Suwon"), team_zh("KT Wiz"))

    def test_struck_opposite_main_line_reconstructs_switch_and_return(self):
        def row(line, at, active=False, struck=False):
            side = {"history": {"opening": {"at": at, "odds": 1.9}}}
            return {"line": line, "first": side, "second": side, "active": active, "struck": struck}

        result = _inferred_switches([
            row(1.5, "2026-07-31T07:44:00+08:00", active=True),
            row(-1.5, "2026-07-31T13:18:00+08:00", struck=True),
        ], "2026-08-01T03:00:00+08:00")

        self.assertTrue(result["ever"])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["first"]["to"], "home")
        self.assertEqual(result["last"]["to"], "away")

    def test_struck_opposite_line_without_history_still_marks_switch(self):
        empty = {"history": {"opening": None, "movements": []}}
        result = _inferred_switches([
            {"line": -1.5, "first": empty, "second": empty, "active": False, "struck": True},
            {"line": 1.5, "first": empty, "second": empty, "active": True, "struck": False},
        ], "2026-08-01T03:00:00+08:00")

        self.assertTrue(result["ever"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["first"]["from"], "home")
        self.assertEqual(result["last"]["to"], "away")
        self.assertEqual(result["first"]["precision"], "struck-opposite-detected")

    def test_history_time_is_taipei_aware_before_year_boundary_comparison(self):
        event_start = datetime.fromisoformat("2026-08-01T07:05:00+08:00")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            parsed = _parse_history_time("31 Jul, 20:04", event_start)

        self.assertEqual(parsed, "2026-07-31T20:04:00+08:00")
        self.assertEqual(caught, [])

    def test_oddsportal_first_column_is_home_so_negative_line_means_home_favorite(self):
        self.assertEqual(favorite_for_line(-1.5), "home")
        self.assertEqual(favorite_for_line(1.5), "away")

    def test_single_switch_records_first_and_last_switch(self):
        result = reduce_handicap_switches([
            snapshot("2026-07-31T13:18:00+08:00", "away"),
            snapshot("2026-07-31T20:05:00+08:00", "home"),
        ])

        self.assertTrue(result["ever"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["initialFavorite"], "away")
        self.assertEqual(result["currentFavorite"], "home")
        self.assertEqual(result["first"]["from"], "away")
        self.assertEqual(result["first"]["to"], "home")
        self.assertEqual(result["first"], result["last"])

    def test_switch_back_keeps_ever_switched_and_both_milestones(self):
        result = reduce_handicap_switches([
            snapshot("2026-07-31T13:18:00+08:00", "away"),
            snapshot("2026-07-31T20:05:00+08:00", "home"),
            snapshot("2026-08-01T00:56:00+08:00", "away"),
        ])

        self.assertTrue(result["ever"])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["currentFavorite"], "away")
        self.assertEqual(result["first"]["to"], "home")
        self.assertEqual(result["last"]["to"], "away")

    def test_doubleheader_keys_include_time_and_oddsportal_event_id(self):
        early = build_event_key(
            "kbo", "2026-08-01", "斗山熊", "登陸者", "14:00", "early-id"
        )
        late = build_event_key(
            "kbo", "2026-08-01", "斗山熊", "登陸者", "17:00", "late-id"
        )

        self.assertNotEqual(early, late)
        self.assertTrue(early.endswith("|14:00|early-id"))
        self.assertTrue(late.endswith("|17:00|late-id"))


class SnapshotMergeTests(unittest.TestCase):
    def test_event_action_waits_for_market_navigation_before_collecting_rows(self):
        calls = []

        class Nav:
            def wait_for(self, **kwargs):
                calls.append(kwargs)

        class Page:
            def get_by_test_id(self, value):
                self.requested = value
                return Nav()

        page = Page()
        _wait_for_market_navigation(page)

        self.assertEqual(page.requested, "bet-types-nav")
        self.assertEqual(calls, [{"state": "visible", "timeout": 20000}])

    def test_missing_stake_row_diagnostic_distinguishes_geo_visibility(self):
        message = _missing_market_diagnostic({
            "ml": [], "hd": [], "ou": [],
            "visibleBookmakers": ["bet365", "BetInAsia", "Cloudbet"],
        })

        self.assertIn("Stake.com", message)
        self.assertIn("ml=0 hd=0 ou=0", message)
        self.assertIn("bet365", message)

    def test_cloud_runner_uses_stealth_session_with_cloudflare_solver(self):
        sentinel = object()
        fetchers = SimpleNamespace(StealthySession=sentinel)

        session_class, options = _stealth_session_factory(fetchers)

        self.assertIs(session_class, sentinel)
        self.assertTrue(options["headless"])
        self.assertTrue(options["solve_cloudflare"])
        self.assertTrue(options["block_webrtc"])
        self.assertTrue(options["hide_canvas"])
        self.assertTrue(options["google_search"])

    def test_event_batches_cover_every_event_once(self):
        events = [{"eventId": str(index)} for index in range(7)]
        batches = _partition_batches(events, 2)

        self.assertEqual(len(batches), 2)
        self.assertEqual(sorted(item["eventId"] for batch in batches for item in batch), [str(index) for index in range(7)])

    def test_daily_gzip_archive_is_readable_and_deduplicates_the_same_round(self):
        record = {"observedAt": "2026-08-01T04:00:00+08:00", "games": [{"eventId": "one"}]}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "2026-08-01.jsonl.gz"
            _append_daily_archive(path, record)
            _append_daily_archive(path, record)
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                rows = [json.loads(line) for line in handle if line.strip()]

        self.assertEqual(rows, [record])

    def test_active_poll_window_keeps_17_hour_game_and_defers_20_hour_game(self):
        rows = [
            {"league": "MLB", "date": "2026-08-01", "time": "20:00", "awayTeam": "金鶯", "homeTeam": "費城人"},
            {"league": "MLB", "date": "2026-08-01", "time": "23:00", "awayTeam": "紅襪", "homeTeam": "道奇"},
        ]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "pregame.json"
            path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
            loaded = _load_schedule(path, datetime(2026, 8, 1, 3, 0, tzinfo=TW))

        self.assertEqual([(row["awayTeam"], row["startTime"]) for row in loaded], [("金鶯", "20:00")])

    def test_summary_drops_full_rows_but_keeps_open_close_and_switch_milestones(self):
        game = snapshot("2026-07-31T20:05:00+08:00", "home")
        game["markets"]["hd"].update({
            "open": {"line": 1.5}, "close": {"line": -1.5},
            "rows": [{"history": {"movements": [1, 2, 3]}}],
        })
        game["handicapSwitch"] = {"ever": True, "count": 1, "first": {"to": "home"}, "last": {"to": "home"}}

        compact = _compact_for_summary(game)

        self.assertNotIn("rows", compact["markets"]["hd"])
        self.assertEqual(compact["markets"]["hd"]["open"]["line"], 1.5)
        self.assertEqual(compact["handicapSwitch"]["count"], 1)

    def test_fast_poll_detects_a_new_switch_without_retaining_full_observations(self):
        old = snapshot("2026-07-31T20:05:00+08:00", "away")
        old["handicapSwitch"] = {
            "ever": True, "count": 2, "initialFavorite": "away",
            "currentFavorite": "away", "first": {"to": "home"}, "last": {"to": "away"},
        }
        new = snapshot("2026-08-01T00:56:00+08:00", "home")

        merged = merge_game_snapshot(old, new)

        self.assertEqual(merged["handicapSwitch"]["count"], 3)
        self.assertEqual(merged["handicapSwitch"]["currentFavorite"], "home")
        self.assertNotIn("handicapObservations", merged)

    def test_missing_market_never_erases_previous_open_or_close(self):
        old = snapshot("2026-07-31T13:18:00+08:00", "away")
        old["markets"].update({
            "ml": {"open": {"away": 2.0, "home": 1.82}, "close": None},
            "ou": {"open": {"line": 8.5, "over": 1.91, "under": 1.91}},
        })
        partial = {
            **snapshot("2026-07-31T20:05:00+08:00", "home"),
            "markets": {"hd": snapshot("x", "home")["markets"]["hd"]},
        }

        merged = merge_game_snapshot(old, partial)

        self.assertEqual(merged["markets"]["ml"], old["markets"]["ml"])
        self.assertEqual(merged["markets"]["ou"], old["markets"]["ou"])
        self.assertEqual(merged["markets"]["hd"]["active"]["favorite"], "home")

    def test_invalid_or_empty_run_cannot_replace_a_valid_game(self):
        old = snapshot("2026-07-31T13:18:00+08:00", "away")
        merged = merge_game_snapshot(old, {
            "eventId": "evt-1",
            "observedAt": "2026-07-31T20:05:00+08:00",
            "markets": {},
            "complete": False,
        })

        self.assertEqual(merged, old)


class GapDrivenCadenceTests(unittest.TestCase):
    """2026-08-04 新節奏：缺口驅動＋已開賽回補＋收盤走勢史時戳取法。"""

    def _write_schedule(self, tmp, rows):
        path = Path(tmp) / "pregame.json"
        path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        return path

    def test_schedule_window_accepts_negative_from_hours_for_backfill(self):
        now = datetime(2026, 8, 4, 12, 0, tzinfo=TW)
        rows = [
            {"league": "mlb", "date": "2026-08-03", "gameTime": "07:05", "awayTeam": "A", "homeTeam": "B", "officialId": "x1"},
            {"league": "mlb", "date": "2026-08-04", "gameTime": "14:00", "awayTeam": "C", "homeTeam": "D", "officialId": "x2"},
            {"league": "mlb", "date": "2026-08-05", "gameTime": "07:05", "awayTeam": "E", "homeTeam": "F", "officialId": "x3"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_schedule(tmp, rows)
            default = _load_schedule(path, now)
            self.assertEqual([r["officialId"] for r in default], ["x2"])  # 舊行為：只有未來 18h
            widened = _load_schedule(path, now, from_hours=-84, to_hours=36)
            self.assertEqual([r["officialId"] for r in widened], ["x1", "x2", "x3"])

    def test_closing_from_rows_takes_last_pre_start_movement(self):
        from oddsportal_scraper import _closing_from_rows
        history_home = {
            "opening": {"at": "2026-08-04T02:00:00+08:00", "odds": 1.60},
            "movements": [
                {"at": "2026-08-04T03:00:00+08:00", "odds": 1.63},
                {"at": "2026-08-04T08:00:00+08:00", "odds": 1.90},  # 開賽後＝走地，不可入收盤
            ],
        }
        history_away = {
            "opening": {"at": "2026-08-04T02:00:00+08:00", "odds": 2.30},
            "movements": [{"at": "2026-08-04T04:30:00+08:00", "odds": 2.25}],
        }
        rows = [{
            "line": None,
            "first": {"odds": 1.90, "active": True, "struck": False, "history": history_home},
            "second": {"odds": 2.05, "active": True, "struck": False, "history": history_away},
            "active": True, "struck": False, "selected": True,
        }]
        close = _closing_from_rows(rows, "ml", "2026-08-04T07:05:00+08:00")
        self.assertEqual(close["home"], 1.63)
        self.assertEqual(close["away"], 2.25)
        self.assertTrue(close["final"])
        self.assertEqual(close["precision"], "history")
        self.assertEqual(close["at"], "2026-08-04T04:30:00+08:00")

    def test_market_summary_post_start_finalizes_close_from_history(self):
        from oddsportal_scraper import _market_summary
        history_home = {
            "opening": {"at": "2026-08-04T02:00:00+08:00", "odds": 1.60},
            "movements": [{"at": "2026-08-04T05:00:00+08:00", "odds": 1.66}],
        }
        history_away = {
            "opening": {"at": "2026-08-04T02:00:00+08:00", "odds": 2.30},
            "movements": [],
        }
        rows = [{
            "line": None,
            "first": {"odds": 9.99, "active": True, "struck": False, "history": history_home},
            "second": {"odds": 9.99, "active": True, "struck": False, "history": history_away},
            "active": True, "struck": False, "selected": True,
        }]
        result = _market_summary(rows, "ml", "2026-08-04T10:30:00+08:00", start_iso="2026-08-04T07:05:00+08:00")
        self.assertTrue(result["close"]["final"])          # 已開賽＝收盤定案
        self.assertEqual(result["close"]["home"], 1.66)     # 走勢史賽前最後一筆
        self.assertEqual(result["close"]["away"], 2.30)     # 無走勢→退回開盤
        self.assertEqual(result["open"]["home"], 1.60)      # 初盤照舊來自 opening

    def test_merge_market_never_downgrades_final_close(self):
        from oddsportal_scraper import _merge_market
        old = {"close": {"home": 1.63, "away": 2.25, "final": True, "precision": "history"}}
        merged = _merge_market(old, {"close": {"home": 9.9, "away": 9.9, "at": "later"}})
        self.assertEqual(merged["close"]["home"], 1.63)     # 非定案不得覆寫定案
        merged2 = _merge_market(old, {"close": {"home": 1.64, "away": 2.24, "final": True}})
        self.assertEqual(merged2["close"]["home"], 1.64)    # 定案可被更新的定案取代

    def test_pick_targets_selects_missing_open_and_unsettled_close(self):
        from oddsportal_scraper import pick_targets
        now = datetime(2026, 8, 4, 12, 0, tzinfo=TW)
        mk = lambda lg, date, hhmm, away, home: {
            "league": lg, "date": date, "startTime": hhmm,
            "startISO": f"{date}T{hhmm}:00+08:00", "awayTeam": away, "homeTeam": home,
        }
        row_open_filled = mk("mlb", "2026-08-05", "07:05", "A", "B")   # 未開賽、初盤已填 → 缺口模式不抓
        row_open_missing = mk("mlb", "2026-08-05", "08:10", "C", "D")  # 未開賽、缺初盤 → 抓
        row_close_missing = mk("mlb", "2026-08-04", "07:05", "E", "F") # 已開賽、收盤未定案 → 抓
        row_close_final = mk("mlb", "2026-08-03", "07:05", "G", "H")   # 已開賽、收盤定案 → 不抓
        summary = {"games": {
            "k1": {"league": "mlb", "date": "2026-08-05", "startTime": "07:05", "awayTeam": "A", "homeTeam": "B",
                    "markets": {"ml": {"open": {"home": 1.5, "away": 2.5}}}},
            "k2": {"league": "mlb", "date": "2026-08-03", "startTime": "07:05", "awayTeam": "G", "homeTeam": "H",
                    "markets": {"ml": {"open": {"home": 1.5, "away": 2.5}, "close": {"home": 1.6, "away": 2.4, "final": True}}}},
        }}
        schedule = [row_open_filled, row_open_missing, row_close_missing, row_close_final]
        picked = pick_targets(schedule, summary, now, refresh_upcoming=False, max_games=0)
        self.assertEqual([r["awayTeam"] for r in picked], ["C", "E"])
        refreshed = pick_targets(schedule, summary, now, refresh_upcoming=True, max_games=0)
        self.assertEqual([r["awayTeam"] for r in refreshed], ["A", "C", "E"])  # 巡檢閘：未開賽全刷＋回補
        capped = pick_targets(schedule, summary, now, refresh_upcoming=False, max_games=1)
        self.assertEqual([r["awayTeam"] for r in capped], ["C"])


if __name__ == "__main__":
    unittest.main()
