import os

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("SBP_TEST_BASE_URL", "http://127.0.0.1:8765")


def exercise(page, path):
    # 這個 PWA 有持續輪詢，networkidle 永遠不會成立；等自動雲端還原的單次 reload 完成即可。
    page.goto(f"{BASE_URL}/{path}", wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    assert page.evaluate("typeof window.__boardKeyboardNavigationController === 'object'"), (
        f"{path} 尚未載入共用方向鍵導航"
    )

    dates = page.locator("#datebar .datechip:not(.adddate), #datebar .dbtn")
    date_count = dates.evaluate_all("els => els.filter(el => !el.textContent.trim().startsWith('＋')).length")
    assert date_count >= 2, f"{path} 至少需要兩個日期才能驗證左右鍵"
    active_selector = "#datebar .datechip.active, #datebar .dbtn.on"
    before = page.locator(active_selector).first.get_attribute("title") or page.locator(active_selector).first.inner_text()
    active_index = page.locator("#datebar .datechip, #datebar .dbtn").evaluate_all(
        "els => els.filter(el => !el.textContent.trim().startsWith('＋')).findIndex(el => el.classList.contains('active') || el.classList.contains('on'))"
    )
    key = "ArrowRight" if active_index < date_count - 1 else "ArrowLeft"
    page.keyboard.press(key)
    after = page.locator(active_selector).first.get_attribute("title") or page.locator(active_selector).first.inner_text()
    assert after != before, f"{path} 的 {key} 沒有切換日期"

    card_found = False
    for index in range(dates.count()):
        dates = page.locator("#datebar .datechip:not(.adddate), #datebar .dbtn")
        button = dates.nth(index)
        if button.inner_text().strip().startswith("＋"):
            continue
        button.click()
        page.wait_for_timeout(50)
        if page.locator(".card.bcard[data-id]").count():
            card_found = True
            break
    assert card_found, f"{path} 找不到可驗證的比賽卡片"
    page.keyboard.press("ArrowDown")
    assert page.locator(".card.bcard.kbd-focus[data-id]").count() == 1, f"{path} 的向下鍵沒有切換卡片"


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.route(
            "**/*",
            lambda route: route.continue_() if route.request.url.startswith(BASE_URL) else route.abort(),
        )
        for path in ("index.html", "nba.html", "nhl.html"):
            exercise(page, path)
        browser.close()
    print("keyboard navigation: baseball, basketball, hockey all passed")


if __name__ == "__main__":
    main()
