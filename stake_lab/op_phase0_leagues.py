# Phase 0 探針①前置＋③：四聯盟列表頁發現（ld+json＋比賽連結）＋ robots.txt
# 訪客、零帳號、每頁一次。輸出 op_phase0_leagues.json
import json, re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from scrapling.fetchers import StealthyFetcher

OUT = {}
COMMON = dict(headless=True, real_chrome=True, network_idle=True,
              locale="zh-TW", timezone_id="Asia/Taipei", timeout=220000)

JS_LEAGUE = """
() => {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent) } catch(e){ return null } }).filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));
  const evs = ld.filter(o => o && /Event/i.test(String(o['@type'])));
  const links = [...new Set([...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
    .filter(h => h && /^\\/baseball\\/[a-z-]+\\/[a-z0-9-]+\\/[a-z0-9-]+-[A-Za-z0-9]{6,10}\\/$/.test(h))
    .filter(h => !/results|standings|outrights/.test(h)))];
  return { title: document.title,
           nLd: evs.length,
           evs: evs.slice(0, 20).map(e => ({ n: e.name, d: e.startDate, u: e.url })),
           links: links.slice(0, 20) };
}
"""

HOLD = {}   # page_action 的回傳不會跟著 fetch 回來，一律寫全域（op_stake_final 既有模式）

def league_act(page):
    page.wait_for_timeout(3500)
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); page.wait_for_timeout(1200)
    except Exception: pass
    for _ in range(3):
        page.evaluate("() => window.scrollBy(0, 1600)")
        page.wait_for_timeout(900)
    page.wait_for_timeout(2500)
    HOLD["cur"] = page.evaluate(JS_LEAGUE)
    return page

def robots_act(page):
    page.wait_for_timeout(2500)
    HOLD["cur"] = page.evaluate("() => document.body ? document.body.innerText.slice(0, 2500) : ''")
    return page

# robots.txt（用同一個瀏覽器管道，避免純 HTTP 被 TLS 攔截干擾）
try:
    HOLD.pop("cur", None)
    StealthyFetcher.fetch("https://www.oddsportal.com/robots.txt", page_action=robots_act, **COMMON)
    OUT["robots"] = HOLD.get("cur") or "(empty)"
except Exception as e:
    OUT["robots"] = "ERR: " + str(e)
print("[robots] 取得", len(OUT["robots"]), "字", flush=True)

LEAGUES = [
    ("mlb",  ["https://www.oddsportal.com/baseball/usa/mlb/"]),
    ("npb",  ["https://www.oddsportal.com/baseball/japan/npb/"]),
    ("kbo",  ["https://www.oddsportal.com/baseball/south-korea/kbo/",
              "https://www.oddsportal.com/baseball/south-korea/kbo-league/"]),
    ("cpbl", ["https://www.oddsportal.com/baseball/taiwan/cpbl/",
              "https://www.oddsportal.com/baseball/taiwan/"]),
]
for key, urls in LEAGUES:
    got = None
    for u in urls:
        try:
            HOLD.pop("cur", None)
            StealthyFetcher.fetch(u, page_action=league_act, **COMMON)
            d = HOLD.get("cur")
            if d and (d.get("nLd") or d.get("links")):
                got = {"url": u, **d}; break
            got = got or {"url": u, **(d or {"title": "(no data)", "nLd": 0, "evs": [], "links": []})}
        except Exception as e:
            got = got or {"url": u, "err": str(e)}
    OUT[key] = got
    print(f"[{key}] {got.get('url')}  ld+json={got.get('nLd')}  連結={len(got.get('links', []))}  title={str(got.get('title'))[:60]}", flush=True)

json.dump(OUT, open(r"C:\Users\User\Downloads\Sportbetting-PLUS\stake_lab\op_phase0_leagues.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("已存 op_phase0_leagues.json")
