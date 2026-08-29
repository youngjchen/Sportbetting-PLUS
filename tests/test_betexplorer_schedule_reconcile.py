import unittest
from datetime import datetime

import betexplorer_run as runner


class ScheduleReconciliationTests(unittest.TestCase):
    def test_doubleheader_is_aligned_to_the_two_scheduled_start_times(self):
        """若拿掉同隊雙重賽按順序對時，第二場會退回錯誤的 13:05。"""
        games = [
            {
                "league": "mlb", "matchId": "8MwEu99s",
                "awayZh": "響尾蛇", "homeZh": "巨人",
                "siteStart": datetime(2026, 8, 29, 21, 5),
            },
            {
                "league": "mlb", "matchId": "rwubIuCG",
                "awayZh": "響尾蛇", "homeZh": "巨人",
                "siteStart": datetime(2026, 8, 30, 6, 5),
            },
        ]
        schedule = [
            {
                "league": "MLB", "date": "2026-08-30", "time": "04:05",
                "awayTeam": "響尾蛇", "homeTeam": "巨人",
            },
            {
                "league": "MLB", "date": "2026-08-30", "time": "10:05",
                "awayTeam": "響尾蛇", "homeTeam": "巨人",
            },
        ]

        if not hasattr(runner, "reconcile_scheduled_starts"):
            self.fail("尚未提供賽程對時功能")
        corrections = runner.reconcile_scheduled_starts(games, 7.0, schedule)

        self.assertEqual(
            [runner.game_start_tw(game, 7.0).strftime("%H:%M") for game in games],
            ["04:05", "10:05"],
        )
        self.assertEqual(corrections, [
            {"matchId": "rwubIuCG", "from": "13:05", "to": "10:05"},
        ])

    def test_one_bad_time_is_quarantined_without_dropping_valid_games(self):
        """若恢復整批 fail-closed，01:05 的正確場也會被錯誤場次拖掉。"""
        games = [
            {
                "league": "mlb", "matchId": "valid",
                "awayZh": "紅襪", "homeZh": "洋基",
                "siteStart": datetime(2026, 8, 29, 18, 5),
            },
            {
                "league": "mlb", "matchId": "bad",
                "awayZh": "響尾蛇", "homeZh": "巨人",
                "siteStart": datetime(2026, 8, 30, 6, 5),
            },
        ]

        if not hasattr(runner, "partition_official_times"):
            self.fail("尚未提供逐場隔離時間異常的功能")
        accepted, rejected = runner.partition_official_times(
            games, 7.0, ["01:05"]
        )

        self.assertEqual([game["matchId"] for game in accepted], ["valid"])
        self.assertEqual([game["matchId"] for game in rejected], ["bad"])


if __name__ == "__main__":
    unittest.main()
