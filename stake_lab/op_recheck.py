import json, os, sys
from scrapling.fetchers import StealthyFetcher
from op_watch import JS_CLICK_TAB, JS_EXPAND, JS_HARVEST
HOLD = {}
JS_LEAGUE = r"""() => ({
  rows: document.querySelectorAll('[data-testid="game-row"]').length,
  first: (document.querySelector('[data-testid="game-row"]')||{}).innerText?.replace(/\s+/g,' ').slice(0,80),
  oddsCount: (document.body.innerText.match(/\d\.\d{2}/g)||[]).length
})"""
def league_act(page):
    page.wait_for_timeout(3500)
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); page.wait_for_timeout(1500)
    except Exception: pass
    page.wait_for_timeout(7000)
    HOLD["league"] = page.evaluate(JS_LEAGUE)
    return page
def match_act(page):
    page.wait_for_timeout(3500)
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); page.wait_for_timeout(1500)
    except Exception: pass
    page.wait_for_timeout(7000)
    page.evaluate(JS_CLICK_TAB, "Home/Away"); page.wait_for_timeout(5000)
    page.evaluate(JS_EXPAND); page.wait_for_timeout(3000)
    rows = page.evaluate(JS_HARVEST)
    HOLD["match"] = {"books": [r["book"] for r in rows if r.get("book")][:20],
                     "nRows": len(rows),
                     "oddsCount": page.evaluate(r"""() => (document.body.innerText.match(/\d\.\d{2}/g)||[]).length""")}
    return page
C = dict(headless=True, real_chrome=True, network_idle=True, locale="zh-TW",
         timezone_id="Asia/Taipei", timeout=200000)
StealthyFetcher.fetch("https://www.oddsportal.com/baseball/usa/mlb/", page_action=league_act, **C)
print("聯盟頁:", json.dumps(HOLD.get("league"), ensure_ascii=False))
StealthyFetcher.fetch(sys.argv[1], page_action=match_act, **C)
m = HOLD.get("match", {})
print(f"單場頁: 列={m.get('nRows')} 賠率數字={m.get('oddsCount')} 書商={len(m.get('books',[]))}")
print("  書商名單:", "、".join(m.get("books", [])))
