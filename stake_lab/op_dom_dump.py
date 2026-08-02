# 單場 DOM 解剖：AH/OU 全部分組 × 全部博彩商（不只 Stake）＋劃線＋ld+json 主客
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from scrapling.fetchers import StealthyFetcher
URL = sys.argv[1]; WANT = sys.argv[2]
HOLD = {}
JS_TAB = open("_js_tab.js", encoding="utf-8").read() if False else """
(label) => {
  const hit = [...document.querySelectorAll('div,a,li,button,span,p')]
    .filter(e => e.children.length === 0 && e.textContent.trim() === label);
  for (const e of hit) { let n = e;
    for (let i = 0; i < 4 && n; i++) { const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { n.click(); return 'ok'; } n = n.parentElement; } }
  return 'notfound';
}
"""
JS_EXPAND = """
() => { const cs = [...document.querySelectorAll('[data-testid$="collapsed-row"]')];
        cs.forEach(c => { try { c.click(); } catch(e){} }); return cs.length; }
"""
JS_ALL = """
() => {
  const out = []; let line = null;
  document.querySelectorAll('[data-testid$="collapsed-row"],[data-testid$="expanded-row"]').forEach(el => {
    const tid = el.getAttribute('data-testid') || '';
    if (tid.endsWith('collapsed-row')) {
      const t = el.textContent.replace(/\s+/g,' ').trim();
      const m = t.match(/(Over\/Under|Asian Handicap)\s*([+-]?\d+(?:\.\d+)?)/);
      line = m ? m[2] : null;
      out.push({grp: line, raw: t.slice(0, 60)});
      return;
    }
    const nm = el.querySelector('[data-testid*="bookmaker-name"]');
    if (!nm) return;
    const vals = []; let struck = false;
    el.querySelectorAll('p,span,a,div').forEach(e => {
      if (e.children.length) return;
      const t = (e.textContent||'').trim();
      if (/^[+-]?\d+(\.\d+)?$/.test(t) && t.length <= 6) {
        vals.push(t);
        const cs = getComputedStyle(e);
        if (/line-through/.test(cs.textDecorationLine||'')) struck = true;
        let p = e.parentElement;
        for (let i = 0; i < 3 && p; i++) { if (p.tagName==='S'||p.tagName==='DEL'||/line-through/.test(getComputedStyle(p).textDecorationLine||'')) struck = true; p = p.parentElement; }
      }
    });
    out.push({book: nm.textContent.trim(), line, odds: vals, struck});
  });
  return out;
}
"""
JS_META = """
() => {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent) } catch(e){ return null } }).filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));
  const ev = ld.find(o => o && /Event/i.test(String(o['@type'])));
  const h1 = document.querySelector('h1');
  return { ldName: ev ? ev.name : null, ldStart: ev ? ev.startDate : null,
           header: h1 ? h1.innerText.replace(/\s+/g,' ').trim() : null, url: location.href };
}
"""
def act(page):
    page.wait_for_timeout(3200)
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); page.wait_for_timeout(1000)
    except Exception: pass
    page.wait_for_timeout(4500)
    meta = page.evaluate(JS_META)
    if WANT not in (meta.get("url") or ""):
        page.evaluate("""(h) => { const a=[...document.querySelectorAll('a[href]')].find(x=>(x.getAttribute('href')||'').includes('#'+h)); if(a){a.click(); return true} return false }""", WANT)
        page.wait_for_timeout(4000)
        meta = page.evaluate(JS_META)
    HOLD["meta"] = meta
    for label, tab in [("ml", "Home/Away"), ("ah", "Asian Handicap"), ("ou", "Over/Under")]:
        page.evaluate(JS_TAB, tab); page.wait_for_timeout(4200)
        page.evaluate(JS_EXPAND); page.wait_for_timeout(3200)
        HOLD[label] = page.evaluate(JS_ALL)
    return page
StealthyFetcher.fetch(URL, headless=True, real_chrome=True, network_idle=True,
                      locale="zh-TW", timezone_id="Asia/Taipei", timeout=240000, page_action=act)
json.dump(HOLD, open("op_dom_dump.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
m = HOLD.get("meta", {})
print("META:", json.dumps(m, ensure_ascii=False))
for lab in ["ml", "ah", "ou"]:
    rows = HOLD.get(lab, [])
    print(f"--- {lab}: {len(rows)} 列 ---")
    for r in rows:
        if "grp" in r: print(f"  [組 {r['grp']}] {r['raw']}")
        else: print(f"    {r['book'][:14]:14} 線={r['line']} 賠率={r['odds'][:3]} {'STRUCK' if r['struck'] else ''}")
