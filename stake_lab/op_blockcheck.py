# 封鎖檢查：真瀏覽器載入 OP 單場頁，看賠率在不在、有無 CF 挑戰
import json, sys
from op_watch import COMMON, JS_CLICK_TAB, JS_EXPAND, HOLD
from scrapling.fetchers import StealthyFetcher
URL = "https://www.oddsportal.com/baseball/h2h/chiba-lotte-marines-KKlHBnlo/nippon-ham-fighters-AyxT5jRb/#QBFHdnOF/"
def act(page):
    page.wait_for_timeout(3500)
    consent = None
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); consent = "rejected"; page.wait_for_timeout(1200)
    except Exception: pass
    page.wait_for_timeout(5000)
    page.evaluate(JS_CLICK_TAB, "Home/Away"); page.wait_for_timeout(4000)
    page.evaluate(JS_EXPAND); page.wait_for_timeout(2500)
    HOLD["d"] = page.evaluate("""() => ({
      title: document.title,
      books: [...document.querySelectorAll('[data-testid*="bookmaker-name"]')].map(e => e.textContent.trim()),
      nRows: document.querySelectorAll('[data-testid$="-row"]').length,
      cf: /just a moment|checking your browser|attention required|verify you are human/i.test(document.body.innerText),
      blocked: /access denied|blocked|forbidden|too many requests|rate limit/i.test(document.body.innerText),
      bodyHead: document.body.innerText.replace(/\s+/g,' ').slice(0, 200)
    })""")
    HOLD["d"]["consent"] = consent
    return page
try:
    StealthyFetcher.fetch(URL, page_action=act, **COMMON)
except Exception as e:
    HOLD["d"] = {"fatal": str(e)[:260]}
d = HOLD.get("d", {})
print(json.dumps({k: v for k, v in d.items() if k != "books"}, ensure_ascii=False, indent=1))
print("書商數:", len(d.get("books", [])), "｜含Stake:", any("stake" in b.lower() for b in d.get("books", [])))
print("名單:", "、".join(d.get("books", [])[:20]))
