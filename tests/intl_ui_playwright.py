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
            page.goto(BASE_URL, wait_until="networkidle")
            page.wait_for_function("typeof loadActiveBoard === 'function'", timeout=10000)
            page.evaluate(
                """([board, intl]) => {
                    doc = board;
                    loadActiveBoard();
                    __intl = intl;
                    render();
                }""",
                [board, intl],
            )
            strip = page.locator(".intl-strip").filter(has_text="bet365 未開盤").first
            strip.wait_for(state="visible", timeout=10000)
            self.assertIn("bet365 未開盤", strip.inner_text())
            self.assertIn("台彩 富邦悍將讓1.5", strip.inner_text())
            expanded = strip.evaluate(
                """element => {
                    element.click();
                    const details = element.nextElementSibling;
                    return {
                        text: details.innerText,
                        display: getComputedStyle(details).display,
                    };
                }"""
            )
            self.assertNotEqual(expanded["display"], "none")
            self.assertIn("台彩側＝玩運彩盤中序列（現況）", expanded["text"])
            browser.close()


if __name__ == "__main__":
    unittest.main()
