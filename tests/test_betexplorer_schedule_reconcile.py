import unittest
from datetime import datetime, timedelta
from threading import Barrier

import betexplorer_run as runner


class ScheduleReconciliationTests(unittest.TestCase):
    def test_merge_bet365_summary_never_forgets_a_seen_flip(self):
        old = {
            "side": "away", "line": 1.5, "flipEver": True,
            "struck": [{"line": -1.5, "side": "home", "at": "2026-09-02T14:51:00+08:00"}],
            "observedAt": "2026-09-02T16:42:00+08:00",
        }
        new = {
            "side": "away", "line": 1.5, "flipEver": False, "struck": [],
            "observedAt": "2026-09-02T17:12:00+08:00",
        }

        merged = runner.merge_bet365_summary(old, new)

        self.assertTrue(merged["flipEver"])
        self.assertEqual(merged["struck"], old["struck"])
        self.assertEqual(merged["observedAt"], new["observedAt"])

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

    def test_schedule_alignment_happens_before_the_horizon_filter(self):
        """若先用來源的 13:05 過濾，實際 10:05 場次會掉出 12 小時視窗。"""
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
        window_start = datetime(2026, 8, 29, 22, 45, tzinfo=runner.TW) - timedelta(hours=6)
        window_end = datetime(2026, 8, 30, 10, 45, tzinfo=runner.TW)

        if not hasattr(runner, "reconcile_and_filter_window"):
            self.fail("尚未保證先校正排盤時間、再套用抓取視窗")
        kept, corrections = runner.reconcile_and_filter_window(
            games, 7.0, schedule, window_start, window_end
        )

        self.assertEqual([game["matchId"] for game in kept], ["8MwEu99s", "rwubIuCG"])
        self.assertEqual(corrections[-1]["to"], "10:05")

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

    def test_event_id_filter_collects_only_the_requested_game(self):
        """單場補抓不得再下載同日其餘所有比賽的盤口歷史。"""
        games = [
            {"matchId": "8MwEu99s"},
            {"matchId": "rwubIuCG"},
            {"matchId": "other"},
        ]

        if not hasattr(runner, "select_event_ids"):
            self.fail("尚未提供單場 eventId 補抓功能")
        selected = runner.select_event_ids(games, "8MwEu99s,rwubIuCG")

        self.assertEqual([game["matchId"] for game in selected], ["8MwEu99s", "rwubIuCG"])

    def test_parallel_collection_keeps_order_and_isolates_one_failure(self):
        """若退回逐場下載會卡在 barrier；若單場例外外洩則其他場也拿不到。"""
        games = [
            {"matchId": "first", "awayZh": "客一", "homeZh": "主一"},
            {"matchId": "second", "awayZh": "客二", "homeZh": "主二"},
            {"matchId": "bad", "awayZh": "壞客", "homeZh": "壞主"},
        ]
        rendezvous = Barrier(2)

        def fake_collect(game, _offset, _now):
            if game["matchId"] in {"first", "second"}:
                rendezvous.wait(timeout=1)
            if game["matchId"] == "bad":
                raise RuntimeError("來源失敗")
            return {
                "eventId": game["matchId"],
                "markets": {"ml": {"open": {"away": 2.0, "home": 1.8}}},
            }

        if not hasattr(runner, "collect_games"):
            self.fail("尚未提供並行盤口收集功能")
        collected, failed = runner.collect_games(
            games, 7.0, datetime(2026, 8, 29, tzinfo=runner.TW),
            workers=2, collect_fn=fake_collect,
        )

        self.assertEqual([entry["eventId"] for entry in collected], ["first", "second"])
        self.assertEqual(failed, ["壞客@壞主: 來源失敗"])


if __name__ == "__main__":
    unittest.main()
