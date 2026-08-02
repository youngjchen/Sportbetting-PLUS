# Actions 診斷探針 v2：頁面到底渲染了什麼？（book 名單、geo、consent 狀態）
import os, json, sys
os.environ.setdefault("OPW_REAL_CHROME", "0")
os.environ.setdefault("CI", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from op_watch import COMMON, JS_CLICK_TAB, JS_EXPAND, HOLD
from scrapling.fetchers import StealthyFetcher

URL = "https://www.oddsportal.com/baseball/h2h/chiba-lotte-marines-KKlHBnlo/nippon-ham-fighters-AyxT5jRb/#QBFHdnOF/"
XHRS = []
def act(page):
    page.on("response", lambda r: XHRS.append(r.url[:140]))
    page.wait_for_timeout(4000)
    clicked = None
    for sel in ["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler"]:
        try:
            b = page.query_selector(sel)
            if b: b.click(timeout=3000); clicked = sel; page.wait_for_timeout(1200); break
        except Exception: pass
    page.wait_for_timeout(6000)
    page.evaluate(JS_CLICK_TAB, "Home/Away"); page.wait_for_timeout(5000)
    HOLD["d"] = page.evaluate("""() => ({
      books: [...document.querySelectorAll('[data-testid*="bookmaker-name"]')].map(e => e.textContent.trim()).slice(0, 24),
      nRows: document.querySelectorAll('[data-testid$="-row"]').length,
      nTestids: document.querySelectorAll('[data-testid]').length,
      bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260),
      title: document.title
    })""")
    HOLD["d"]["consent_clicked"] = clicked
    return page
try:
    StealthyFetcher.fetch(URL, page_action=act, **COMMON)
except Exception as e:
    HOLD["d"] = {"fatal": str(e)[:200]}
d = HOLD.get("d", {})
d["geo_xhr"] = [u for u in XHRS if "geo=" in u][:3]
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(repo, "data", "op_actions_probe2.json"), "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=1)
print(json.dumps(d, ensure_ascii=False)[:600])
