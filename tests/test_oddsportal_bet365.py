import os
import sys
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from oddsportal_bet365 import (  # noqa: E402
    TW, betexplorer_covered, merge_bet365, page_date_ok, pick_targets,
    schedule_from_events, summarize_bet365,
)

NOW = datetime(2026, 10, 12, 0, 30, tzinfo=TW)
OBS = "2026-10-12T00:30:00+08:00"
NAMES = {"Doosan Bears": "斗山熊", "Lotte Giants": "樂天", "Seibu Lions": "西武", "Nippon Ham Fighters": "火腿"}


class SummaryTests(unittest.TestCase):
    def test_struck_home_line_then_away_line_is_a_swap(self):
        # 10/12 樂天@斗山熊：bet365 −1.5（斗山熊讓）劃線、+1.5（樂天讓）現行
        rows = [
            {"book": "bet365", "line": "-1.5", "home": "2.20", "away": "1.63", "struck": True},
            {"book": "bet365", "line": "+1.5", "home": "1.53", "away": "2.40", "struck": False},
        ]
        out = summarize_bet365(rows, OBS)
        self.assertEqual(out["side"], "away")
        self.assertEqual(out["line"], 1.5)
        self.assertTrue(out["flipEver"])
        self.assertFalse(out["ambiguous"])
        self.assertEqual(out["struck"], [{"line": -1.5, "side": "home", "at": None}])
        self.assertEqual(out["odds"], {"home": 1.53, "away": 2.40})

    def test_single_active_line_no_swap(self):
        out = summarize_bet365([{"line": "+1.5", "home": "1.53", "away": "2.40", "struck": False}], OBS)
        self.assertEqual(out["side"], "away")
        self.assertFalse(out["flipEver"])

    def test_both_directions_open_is_ambiguous(self):
        rows = [{"line": "-1.5", "home": "2.80", "away": "1.42", "struck": False},
                {"line": "+1.5", "home": "1.40", "away": "2.90", "struck": False}]
        self.assertTrue(summarize_bet365(rows, OBS)["ambiguous"])

    def test_no_active_rows_returns_none(self):
        self.assertIsNone(summarize_bet365([], OBS))
        self.assertIsNone(summarize_bet365([{"line": "-1.5", "home": "2", "away": "1.7", "struck": True}], OBS))


class MergeTests(unittest.TestCase):
    def test_side_change_between_rounds_counts_as_swap(self):
        # 舊線被直接撤掉（頁面沒留劃線）：上一輪主讓、這一輪客讓 → 仍要記成對調
        old = merge_bet365(None, summarize_bet365([{"line": "-1.5", "home": "2.1", "away": "1.7", "struck": False}],
                                                  "2026-10-11T20:00:00+08:00"))
        new = summarize_bet365([{"line": "+1.5", "home": "1.6", "away": "2.3", "struck": False}], OBS)
        merged = merge_bet365(old, new)
        self.assertEqual(merged["side"], "away")
        self.assertTrue(merged["flipEver"])
        self.assertIn({"line": -1.5, "side": "home", "at": "2026-10-11T20:00:00+08:00", "observed": True},
                      merged["struck"])
        self.assertEqual(merged["at"], OBS)
        self.assertEqual(len(merged["history"]), 2)

    def test_evidence_only_grows_and_side_start_time_is_kept(self):
        first = merge_bet365(None, summarize_bet365([
            {"line": "-1.5", "home": "2.2", "away": "1.6", "struck": True},
            {"line": "+1.5", "home": "1.5", "away": "2.4", "struck": False}], "2026-10-11T20:00:00+08:00"))
        later = merge_bet365(first, summarize_bet365([{"line": "+1.5", "home": "1.5", "away": "2.4", "struck": False}], OBS))
        self.assertTrue(later["flipEver"])
        self.assertEqual(later["at"], "2026-10-11T20:00:00+08:00")
        self.assertEqual(len(later["history"]), 1)          # 方向、線、賠率都沒變 → 不重複記

    def test_missing_new_keeps_old(self):
        old = {"side": "home", "line": 1.5}
        self.assertIs(merge_bet365(old, None), old)


class TargetTests(unittest.TestCase):
    def _summary(self, observed_at, side="away", ambiguous=False):
        return {"games": {"k": {"eventId": "8KICHMzo", "league": "kbo", "date": "2026-10-12",
                                "awayTeam": "樂天", "homeTeam": "斗山熊",
                                "bet365": {"side": side, "ambiguous": ambiguous, "observedAt": observed_at}}}}

    def _games(self):
        events = [
            {"n": "Doosan Bears - Lotte Giants", "d": "2026-10-12T09:30:00.000Z",
             "u": "https://www.oddsportal.com/baseball/h2h/doosan-bears-pGmPNh11/lotte-giants-pGw4ggkO/#8KICHMzo/"},
            {"n": "Seibu Lions - Nippon Ham Fighters", "d": "2026-10-12T05:00:00.000Z",
             "u": "https://www.oddsportal.com/baseball/h2h/nippon-ham-fighters-AyxT5jRb/seibu-lions-rZih28QN/#dW0Bupc5/"},
            {"n": "Seibu Lions - Nippon Ham Fighters", "d": "2026-10-11T05:00:00.000Z",
             "u": "https://www.oddsportal.com/baseball/h2h/nippon-ham-fighters-AyxT5jRb/seibu-lions-rZih28QN/#OArdFvm3/"},
        ]
        games, unmapped = schedule_from_events("kbo", events, NAMES.get, NOW, 36)
        self.assertEqual(unmapped, [])
        return games

    def test_schedule_maps_home_away_and_skips_started_games(self):
        games = self._games()
        self.assertEqual([g["eventId"] for g in games], ["8KICHMzo", "dW0Bupc5"])
        self.assertEqual((games[0]["awayTeam"], games[0]["homeTeam"]), ("樂天", "斗山熊"))
        self.assertEqual(games[0]["startISO"], "2026-10-12T17:30:00+08:00")

    def test_fresh_betexplorer_capture_is_not_revisited(self):
        ids, keys = betexplorer_covered(self._summary("2026-10-12T00:05:00+08:00"), NOW)
        self.assertEqual([g["eventId"] for g in pick_targets(self._games(), ids, keys, 10)], ["dW0Bupc5"])

    def test_stale_or_ambiguous_betexplorer_falls_through_to_oddsportal(self):
        for summary in (self._summary("2026-10-11T22:00:00+08:00"), self._summary(OBS, ambiguous=True)):
            ids, keys = betexplorer_covered(summary, NOW)
            self.assertEqual(len(pick_targets(self._games(), ids, keys, 10)), 2)


class PageDateTests(unittest.TestCase):
    def test_header_date_must_match_start(self):
        start = datetime(2026, 10, 12, 13, 0, tzinfo=TW)
        self.assertTrue(page_date_ok("NPB Seibu Lions - Nippon Ham Fighters Today, 12 Oct 2026, 13:00", start))
        self.assertFalse(page_date_ok("Yesterday, 11 Oct 2026, 13:00", start))
        self.assertIsNone(page_date_ok("no date here", start))


if __name__ == "__main__":
    unittest.main()
