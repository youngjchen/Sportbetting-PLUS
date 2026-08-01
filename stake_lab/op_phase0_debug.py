import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from scrapling.fetchers import StealthyFetcher
HOLD = {}
JS = """
() => {
  const hrefs = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && h.includes('/baseball/'));
  const uniq = [...new Set(hrefs)];
  return {
    nScripts: document.querySelectorAll('script[type="application/ld+json"]').length,
    htmlHasLd: document.documentElement.outerHTML.includes('application/ld+json'),
    nA: hrefs.length,
    sample: uniq.slice(0, 25),
    rows: document.querySelectorAll('[data-testid]').length,
    testids: [...new Set([...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')))].slice(0, 25),
    bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)
  };
}
"""
def act(page):
    page.wait_for_timeout(3000)
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); page.wait_for_timeout(1200)
    except Exception: pass
    for _ in range(4):
        page.evaluate("() => window.scrollBy(0, 1500)")
        page.wait_for_timeout(800)
    page.wait_for_timeout(3000)
    HOLD["d"] = page.evaluate(JS)
    return page
StealthyFetcher.fetch("https://www.oddsportal.com/baseball/usa/mlb/", headless=True, real_chrome=True,
                      network_idle=True, locale="zh-TW", timezone_id="Asia/Taipei", timeout=220000, page_action=act)
print(json.dumps(HOLD.get("d"), ensure_ascii=False, indent=1))
