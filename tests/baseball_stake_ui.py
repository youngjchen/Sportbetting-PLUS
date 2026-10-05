import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


TODAY = "2026-10-03"
GAME_DATE = "2026-10-04"
BASE_URL = os.environ.get("TEST_BASE_URL", "http://127.0.0.1:8766/index.html")
_URL = urlsplit(BASE_URL)
LOCAL_PREFIX = f"{_URL.scheme}://{_URL.netloc}/"
CARD = {
    "id": 9001,
    "type": "match",
    "officialId": "NPB_20261004_Tigers@DeNA_1700",
    "league": "npb",
    "away": "阪神",
    "home": "橫濱",
    "awayColor": "#f5c542",
    "homeColor": "#2d7ff9",
    "gameTime": "17:00",
    "hdFav": "home",
    "hdVal": "",
    "totVal": "",
    "mlAway": {"lights": 0},
    "mlHome": {"lights": 0},
    "hdGive": {"lights": 0},
    "hdRecv": {"lights": 0},
    "over": {"lights": 0},
    "under": {"lights": 0},
    "collapsed": False,
}


def main():
    def trace(message):
        print(f"[baseball-stake-ui] {message}", flush=True)

    document = {
        "version": 2,
        "activeDate": GAME_DATE,
        "boards": {
            TODAY: {"items": [], "summaryPos": None},
            GAME_DATE: {"items": [CARD], "summaryPos": None},
        },
        "stats": {},
        "recent": [],
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        console_errors = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.route(
            "**/*",
            lambda route: route.continue_()
            if route.request.url.startswith(LOCAL_PREFIX)
            else route.fulfill(status=404, body=""),
        )
        init_args = json.dumps(
            ["sportbetting_plus_doc_v2", json.dumps(document, ensure_ascii=False)],
            ensure_ascii=False,
        )
        page.add_init_script(
            f"(([key, value]) => {{ window.__stakeUiSeeded = true; localStorage.setItem(key, value); }})({init_args})"
        )
        trace("navigate")
        page.goto(BASE_URL, wait_until="domcontentloaded")
        trace("switch board")
        page.evaluate(
            """() => {
              doc.activeDate = '2026-10-04';
              loadActiveBoard();
              render();
            }"""
        )
        row = page.locator(".market-monitor")
        try:
            row.wait_for(state="visible", timeout=15_000)
        except Exception:
            diagnostics = page.evaluate(
                """() => ({
                  cards: document.querySelectorAll('.card.bcard').length,
                  integration: !!window.__baseballStakeIntegration,
                  feedKeys: window.__baseballStakeIntegration ? Object.keys(window.__baseballStakeIntegration._getFeed().matches || {}) : [],
                  stateCount: typeof state !== 'undefined' ? state.items.length : -1,
                  firstCard: typeof state !== 'undefined' ? state.items[0] : null,
                  today: typeof todayStr === 'function' ? todayStr() : null,
                  activeDate: typeof doc !== 'undefined' ? doc.activeDate : null,
                  boardKeys: typeof doc !== 'undefined' ? Object.keys(doc.boards || {}) : [],
                  seeded: window.__stakeUiSeeded || false,
                  stored: localStorage.getItem('sportbetting_plus_doc_v2')?.slice(0, 30) || null
                })"""
            )
            print(json.dumps({"diagnostics": diagnostics, "consoleErrors": console_errors}, ensure_ascii=False, indent=2))
            page.screenshot(path=str(Path("test-results") / "baseball-stake-monitor-failure.png"), full_page=True)
            raise
        trace("monitor visible")
        text = row.inner_text()
        assert "STAKE" in text, text
        assert "曾對調" in text, text
        assert "大小 7.5" not in text, text
        row.locator(".market-monitor-head").click()
        detail = row.locator(".market-monitor-details").inner_text()
        assert "讓1.5" in detail, detail
        assert "大小 7.5" in detail, detail

        page.locator(".bswap").click()
        page.locator(".market-monitor-head").click()
        page.locator(".market-auto-controls button", has_text="恢復自動讓分").wait_for(state="visible")
        page.locator('.basis input[type="number"]').fill("8.5")
        page.evaluate("render()")
        page.locator(".market-monitor-head").click()
        page.locator(".market-auto-controls button", has_text="恢復自動大小").wait_for(state="visible")
        trace("manual locks verified")

        locked = page.evaluate("({hd:state.items[0].stakeAutoHandicap,total:state.items[0].stakeAutoTotal})")
        assert locked == {"hd": False, "total": False}, locked
        page.screenshot(path=str(Path("test-results") / "baseball-stake-monitor.png"), full_page=True)
        trace("screenshot saved")
        relevant_errors = [
            line for line in console_errors
            if "Stake 棒球" not in line and "Failed to load resource" not in line
        ]
        assert not relevant_errors, relevant_errors
        browser.close()
        trace("browser closed")


if __name__ == "__main__":
    main()
