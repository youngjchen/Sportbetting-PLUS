import json
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("TEST_BASE_URL", (ROOT / "index.html").as_uri())


def main():
    board = {
        "version": 2,
        "activeDate": "2026-10-05",
        "navShowScore": False,
        "boards": {
            "2026-10-05": {
                "items": [{
                    "id": 9901, "type": "match", "officialId": "MLB_20261005_PHI@LAD_0400",
                    "league": "mlb", "away": "費城人", "home": "道奇", "gameTime": "04:00",
                    "hdFav": "home", "hdVal": 1.5, "totVal": 7.5,
                    "mlAway": {"lights": 0}, "mlHome": {"lights": 0},
                    "hdGive": {"lights": 0}, "hdRecv": {"lights": 0},
                    "over": {"lights": 0}, "under": {"lights": 0},
                    "settled": {"awayScore": 3, "homeScore": 4},
                }, {
                    "id": 9902, "type": "match", "officialId": "MLB_20261005_NYY@BOS_0500",
                    "league": "mlb", "away": "洋基", "home": "紅襪", "gameTime": "05:00",
                    "hdFav": "away", "hdVal": 1.5, "totVal": 8.5,
                    "mlAway": {"lights": 0}, "mlHome": {"lights": 0},
                    "hdGive": {"lights": 0}, "hdRecv": {"lights": 0},
                    "over": {"lights": 0}, "under": {"lights": 0},
                    "settled": {},
                }],
                "summaryPos": None,
            },
        },
        "games": [], "stats": {}, "recent": [],
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        init_args = json.dumps(
            ["sportbetting_plus_doc_v2", json.dumps(board, ensure_ascii=False)], ensure_ascii=False
        )
        page.add_init_script(
            f"(([key,value]) => localStorage.setItem(key,value))({init_args})"
        )
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.wait_for_function("typeof render === 'function'")
        page.evaluate("render()")

        tag = page.locator("#matchnav .nvtag").first
        tag.wait_for(state="visible")
        assert "3:4" in tag.inner_text(), tag.inner_text()
        assert "04:00" not in tag.inner_text(), tag.inner_text()
        incomplete_tag = page.locator("#matchnav .nvtag").nth(1)
        assert "05:00" in incomplete_tag.inner_text(), incomplete_tag.inner_text()
        assert "undefined" not in incomplete_tag.inner_text(), incomplete_tag.inner_text()
        assert page.locator("#matchnav .nvhead", has_text="時間").count() == 0
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        raise
