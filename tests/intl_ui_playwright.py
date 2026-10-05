import json
import os
import pathlib
import unittest

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("TEST_BASE_URL", (ROOT / "index.html").as_uri())


class IntlStripUiTests(unittest.TestCase):
    def test_taiwan_only_live_series_is_labeled_as_current_series(self):
        board = {
            "version": 2,
            "activeDate": "2026-07-29",
            "boards": {
                "2026-07-29": {
                    "items": [{
                        "id": "ui-test-game",
                        "type": "match",
                        "league": "cpbl",
                        "away": "味全龍",
                        "home": "富邦悍將",
                        "gameTime": "18:35",
                        "hdFav": "home",
                        "hdVal": "1.5",
                    }],
                    "summaryPos": None,
                },
            },
            "stats": {},
            "recent": [],
        }
        intl = {
            "updated": "2026-07-29T12:00:00+08:00",
            "games": {
                "cpbl|2026-07-29|味全龍|富邦悍將": {
                    "is": None,
                    "il": None,
                    "ls": "home",
                    "ll": 1.5,
                    "lsLive": True,
                    "lsw": 0,
                    "ltr": None,
                    "v": None,
                },
            },
        }

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.route(
                "**/data/intl_state.json*",
                lambda route: route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(intl, ensure_ascii=False),
                ),
            )
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.wait_for_function("typeof loadActiveBoard === 'function'", timeout=10000)
            page.evaluate(
                """([board, intl]) => {
                    doc = board;
                    loadActiveBoard();
                    __intl = intl;
                    window.__expertPicks = {
                        hdSwapFor: () => {
                            window.__hdSwapProbeCalls = (window.__hdSwapProbeCalls || 0) + 1;
                            return { '味全龍': 1, '富邦悍將': 1 };
                        }
                    };
                    render();
                }""",
                [board, intl],
            )
            self.assertEqual(
                page.evaluate("window.__expertPicks.hdSwapFor({})"),
                {"味全龍": 1, "富邦悍將": 1},
            )
            self.assertGreater(page.evaluate("window.__hdSwapProbeCalls || 0"), 1)
            strip = page.locator(".market-monitor").first
            strip.wait_for(state="visible", timeout=10000)
            strip_text = strip.locator(".market-monitor-head").inner_text()
            self.assertIn("changed", strip.locator(".market-platform.taiwan").get_attribute("class"))
            self.assertIn("BET365", strip_text)
            self.assertIn("待資料", strip_text)
            self.assertIn("富邦悍將讓1.5", strip_text)
            self.assertEqual(
                strip.locator(".market-platform.taiwan .market-state").inner_text(),
                "曾對調",
            )
            expanded = strip.locator(".market-monitor-head").evaluate(
                """element => {
                    element.click();
                    const details = element.parentElement.querySelector('.market-monitor-details');
                    return {
                        text: details.innerText,
                        display: getComputedStyle(details).display,
                    };
                }"""
            )
            self.assertNotEqual(expanded["display"], "none")
            self.assertIn("玩運彩盤中序列", expanded["text"])
            self.assertIn("明牌指紋", expanded["text"])
            self.assertNotIn("唯讀", expanded["text"])
            self.assertNotIn("不會改卡片", expanded["text"])
            browser.close()


if __name__ == "__main__":
    unittest.main()
