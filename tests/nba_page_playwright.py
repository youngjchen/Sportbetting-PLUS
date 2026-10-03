import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright


OUT = Path("test-results")
OUT.mkdir(exist_ok=True)
stake = json.loads(Path("data/nba_stake_odds.json").read_text(encoding="utf-8"))["matches"]["NBA_20261004_MIA@TOR"]
expected_total = str(stake["total"]["line"])
expected_line = str(stake["line"])
port = os.environ.get("NBA_TEST_PORT", "8877")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(locale="zh-TW", timezone_id="Asia/Taipei")
    context.add_init_script("""
      localStorage.setItem('sportbetting_nba_doc_v1', JSON.stringify({
        v: 1, activeDate: '2026-10-04', activeLeague: 'NBA', boards: {}, games: []
      }));
    """)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("https://raw.githubusercontent.com/**", lambda route: route.abort())
    page.goto(f"http://127.0.0.1:{port}/nba.html")
    page.wait_for_load_state("networkidle")

    card = page.locator('[data-id="NBA_20261004_MIA@TOR"]')
    card.wait_for(state="visible", timeout=15000)
    text = card.inner_text()
    assert "熱火" in text and "暴龍" in text
    assert "STAKE：獨贏 客 熱火" in text
    assert "BET365：未開盤" in text
    assert "台彩：獨贏 客 熱火" in text
    assert f"大 {expected_total}" in text and f"小 {expected_total}" in text

    total_input = card.locator('input[type="number"]').last
    assert total_input.input_value() == expected_total
    handicap = card.locator('.bmkt').filter(has_text="讓分")
    assert "暴龍" in handicap.inner_text() and f"−{expected_line}" in handicap.inner_text()

    handicap.locator('.bswap').click()
    card = page.locator('[data-id="NBA_20261004_MIA@TOR"]')
    handicap = card.locator('.bmkt').filter(has_text="讓分")
    assert "熱火" in handicap.inner_text() and f"−{expected_line}" in handicap.inner_text()
    page.evaluate("render()")
    handicap = page.locator('[data-id="NBA_20261004_MIA@TOR"] .bmkt').filter(has_text="讓分")
    assert "熱火" in handicap.inner_text() and f"−{expected_line}" in handicap.inner_text()

    history_toggle = page.locator('[data-id="NBA_20261004_MIA@TOR"] .nba-odds-history-toggle')
    history_toggle.click()
    assert page.locator('[data-id="NBA_20261004_MIA@TOR"] .nba-odds-history').is_visible()
    page.screenshot(path=str(OUT / "nba-three-source.png"), full_page=True)
    assert not errors, errors
    browser.close()
