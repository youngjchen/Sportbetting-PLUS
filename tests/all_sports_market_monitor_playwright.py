import mimetypes
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-results"
OUT.mkdir(exist_ok=True)


def serve_local(route):
    relative = urlparse(route.request.url).path.lstrip('/') or 'index.html'
    target = (ROOT / relative).resolve()
    if ROOT not in target.parents and target != ROOT:
        route.abort()
        return
    if not target.is_file():
        route.fulfill(status=404, body='not found')
        return
    content_type = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
    route.fulfill(status=200, body=target.read_bytes(), content_type=content_type)


def prepare(page, storage_script):
    page.add_init_script(storage_script)
    page.route("https://raw.githubusercontent.com/**", lambda route: route.abort())
    page.route("http://sportbetting.local/**", serve_local)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-proxy-server"])

    basketball = browser.new_page(viewport={"width": 1440, "height": 1000})
    prepare(basketball, """
      localStorage.setItem('sportbetting_nba_doc_v1', JSON.stringify({
        v:1, activeDate:'2026-10-05', activeLeague:'WNBA', boards:{}, games:[]
      }));
    """)
    basketball.goto("http://sportbetting.local/nba.html")
    wnba_card = basketball.locator('[data-id="WNBA_20261005_自由_美夢_0200"]')
    wnba_card.wait_for(state="visible", timeout=15000)
    assert wnba_card.locator('.market-monitor.source-count-3').count() == 1
    assert wnba_card.locator('.intl-strip').count() == 0
    compact = wnba_card.locator('.market-monitor-head').inner_text()
    assert 'STAKE' in compact and 'BET365' in compact and '台彩' in compact
    assert '官網' not in compact and '唯讀' not in compact
    basketball.screenshot(path=str(OUT / 'market-monitor-wnba.png'), full_page=True)

    hockey = browser.new_page(viewport={"width": 1440, "height": 1000})
    prepare(hockey, """
      localStorage.setItem('sportbetting_nhl_doc_v1', JSON.stringify({
        v:1, activeDate:'2026-10-02', boards:{}, games:[]
      }));
    """)
    hockey.goto("http://sportbetting.local/nhl.html")
    nhl_card = hockey.locator('[data-id="NHL_20261002_飛人@魔鬼_0700"]')
    nhl_card.wait_for(state="visible", timeout=15000)
    assert nhl_card.locator('.market-monitor.source-count-2').count() == 1
    assert nhl_card.locator('.intl-strip').count() == 0
    compact = nhl_card.locator('.market-monitor-head').inner_text()
    assert 'STAKE' in compact and 'BET365' in compact and '台彩' not in compact
    assert '官網' not in compact
    nhl_card.locator('.market-monitor-head').click()
    assert nhl_card.locator('.market-monitor-details').is_visible()
    hockey.screenshot(path=str(OUT / 'market-monitor-nhl.png'), full_page=True)

    hockey.set_viewport_size({"width": 390, "height": 844})
    assert nhl_card.locator('.market-platform').first.evaluate("el => getComputedStyle(el).gridColumnStart") == '1'
    hockey.screenshot(path=str(OUT / 'market-monitor-nhl-mobile.png'), full_page=True)

    browser.close()
