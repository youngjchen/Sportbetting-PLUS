# Phase 0 探針①主體＋④＋⑥：單場頁三市場 Stake 覆蓋率＋AH 劃線死組＋（--hover）浮窗時戳挖掘
# 用法: python op_phase0_match.py <match_url> <league_label> [--hover]
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from scrapling.fetchers import StealthyFetcher

URL, LABEL = sys.argv[1], sys.argv[2]
DO_HOVER = "--hover" in sys.argv
RESULT = {"url": URL, "league": LABEL, "markets": {}, "ah_strike": None, "hover": None, "xhr_tail": []}
XHRS = []

JS_CLICK_TAB = """
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
() => {
  const cs = [...document.querySelectorAll('[data-testid$="collapsed-row"]')];
  cs.forEach(c => { try { c.click(); } catch(e){} });
  return cs.length;
}
"""
JS_HARVEST = """
() => {
  const out = []; let line = null;
  const walk = document.querySelectorAll('[data-testid$="collapsed-row"],[data-testid$="expanded-row"]');
  walk.forEach(el => {
    const tid = el.getAttribute('data-testid') || '';
    if (tid.endsWith('collapsed-row')) {
      const t = el.textContent.replace(/\\s+/g,' ').trim();
      const m = t.match(/(Over\\/Under|Asian Handicap)\\s*([+-]?\\d+(?:\\.\\d+)?)/);
      line = m ? m[2] : (t.split(' ')[0] || null);
      return;
    }
    const nm = el.querySelector('[data-testid*="bookmaker-name"]');
    if (!nm) return;
    const vals = [];
    let struck = false;
    el.querySelectorAll('p,span,a,div').forEach(e => {
      if (e.children.length) return;
      const t = (e.textContent||'').trim();
      if (/^[+-]?\\d+(\\.\\d+)?$/.test(t) && t.length <= 6) {
        vals.push(t);
        const cs = getComputedStyle(e);
        if (/line-through/.test(cs.textDecorationLine || cs.textDecoration || '')) struck = true;
        let p = e.parentElement;
        for (let i = 0; i < 3 && p; i++) {
          if (p.tagName === 'S' || p.tagName === 'DEL') struck = true;
          const pcs = getComputedStyle(p);
          if (/line-through/.test(pcs.textDecorationLine || '')) struck = true;
          p = p.parentElement;
        }
      }
    });
    out.push({ book: nm.textContent.trim(), line, odds: vals, struck });
  });
  return out;
}
"""
JS_LDJSON = """
() => {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent) } catch(e){ return null } }).filter(Boolean).flat();
  const ev = ld.find(o => o && (o['@type']==='SportsEvent' || o['@type']==='Event'));
  return ev ? { name: ev.name, start: ev.startDate } : null;
}
"""
JS_MARK = """
() => {
  const rows = [...document.querySelectorAll('div[data-testid$="-row"]')];
  for (const el of rows) {
    const nm = el.querySelector('[data-testid*="bookmaker-name"]');
    if (!nm || !/stake/i.test(nm.textContent)) continue;
    const cells = [...el.querySelectorAll('p,span,a,div')]
      .filter(e => !e.children.length && /^[+-]?\\d+(\\.\\d+)?$/.test((e.textContent||'').trim()));
    if (!cells.length) continue;
    const t = cells[cells.length - 1];
    t.id = 'pp_target';
    const r = t.getBoundingClientRect();
    return { ok: true, x: r.x + r.width/2, y: r.y + r.height/2, txt: t.textContent.trim(), cells: cells.length };
  }
  return { ok: false };
}
"""
JS_TIMEY = """
() => {
  const rx = /(\\d{1,2}\\s+[A-Z][a-z]{2}[,.]?\\s*\\d{0,4}.{0,14}\\d{1,2}:\\d{2})|(\\d{1,2}:\\d{2}\\s*(AM|PM)?)/;
  const hits = [];
  document.querySelectorAll('body *').forEach(e => {
    if (e.children.length) return;
    const t = (e.textContent||'').trim();
    if (!t || t.length > 70) return;
    if (/opening odds/i.test(t) || rx.test(t)) hits.push(t);
  });
  return hits;
}
"""

def act(page):
    page.on("response", lambda r: XHRS.append(r.url[:160]))
    page.wait_for_timeout(3500)
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); page.wait_for_timeout(1200)
    except Exception: pass
    page.wait_for_timeout(5000)
    RESULT["ldjson"] = page.evaluate(JS_LDJSON)
    for label, tab in [("ml", "Home/Away"), ("ou", "Over/Under"), ("ah", "Asian Handicap")]:
        r = page.evaluate(JS_CLICK_TAB, tab)
        page.wait_for_timeout(5000)
        n = page.evaluate(JS_EXPAND)
        page.wait_for_timeout(4000)
        rows = page.evaluate(JS_HARVEST)
        books = sorted(set(x["book"] for x in rows))
        st = [x for x in rows if "stake" in x["book"].lower()]
        RESULT["markets"][label] = {"tab": r, "groups": n, "total_rows": len(rows),
                                    "n_books": len(books), "stake": st,
                                    "books_sample": books[:18]}
        print(f"  [{LABEL}/{label}] tab={r} 組={n} 列={len(rows)} 書商={len(books)} Stake={len(st)} {[ (s['line'], s['odds'][:3], 'STRUCK' if s['struck'] else '') for s in st ]}", flush=True)
        if label == "ah":
            RESULT["ah_strike"] = [x for x in rows if x["struck"]][:6]
        if label == "ml" and DO_HOVER:
            mark = page.evaluate(JS_MARK)
            RESULT["hover"] = {"mark": mark}
            if mark.get("ok"):
                before = page.evaluate(JS_TIMEY)
                n_xhr_before = len(XHRS)
                try:
                    page.hover("#pp_target", timeout=6000)
                except Exception as e:
                    try:
                        page.mouse.move(mark["x"], mark["y"]); page.wait_for_timeout(300)
                        page.mouse.move(mark["x"] + 1, mark["y"] + 1)
                    except Exception as e2:
                        RESULT["hover"]["err"] = f"{e} / {e2}"
                page.wait_for_timeout(1600)
                after = page.evaluate(JS_TIMEY)
                new = [t for t in after if t not in before]
                RESULT["hover"]["new_time_texts"] = new[:40]
                RESULT["hover"]["xhr_during"] = XHRS[n_xhr_before:][:12]
                print(f"  [hover] 目標={mark.get('txt')} 新增含時間文字={len(new)} hover期間XHR={len(XHRS)-n_xhr_before}", flush=True)
                for t in new[:14]: print("     ·", t, flush=True)
    return page

page = StealthyFetcher.fetch(URL, headless=True, real_chrome=True, network_idle=True,
                             locale="zh-TW", timezone_id="Asia/Taipei", timeout=220000, page_action=act)
RESULT["xhr_tail"] = [u for u in XHRS if any(k in u.lower() for k in ("feed", "odds", "match", "event", "ajax", "api"))][-15:]
out = rf"C:\Users\User\Downloads\Sportbetting-PLUS\stake_lab\op_phase0_{LABEL}.json"
json.dump(RESULT, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("已存", out)
