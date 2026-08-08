import unittest
from datetime import datetime

from betexplorer import (
    parse_data_dt,
    parse_result_date,
    detect_offset_hours,
    discover_upcoming,
    discover_month,
    stake_lines,
    handicap_swap,
)


def zh(name):
    table = {
        "Nippon Ham Fighters": "火腿", "Rakuten Gold. Eagles": "樂天",
        "TSG Hawks": "台鋼", "Chinatrust Brothers": "兄弟",
        "Hanshin Tigers": "阪神", "Chunichi Dragons": "中日",
        "Draci Brno": None,
    }
    return table.get(name)


class DateParsingTests(unittest.TestCase):
    """2026-08-07 髒資料事故：舊來源靠猜日期格式，猜錯就繼承上一列＝九月場次寫成當日。
    新來源的日期是數字欄位；解析失敗一律跳過，永遠不繼承。"""

    def test_data_dt_is_numeric_fields_not_text(self):
        self.assertEqual(parse_data_dt("7,8,2026,10,00"), datetime(2026, 8, 7, 10, 0))
        self.assertEqual(parse_data_dt("31,12,2026,23,59"), datetime(2026, 12, 31, 23, 59))

    def test_data_dt_rejects_out_of_range_and_garbage(self):
        for raw in ("7,13,2026,10,00", "0,8,2026,10,00", "7,8,1999,10,00",
                    "7,8,2026,24,00", "7,8,2026,10,60", "7,8,2026", "", "a,b,c,d,e"):
            with self.assertRaises(ValueError, msg=raw):
                parse_data_dt(raw)

    def test_result_date_needs_month_agreement(self):
        today = datetime(2026, 8, 7, 13, 0)
        self.assertEqual(parse_result_date("30.04.", "2026-04", today), "2026-04-30")
        self.assertEqual(parse_result_date("1.5.", "2026-05", today), "2026-05-01")
        self.assertEqual(parse_result_date("Today", "2026-08", today), "2026-08-07")
        self.assertEqual(parse_result_date("Yesterday", "2026-08", today), "2026-08-06")
        # 列上月份與網址 month 不符 → 拒收（防止跨月串位）
        with self.assertRaises(ValueError):
            parse_result_date("30.09.", "2026-04", today)
        # Today 落在別的月 → 拒收
        with self.assertRaises(ValueError):
            parse_result_date("Today", "2026-04", today)
        with self.assertRaises(ValueError):
            parse_result_date("30.04.", "bad-month", today)


class OffsetTests(unittest.TestCase):
    """站方時區偏移不寫死：用我們自己的賽程反推，且必須全部一致。"""

    schedule = [
        {"awayTeam": "樂天", "homeTeam": "火腿", "time": "17:00"},
        {"awayTeam": "中日", "homeTeam": "阪神", "time": "17:00"},
        {"awayTeam": "兄弟", "homeTeam": "台鋼", "time": "18:35"},
    ]

    def _listing(self, hours):
        return [
            {"awayZh": "樂天", "homeZh": "火腿", "siteStart": datetime(2026, 8, 7, 17 - hours, 0)},
            {"awayZh": "中日", "homeZh": "阪神", "siteStart": datetime(2026, 8, 7, 17 - hours, 0)},
            {"awayZh": "兄弟", "homeZh": "台鋼", "siteStart": datetime(2026, 8, 7, 18 - hours, 35)},
        ]

    def test_offset_is_derived_not_hardcoded(self):
        self.assertEqual(detect_offset_hours(self.schedule, self._listing(7)), 7.0)
        self.assertEqual(detect_offset_hours(self.schedule, self._listing(6)), 6.0)

    def test_refuses_when_too_few_matches(self):
        with self.assertRaises(RuntimeError):
            detect_offset_hours(self.schedule, self._listing(7)[:2])

    def test_refuses_when_offsets_disagree(self):
        listing = self._listing(7)
        listing[0]["siteStart"] = datetime(2026, 8, 7, 9, 0)      # 故意錯開一場
        with self.assertRaises(RuntimeError):
            detect_offset_hours(self.schedule, listing)


class DiscoveryTests(unittest.TestCase):
    UPCOMING = '''
<tr class="js-tournament"><th><a href="/baseball/japan/npb/" class="table-main__tournament"><i><img></i>Japan: NPB</a></th></tr>
<tr data-dt="7,8,2026,10,00"><td class="h-text-left"><span class="table-main__time">10:00</span><a href="/baseball/japan/npb/nippon-ham-fighters-rakuten-gold-eagles/YHS05yOp/">Nippon Ham Fighters - Rakuten Gold. Eagles</a></td></tr>
<tr data-dt="99,8,2026,10,00"><td class="h-text-left"><a href="/baseball/japan/npb/broken/XXXXXXXX/">Hanshin Tigers - Chunichi Dragons</a></td></tr>
<tr class="js-tournament"><th><a href="/baseball/czech-republic/extraliga/" class="table-main__tournament">Czech Republic: Extraliga</a></th></tr>
<tr data-dt="7,8,2026,1,00"><td class="h-text-left"><a href="/baseball/czech-republic/extraliga/x/ZZZZZZZZ/">Draci Brno - Draci Brno</a></td></tr>
'''

    def test_upcoming_parses_and_skips_bad_rows(self):
        games = discover_upcoming(zh, html=self.UPCOMING)
        self.assertEqual(len(games), 1)                     # 壞日期那列被跳過、捷克聯賽不在清單
        game = games[0]
        self.assertEqual((game["league"], game["matchId"]), ("npb", "YHS05yOp"))
        self.assertEqual((game["awayZh"], game["homeZh"]), ("樂天", "火腿"))
        self.assertEqual(game["siteStart"], datetime(2026, 8, 7, 10, 0))

    def test_bad_row_never_inherits_previous_date(self):
        """事故核心：解析不了的列必須消失，不能沿用上一列的日期。"""
        games = discover_upcoming(zh, html=self.UPCOMING)
        self.assertNotIn("XXXXXXXX", [g["matchId"] for g in games])

    RESULTS = '''
<tr><td class="h-text-left"><a data-test="1" href="/baseball/taiwan/cpbl/tsg-hawks-chinatrust-brothers/U9EYUw13/" class="in-match"><span>TSG Hawks</span> - <span><strong>Chinatrust Brothers</strong></span></a></td><td class="h-text-center"><a href="#">1:5</a></td><td class="h-text-right h-text-no-wrap">30.04.</td></tr>
<tr><td class="h-text-left"><a data-test="2" href="/baseball/taiwan/cpbl/x-y/AAAAAAAA/" class="in-match"><span>TSG Hawks</span> - <span>Chinatrust Brothers</span></a></td><td class="h-text-center"><a href="#">2:1</a></td><td class="h-text-right h-text-no-wrap">30.09.</td></tr>
'''

    def test_month_results_reject_cross_month_rows(self):
        rows = discover_month("cpbl", "2026-04", zh, today_tw=datetime(2026, 8, 7),
                              html=self.RESULTS)
        self.assertEqual([r["matchId"] for r in rows], ["U9EYUw13"])
        self.assertEqual(rows[0]["date"], "2026-04-30")
        self.assertEqual((rows[0]["awayZh"], rows[0]["homeZh"]), ("兄弟", "台鋼"))


class StakeAndSwapTests(unittest.TestCase):
    """2026-08-07 兄弟@台鋼實證：+1.5 已下架、-1.5 在架上；使用者於 Stake 現場確認
    只剩台鋼 -1.5 ⇒ 確實對調過。判別依據＝該格有無 data-oid。"""

    # 取自 2026-08-07 兄弟@台鋼實際回應：已下架的列帶 class="... inactive"，
    # 仍在架上的列沒有。data-oid 只出現在「被 highlight 的主盤」，不能拿來判在不在架上。
    AH_HTML = '''
<tr data-bid="997" data-bookie-id="1089"><td class="h-text-left">Stake.com</td>
<td class="table-main__doubleparameter">-1.5</td>
<td class="archiveOddsMovement__odds table-main__detail-odds" data-odd="2.08" data-created="07,08,2026,06,26" data-oid="abc" data-bid="997" data-bt="5" data-sc="1" data-hcp="E-5-1-0--1.5-0"></td>
<td class="archiveOddsMovement__odds table-main__detail-odds" data-odd="1.67" data-created="07,08,2026,05,59" data-oid="abd" data-bid="997" data-bt="5" data-sc="1" data-hcp="E-5-1-0--1.5-0"></td></tr>
<tr data-bid="997" data-bookie-id="1089"><td class="h-text-left">Stake.com</td>
<td class="table-main__doubleparameter">+1.5</td>
<td class="archiveOddsMovement__odds table-main__detail-odds inactive " data-odd="1.44" data-created="06,08,2026,20,41"></td>
<td class="archiveOddsMovement__odds table-main__detail-odds inactive " data-odd="2.60" data-created="06,08,2026,20,31"></td></tr>
'''

    # 歐力士@羅德實際回應：同時掛著 +1.5/+2.5/+4.5（都沒有 data-oid，但都在架上），
    # 下架的是 -2.5/-1.5（帶 inactive）。用 data-oid 判會把 +2.5/+4.5 誤判成已下架。
    ALT_LINES_HTML = '''
<tr data-bid="997"><td>Stake.com</td><td class="table-main__doubleparameter">-1.5</td>
<td class="table-main__detail-odds inactive " data-odd="2.55" data-created="07,08,2026,08,01"></td>
<td class="table-main__detail-odds inactive " data-odd="1.47" data-created="07,08,2026,08,20"></td></tr>
<tr data-bid="997"><td>Stake.com</td><td class="table-main__doubleparameter">+1.5</td>
<td class="table-main__detail-odds" data-odd="1.48" data-created="07,08,2026,08,25" data-oid="a" data-bid="997" data-bt="5" data-sc="1" data-hcp="h"></td>
<td class="table-main__detail-odds" data-odd="2.55" data-created="07,08,2026,08,25" data-oid="b" data-bid="997" data-bt="5" data-sc="1" data-hcp="h"></td></tr>
<tr data-bid="997"><td>Stake.com</td><td class="table-main__doubleparameter">+2.5</td>
<td class="table-main__detail-odds" data-odd="1.30" data-created="07,08,2026,08,25"></td>
<td class="table-main__detail-odds" data-odd="3.30" data-created="07,08,2026,08,25"></td></tr>
'''

    def test_alt_lines_without_data_oid_are_still_on_the_board(self):
        """使用者質疑歐力士@羅德後的修正：+2.5/+4.5 沒有 data-oid 但仍在架上，
        用 data-oid 判會把它們誤判成已下架、進而誤報對調方向。"""
        lines = stake_lines("fNDeRIp4", "ah", odds_html=self.ALT_LINES_HTML)
        by_line = {x["line"]: x for x in lines}
        self.assertTrue(by_line[1.5]["active"])
        self.assertTrue(by_line[2.5]["active"])      # 沒有 data-oid，但沒有 inactive ⇒ 在架上
        self.assertFalse(by_line[2.5]["primary"])
        self.assertFalse(by_line[-1.5]["active"])    # 帶 inactive ⇒ 已下架
        swap = handicap_swap(lines)
        self.assertTrue(swap["ever"])
        self.assertEqual(swap["activeSide"], ["away"])
        self.assertEqual(swap["struckSide"], ["home"])

    def test_active_flag_comes_from_inactive_class(self):
        lines = stake_lines("U9EYUw13", "ah", odds_html=self.AH_HTML)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["line"], -1.5)
        self.assertTrue(lines[0]["active"])              # 有 data-oid ＝ 仍在架上
        self.assertEqual(lines[1]["line"], 1.5)
        self.assertFalse(lines[1]["active"])             # 沒有 ＝ 已下架

    def test_swap_detected_when_struck_side_opposes_active(self):
        swap = handicap_swap(stake_lines("U9EYUw13", "ah", odds_html=self.AH_HTML))
        self.assertTrue(swap["ever"])
        self.assertEqual(swap["activeSide"], ["home"])
        self.assertEqual(swap["struckSide"], ["away"])

    def test_alt_lines_on_the_same_side_are_not_a_swap(self):
        html = self.AH_HTML.replace("+1.5", "-2.5")       # 兩條都是主隊讓＝另類盤口
        swap = handicap_swap(stake_lines("x", "ah", odds_html=html))
        self.assertFalse(swap["ever"])

    def test_single_active_line_is_not_a_swap(self):
        html = self.AH_HTML.split("<tr data-bid=\"997\" data-bookie-id=\"1089\"><td class=\"h-text-left\">Stake.com</td>\n<td class=\"table-main__doubleparameter\">+1.5")[0]
        swap = handicap_swap(stake_lines("x", "ah", odds_html=html))
        self.assertFalse(swap["ever"])


if __name__ == "__main__":
    unittest.main()


class SeasonDateTests(unittest.TestCase):
    """整季頁（?month=all）只有 DD.MM.，沒有年份也沒有 month 參數可比對。
    年份用『不可能是未來』推定，且必須落在球季區間內，否則整列拒收。"""

    today = datetime(2026, 8, 7, 15, 0)

    def test_infers_year_without_guessing_format(self):
        from betexplorer import parse_season_date
        self.assertEqual(parse_season_date("30.04.", self.today, "2026-04-01"), "2026-04-30")
        self.assertEqual(parse_season_date("1.8.", self.today, "2026-04-01"), "2026-08-01")
        self.assertEqual(parse_season_date("Today", self.today, "2026-04-01"), "2026-08-07")
        self.assertEqual(parse_season_date("Yesterday", self.today, "2026-04-01"), "2026-08-06")

    def test_rejects_future_and_pre_season_rows(self):
        from betexplorer import parse_season_date
        for text in ("30.09.", "08.08.", "01.03.", "31.12.", "garbage", "", "45.01."):
            with self.assertRaises(ValueError, msg=text):
                parse_season_date(text, self.today, "2026-04-01")

    def test_season_discovery_drops_unparseable_rows(self):
        from betexplorer import discover_season
        html = '''
<tr><td class="h-text-left"><a data-test="1" href="/baseball/taiwan/cpbl/a-b/GOODGAME/" class="in-match"><span>TSG Hawks</span> - <span>Chinatrust Brothers</span></a></td><td class="h-text-center"><a href="#">1:0</a></td><td class="h-text-right h-text-no-wrap">30.04.</td></tr>
<tr><td class="h-text-left"><a data-test="2" href="/baseball/taiwan/cpbl/c-d/FUTUREGM/" class="in-match"><span>TSG Hawks</span> - <span>Chinatrust Brothers</span></a></td><td class="h-text-center"><a href="#">2:0</a></td><td class="h-text-right h-text-no-wrap">30.09.</td></tr>
'''
        rows = discover_season("cpbl", zh, "2026-04-01", today_tw=self.today, html=html)
        self.assertEqual([r["matchId"] for r in rows], ["GOODGAME"])
        self.assertEqual(rows[0]["date"], "2026-04-30")


class OffsetMidnightTests(unittest.TestCase):
    """2026-08-07 深夜實例：站方 23:40 對應台灣隔天 06:40，實際時差 +7h，
    但只比對時分會算成 -17h。必須正規化到 (-12, +12]。"""

    def test_offset_across_midnight(self):
        schedule = [
            {"awayTeam": "藍鳥", "homeTeam": "費城人", "time": "06:40"},
            {"awayTeam": "大都會", "homeTeam": "海盜", "time": "06:40"},
            {"awayTeam": "紅人", "homeTeam": "國民", "time": "06:45"},
        ]
        listing = [
            {"awayZh": "藍鳥", "homeZh": "費城人", "siteStart": datetime(2026, 8, 7, 23, 40)},
            {"awayZh": "大都會", "homeZh": "海盜", "siteStart": datetime(2026, 8, 7, 23, 40)},
            {"awayZh": "紅人", "homeZh": "國民", "siteStart": datetime(2026, 8, 7, 23, 45)},
        ]
        self.assertEqual(detect_offset_hours(schedule, listing), 7.0)


class OffsetSeriesCollisionTests(unittest.TestCase):
    """2026-08-09 事故：連續系列賽同一組對戰會出現在好幾天，
    若把 (客,主) 當唯一鍵就取到別天的時間，算出 2.5/4.42/4.5/5.5 這種互相矛盾的時差
    → 整輪中止、33 小時沒抓資料。改成多候選投票，取得票最高者。"""

    def _listing(self):
        return [
            {"awayZh": "勇士", "homeZh": "洋基", "siteStart": datetime(2026, 8, 8, 20, 5)},
            {"awayZh": "運動家", "homeZh": "紅襪", "siteStart": datetime(2026, 8, 8, 21, 10)},
            {"awayZh": "天使", "homeZh": "馬林魚", "siteStart": datetime(2026, 8, 8, 21, 10)},
            {"awayZh": "藍鳥", "homeZh": "費城人", "siteStart": datetime(2026, 8, 8, 23, 5)},
        ]

    def test_series_duplicates_do_not_break_detection(self):
        # 每組對戰都有「昨天」與「今天」兩個時間；正確時差 +7 應該勝出
        schedule = []
        for away, home, right, wrong in (("勇士", "洋基", "03:05", "07:05"),
                                         ("運動家", "紅襪", "04:10", "07:10"),
                                         ("天使", "馬林魚", "04:10", "07:10"),
                                         ("藍鳥", "費城人", "06:05", "06:40")):
            schedule.append({"awayTeam": away, "homeTeam": home, "time": right})
            schedule.append({"awayTeam": away, "homeTeam": home, "time": wrong})
        self.assertEqual(detect_offset_hours(schedule, self._listing()), 7.0)

    def test_refuses_on_tie(self):
        schedule = [{"awayTeam": "勇士", "homeTeam": "洋基", "time": "03:05"},
                    {"awayTeam": "運動家", "homeTeam": "紅襪", "time": "05:10"}]
        with self.assertRaises(RuntimeError):
            detect_offset_hours(schedule, self._listing())
