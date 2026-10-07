import json
import os

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("SBP_TEST_BASE_URL", "http://127.0.0.1:8765")
DOC_KEY = "sportbetting_plus_doc_v2"


def main():
    stale = {
        "version": 2,
        "activeDate": "2026-10-04",
        "boards": {
            "2026-10-03": {"items": [{"type": "match", "away": "舊", "home": "卡"}]},
            "2026-10-04": {"items": [{"type": "match", "away": "舊", "home": "卡"}]},
        },
        "games": [],
        "recent": [],
        "stats": {},
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(f"{BASE_URL}/index.html", wait_until="domcontentloaded")
        page.evaluate("([key, value]) => localStorage.setItem(key, value)", [DOC_KEY, json.dumps(stale)])
        page.reload(wait_until="domcontentloaded")

        page.wait_for_function(
            """async () => {
              if (!window.__ghSync) return false;
              const text = await window.__ghSync.localDocPlain();
              const doc = JSON.parse(text || '{}');
              return !!doc.boards?.['2026-10-05'] && !!doc.boards?.['2026-10-06'] &&
                (doc.games || []).some(game => game.date === '2026-10-03') &&
                (doc.games || []).some(game => game.date === '2026-10-04');
            }""",
            timeout=15000,
        )
        # The union installer reloads once after the atomic localStorage write.
        # Wait for that navigation to settle, then inspect the persistent copy.
        page.wait_for_timeout(2500)
        recovered = json.loads(page.evaluate("async () => await window.__ghSync.localDocPlain()"))

        assert len([item for item in recovered["boards"]["2026-10-05"]["items"] if item.get("type") == "match"]) == 10
        assert len([item for item in recovered["boards"]["2026-10-06"]["items"] if item.get("type") == "match"]) == 10
        assert len([game for game in recovered["games"] if game.get("date") == "2026-10-03"]) == 9
        assert len([game for game in recovered["games"] if game.get("date") == "2026-10-04"]) == 15
        browser.close()

    print("recovery state Playwright check passed")


if __name__ == "__main__":
    main()
