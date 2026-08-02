import json, sys
from op_watch import COMMON, JS_CLICK_TAB, JS_EXPAND, JS_HARVEST, JS_WHOAMI, hd_fav, load_state, HOLD
from scrapling.fetchers import StealthyFetcher
st = load_state()
names = ["紅雀", "響尾蛇", "紅襪"]
targets = [(h, g) for h, g in st["games"].items()
           if g.get("dateTW") == "2026-08-03" and g["league"] == "mlb"
           and any(n in (g.get("awayZh") or "") for n in names)]
def mk(want):
    def act(page):
        page.wait_for_timeout(3500)
        try:
            b = page.query_selector("#onetrust-reject-all-handler")
            if b: b.click(timeout=4000); page.wait_for_timeout(1500)
        except Exception: pass
        page.wait_for_timeout(6000)
        who = page.evaluate(JS_WHOAMI)
        HOLD["landed_before"] = who.get("url", "")
        for attempt in range(3):
            if want in (who.get("url") or ""): break
            page.evaluate(r"""(h) => { const a=[...document.querySelectorAll('a[href]')].find(x=>(x.getAttribute('href')||'').includes('#'+h)); if(a){a.click(); return true} return false }""", want)
            page.wait_for_timeout(5000)
            who = page.evaluate(JS_WHOAMI)
        HOLD["landed"] = who.get("url", ""); HOLD["header"] = who.get("header")
        page.evaluate(JS_CLICK_TAB, "Asian Handicap"); page.wait_for_timeout(5000)
        page.evaluate(JS_EXPAND); page.wait_for_timeout(3500)
        HOLD["rows"] = page.evaluate(JS_HARVEST)
        return page
    return act
out = []
for h, g in targets:
    nm = f'{g.get("awayZh")}@{g.get("homeZh")}'
    HOLD.clear()
    try:
        StealthyFetcher.fetch(g["url"], page_action=mk(h), **COMMON)
    except Exception as e:
        print(f"{nm}: 例外 {str(e)[:90]}"); continue
    rows = HOLD.get("rows", [])
    ah = [r for r in rows if "stake" in (r.get("book") or "").lower()]
    fav, mode, ev = hd_fav(ah)
    dead = [s for s in ah if s["struck"]]; live = [s for s in ah if not s["struck"]]
    ds = set()
    for d in dead:
        try: ds.add("home" if float(d["line"]) < 0 else "away")
        except Exception: pass
    swap = bool(fav and (("home" in ds and fav == "away") or ("away" in ds and fav == "home")))
    v = "⇄ 對調痕跡" if swap else ("死組同側" if dead else ("無死組" if ah else "無Stake讓分"))
    hit = h in (HOLD.get("landed") or "")
    print(f'{nm:14} 目標#{h} 落在{"✅正確" if hit else "❌"+str(HOLD.get("landed",""))[-14:]}  {v}  活線={[s["line"] for s in live]} 死組={[s["line"] for s in dead]}')
    out.append({"game": nm, "hash_ok": hit, "verdict": v, "header": HOLD.get("header"),
                "live": [{"line": s["line"], "odds": s["odds"][:3]} for s in live],
                "dead": [{"line": s["line"], "odds": s["odds"][:3]} for s in dead]})
json.dump(out, open("op_scan_0803_retry.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
