import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright


OUT = Path("test-results")
OUT.mkdir(exist_ok=True)
stake = json.loads(Path("data/nba_stake_odds.json").read_text(encoding="utf-8"))["matches"]["NBA_20261004_MIA@TOR"]
expected_total = str(stake["total"]["line"])
expected_line = str(stake["line"])
port = os.environ.get("NBA_TEST_PORT", "8877")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-proxy-server"])
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
    def serve_local(route):
        relative = urlparse(route.request.url).path.lstrip('/') or 'index.html'
        target = (Path.cwd() / relative).resolve()
        if Path.cwd().resolve() not in target.parents and target != Path.cwd().resolve():
            route.abort()
            return
        if not target.is_file():
            route.fulfill(status=404, body="not found")
            return
        content_type = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        route.fulfill(status=200, body=target.read_bytes(), content_type=content_type)
    page.route(f"http://127.0.0.1:{port}/**", serve_local)
    page.goto(f"http://127.0.0.1:{port}/nba.html")
    page.wait_for_load_state("networkidle")

    card = page.locator('[data-id="NBA_20261004_MIA@TOR"]')
    card.wait_for(state="visible", timeout=15000)
    page.evaluate("""stakeGame => {
      stakeGame.frozenAt = stakeGame.observedAt || new Date().toISOString();
      window.__nbaOddsIntegration._setFeeds({stake:{matches:{[stakeGame.officialId]:stakeGame}}});
      window.render();
    }""", stake)
    card = page.locator('[data-id="NBA_20261004_MIA@TOR"]')
    text = card.inner_text()
    assert "熱火" in text and "暴龍" in text
    monitor_head = card.locator('.market-monitor-head')
    compact = monitor_head.inner_text()
    assert "STAKE" in compact and f"暴龍讓{expected_line}" in compact
    assert "BET365" in compact and "待資料" in compact
    assert "台彩" in compact
    assert "獨贏" not in compact and "官網" not in compact

    monitor_head.click()
    details = card.locator('.market-monitor-details')
    assert details.is_visible()
    detail_text = details.inner_text()
    assert "獨贏" in detail_text and "客 熱火" in detail_text
    assert f"大 {expected_total}" in detail_text and f"小 {expected_total}" in detail_text

    total_input = card.locator('.basis input')
    actual_total = total_input.input_value()
    assert actual_total == expected_total, (actual_total, expected_total)
    handicap = card.locator('.bmkt').filter(has_text="讓分")
    assert "暴龍" in handicap.inner_text() and f"−{expected_line}" in handicap.inner_text()

    handicap.locator('.bswap').click()
    card = page.locator('[data-id="NBA_20261004_MIA@TOR"]')
    handicap = card.locator('.bmkt').filter(has_text="讓分")
    assert "熱火" in handicap.inner_text() and f"−{expected_line}" in handicap.inner_text()
    page.evaluate("render()")
    handicap = page.locator('[data-id="NBA_20261004_MIA@TOR"] .bmkt').filter(has_text="讓分")
    assert "熱火" in handicap.inner_text() and f"−{expected_line}" in handicap.inner_text()

    page.screenshot(path=str(OUT / "nba-three-source.png"), full_page=True)
    assert not errors, errors
    browser.close()
