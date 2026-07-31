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


if __name__ == "__main__":
    unittest.main()
