# 單場快照器 v1 —— OddsPortal 上的 Stake 三市場＋浮窗歷史（含時戳）＋讓分方判定
# 用法: python op_snapshot.py <match_url> <league> [--no-hover]
# 輸出: op_snap_<league>.json（v1 驗證期；正式版改依 matchHash 命名）
# 設計對應 2026-08-02 拍板：開盤/收盤各一次快照、收盤順帶回收全程波動（hover 歷史）、
# 對調盯哨另行輕量執行（賠率出現即開始、30分/次、抓到一次即閂鎖停盯）。
import json, re, sys, io, datetime
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from scrapling.fetchers import StealthyFetcher

URL, LEAGUE = sys.argv[1], sys.argv[2]
DO_HOVER = "--no-hover" not in sys.argv
NOW = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
SNAP = {"v": 1, "fetchedAt": NOW.isoformat(timespec="seconds"), "league": LEAGUE, "url": URL,
        "markets": {}, "hdFav": None, "hdFavMode": None, "histories": {}, "rawTooltips": {},
        "assertFail": []}

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
() => { const cs = [...document.querySelectorAll('[data-testid$="collapsed-row"]')];
        cs.forEach(c => { try { c.click(); } catch(e){} }); return cs.length; }
"""
JS_HARVEST = """
() => {
  const out = []; let line = null;
  document.querySelectorAll('[data-testid$="collapsed-row"],[data-testid$="expanded-row"]').forEach(el => {
    const tid = el.getAttribute('data-testid') || '';
    if (tid.endsWith('collapsed-row')) {
      const t = el.textContent.replace(/\\s+/g,' ').trim();
      const m = t.match(/(Over\\/Under|Asian Handicap)\\s*([+-]?\\d+(?:\\.\\d+)?)/);
      line = m ? m[2] : null; return;
    }
    const nm = el.querySelector('[data-testid*="bookmaker-name"]');
    if (!nm) return;
    const vals = []; let struck = false;
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
          if (/line-through/.test(getComputedStyle(p).textDecorationLine || '')) struck = true;
          p = p.parentElement;
        }
      }
    });
    out.push({ book: nm.textContent.trim(), line, odds: vals, struck });
  });
  return out;
}
"""
JS_MARK = """
(args) => {
  let line = null;
  const walk = document.querySelectorAll('[data-testid$="collapsed-row"],[data-testid$="expanded-row"]');
  for (const el of walk) {
    const tid = el.getAttribute('data-testid') || '';
    if (tid.endsWith('collapsed-row')) {
      const t = el.textContent.replace(/\\s+/g,' ').trim();
      const m = t.match(/(Over\\/Under|Asian Handicap)\\s*([+-]?\\d+(?:\\.\\d+)?)/);
      line = m ? m[2] : null; continue;
    }
    const nm = el.querySelector('[data-testid*="bookmaker-name"]');
    if (!nm || !/stake/i.test(nm.textContent)) continue;
    if (args.wantLine !== null && line !== args.wantLine) continue;
    const cells = [...el.querySelectorAll('p,span,a,div')]
      .filter(e => !e.children.length && /^[+-]?\\d+(\\.\\d+)?$/.test((e.textContent||'').trim()));
    if (cells.length <= args.cellIdx) continue;
    document.querySelectorAll('#pp_target').forEach(x => x.removeAttribute('id'));
    const t = cells[args.cellIdx];
    t.id = 'pp_target';
    t.scrollIntoView({block: 'center'});
    return { ok: true, txt: t.textContent.trim(), line };
  }
  return { ok: false };
}
"""
JS_TAG = "() => { document.querySelectorAll('body *').forEach(e => e.setAttribute('data-pp','1')); return true; }"
# 一次把同列多格都標好（hover 會在儲存格外包高亮層、破壞葉節點判定 → 第二格必須在任何 hover 前預標）
JS_MARK_MULTI = """
(args) => {
  let line = null;
  const walk = document.querySelectorAll('[data-testid$="collapsed-row"],[data-testid$="expanded-row"]');
  for (const el of walk) {
    const tid = el.getAttribute('data-testid') || '';
    if (tid.endsWith('collapsed-row')) {
      const t = el.textContent.replace(/\\s+/g,' ').trim();
      const m = t.match(/(Over\\/Under|Asian Handicap)\\s*([+-]?\\d+(?:\\.\\d+)?)/);
      line = m ? m[2] : null; continue;
    }
    const nm = el.querySelector('[data-testid*="bookmaker-name"]');
    if (!nm || !/stake/i.test(nm.textContent)) continue;
    if (args.wantLine !== null && line !== args.wantLine) continue;
    const cells = [...el.querySelectorAll('p,span,a,div')]
      .filter(e => !e.children.length && /^[+-]?\\d+(\\.\\d+)?$/.test((e.textContent||'').trim()));
    const got = [];
    args.idxs.forEach((ci, k) => {
      if (cells.length > ci) { cells[ci].id = 'pp_t' + k; got.push(ci); }
    });
    return { ok: got.length > 0, marked: got, nCells: cells.length };
  }
  return { ok: false };
}
"""
JS_WHOAMI = """
() => {
  const h1 = document.querySelector('h1');
  const hdr = h1 ? h1.innerText.replace(/\\s+/g,' ').trim() : null;
  let when = null;
  const rx = /\\d{1,2}\\s+[A-Z][a-z]{2,8}[\\s,]+\\d{4}|\\d{2}[./]\\d{2}[./]\\d{4}|Today|Tomorrow/;
  document.querySelectorAll('div,p,span').forEach(e => {
    if (when || e.children.length > 2) return;
    const t = (e.innerText||'').trim();
    if (t.length < 40 && rx.test(t) && /\\d{1,2}:\\d{2}/.test(t)) when = t;
  });
  return { header: hdr, when, url: location.href };
}
"""
JS_FRESH = """
() => {
  const fresh = [...document.querySelectorAll('body *:not([data-pp])')]
    .filter(e => !(e.closest && (e.closest('#onetrust-consent-sdk') || e.closest('[id*="onetrust"]'))));
  if (!fresh.length) return null;
  const roots = fresh.filter(e => !e.parentElement || e.parentElement.hasAttribute('data-pp'));
  const cand = roots.map(r => (r.innerText || '').trim()).filter(t => t.length > 5);
  // 優先挑真的浮窗（帶 ODDS MOVEMENT 或 時:分 樣式），而不是「最大的新節點」
  const good = cand.filter(t => /ODDS MOVEMENT/i.test(t) || /\\d{1,2}:\\d{2}/.test(t));
  const pool = good.length ? good : cand;
  pool.sort((a, b) => b.length - a.length);
  return pool[0] ? pool[0].slice(0, 6000) : null;
}
"""

def hover_harvest(page, key, want_line, cell_idx):
    mark = page.evaluate(JS_MARK, {"wantLine": want_line, "cellIdx": cell_idx})
    if not mark.get("ok"):
        SNAP["rawTooltips"][key] = None
        return
    page.evaluate(JS_TAG)
    try:
        page.hover("#pp_target", timeout=5000)
    except Exception:
        try:
            page.mouse.move(10, 10); page.wait_for_timeout(200)
            page.hover("#pp_target", timeout=5000)
        except Exception as e:
            SNAP["rawTooltips"][key] = "HOVER_FAIL: " + str(e)[:120]
            return
    page.wait_for_timeout(1400)
    tip = page.evaluate(JS_FRESH)
    if not tip or not re.search(r"ODDS MOVEMENT|\d{1,2}:\d{2}", tip):
        # 第一次沒撈到浮窗（常見：滑鼠剛好掃過其他浮層）→ 移開重來一次
        try:
            page.mouse.move(5, 5); page.wait_for_timeout(400)
            page.evaluate(JS_TAG)
            page.hover("#pp_target", timeout=5000)
            page.wait_for_timeout(1400)
            tip = page.evaluate(JS_FRESH) or tip
        except Exception: pass
    SNAP["rawTooltips"][key] = tip
    try:
        page.mouse.move(5, 5); page.wait_for_timeout(350)
    except Exception: pass

def hover_id(page, key, elem_id):
    page.evaluate(JS_TAG)
    try:
        page.hover("#" + elem_id, timeout=5000)
    except Exception as e:
        SNAP["rawTooltips"][key] = "HOVER_FAIL: " + str(e)[:120]
        return
    page.wait_for_timeout(1400)
    tip = page.evaluate(JS_FRESH)
    if not tip or not re.search(r"ODDS MOVEMENT|\d{1,2}:\d{2}", tip):
        try:
            page.mouse.move(5, 5); page.wait_for_timeout(400)
            page.evaluate(JS_TAG)
            page.hover("#" + elem_id, timeout=5000)
            page.wait_for_timeout(1400)
            tip = page.evaluate(JS_FRESH) or tip
        except Exception: pass
    SNAP["rawTooltips"][key] = tip
    try:
        page.mouse.move(5, 5); page.wait_for_timeout(350)
    except Exception: pass

def act(page):
    page.wait_for_timeout(3500)
    try:
        b = page.query_selector("#onetrust-reject-all-handler")
        if b: b.click(timeout=4000); page.wait_for_timeout(1200)
    except Exception: pass
    page.wait_for_timeout(5000)
    # 誰在畫面上？h2h 頁會自行改寫 fragment 挑別場（KBO/CPBL 實測）→ 記錄實際顯示場次；
    # 若與要求的 hash 不符，先試著點擊帶目標 hash 的連結切過去
    want = re.search(r"#([A-Za-z0-9]+)", URL)
    want_hash = want.group(1) if want else None
    who = page.evaluate(JS_WHOAMI)
    if want_hash and want_hash not in (who.get("url") or ""):
        try:
            page.evaluate("(h) => { const a = document.querySelector(`a[href*='#'+h]`.replace('+h', h)); if (a) a.click(); }", want_hash)
        except Exception: pass
        try:
            page.evaluate("""(h) => { const a = [...document.querySelectorAll('a[href]')].find(x => (x.getAttribute('href')||'').includes('#' + h)); if (a) { a.click(); return true; } return false; }""", want_hash)
            page.wait_for_timeout(4000)
        except Exception: pass
        who = page.evaluate(JS_WHOAMI)
    SNAP["displayed"] = who
    if want_hash and want_hash not in (who.get("url") or ""):
        SNAP["assertFail"].append(f"match-switched:要求#{want_hash} 實際={who.get('url','?')[-24:]}")
    for label, tab in [("ml", "Home/Away"), ("ou", "Over/Under"), ("ah", "Asian Handicap")]:
        r = page.evaluate(JS_CLICK_TAB, tab)
        page.wait_for_timeout(4500)
        n = page.evaluate(JS_EXPAND)
        page.wait_for_timeout(3500)
        rows = page.evaluate(JS_HARVEST)
        stake = [x for x in rows if "stake" in x["book"].lower()]
        SNAP["markets"][label] = {"tab": r, "groups": n, "n_books": len(set(x["book"] for x in rows)),
                                  "stake": stake,
                                  "bet365": [x for x in rows if "bet365" in x["book"].lower()]}
        print(f"  [{LEAGUE}/{label}] tab={r} Stake列={len(stake)}", flush=True)
        if not DO_HOVER: continue
        if label == "ml" and stake:
            mm = page.evaluate(JS_MARK_MULTI, {"wantLine": None, "idxs": [0, 1]})
            if mm.get("ok"):
                hover_id(page, "ml_home", "pp_t0")
                if 1 in mm.get("marked", []): hover_id(page, "ml_away", "pp_t1")
            else:
                SNAP["rawTooltips"]["ml_home"] = None
        if label == "ou" and stake:
            live = [s for s in stake if not s["struck"] and len(s["odds"]) >= 3]
            if live:
                main = min(live, key=lambda s: abs(float(s["odds"][1]) - float(s["odds"][2])))
                SNAP["markets"]["ou"]["main_line"] = main["line"]
                hover_harvest(page, "ou_main_over", main["line"], 1)
        if label == "ah" and stake:
            lines = {s["line"]: s for s in stake if not s["struck"]}
            if "-1.5" in lines: hover_harvest(page, "ah_home_-1.5", "-1.5", 1)
            if "+1.5" in lines: hover_harvest(page, "ah_away_-1.5", "+1.5", 2)
    return page

page = StealthyFetcher.fetch(URL, headless=True, real_chrome=True, network_idle=True,
                             locale="zh-TW", timezone_id="Asia/Taipei", timeout=240000, page_action=act)

# ---- 讓分方判定（雙模式）----
ah = SNAP["markets"].get("ah", {})
live = [s for s in ah.get("stake", []) if not s["struck"] and len(s["odds"]) >= 3]
lines = {s["line"]: s for s in live}
try:
    if "-1.5" in lines and "+1.5" in lines:
        h_give = float(lines["-1.5"]["odds"][1])   # 主讓1.5 的主隊賠率
        a_give = float(lines["+1.5"]["odds"][2])   # 客讓1.5（=主受讓組）的客隊賠率
        SNAP["hdFav"] = "home" if h_give < a_give else "away"
        SNAP["hdFavMode"] = f"ladder(h-1.5@{h_give} vs a-1.5@{a_give})"
    elif live:
        sgn = [float(s["line"]) for s in live]
        SNAP["hdFav"] = "home" if all(v < 0 for v in sgn) else ("away" if all(v > 0 for v in sgn) else None)
        SNAP["hdFavMode"] = "single-side(" + ",".join(s["line"] for s in live) + ")"
except Exception as e:
    SNAP["assertFail"].append("hdFav: " + str(e))

# ---- 浮窗解析（欄狀版式）：先一排時間、再一排賠率、再一排變化量，索引對齊 ----
# 首列常是「當前/開盤」摘要列（時間不在遞減序列裡）→ 標成 head 另存，不混進序列
def parse_tip(txt):
    if not txt or txt.startswith("HOVER_FAIL"): return None
    t = txt.replace(" ", " ")
    if not re.search(r"ODDS MOVEMENT|Opening odds", t, re.I): return {"n": 0, "points": [], "note": "非賠率浮窗"}
    times = re.findall(r"(\d{1,2}\s+[A-Z][a-z]{2}),?\s*(\d{1,2}:\d{2})", t)
    nums = re.findall(r"(?<![\d.,+:-])([+-]?\d+\.\d{2})(?![\d%])", t)
    vals = [o for o in nums if not (o.startswith("+") or o.startswith("-"))]   # 變化量帶號、賠率不帶
    def to_iso(md, hm):
        dt = datetime.datetime.strptime(f"{md} {NOW.year} {hm}", "%d %b %Y %H:%M").replace(tzinfo=NOW.tzinfo)
        if dt > NOW + datetime.timedelta(days=2): dt = dt.replace(year=NOW.year - 1)
        return dt
    pts, head = [], None
    try:
        stamps = [to_iso(md, hm) for md, hm in times]
        if len(stamps) >= 3 and stamps[1] > stamps[0]:      # 首列斷序=摘要列
            head = {"t": stamps[0].isoformat(timespec="minutes"), "o": float(vals[0]) if vals else None}
            stamps, vals = stamps[1:], vals[1:]
        n = min(len(stamps), len(vals))
        for i in range(n):
            pts.append({"t": stamps[i].isoformat(timespec="minutes"), "o": float(vals[i])})
    except Exception as e:
        return {"n": 0, "points": [], "err": str(e)[:120]}
    mono = all(pts[i]["t"] >= pts[i+1]["t"] for i in range(len(pts)-1)) if len(pts) > 1 else True
    m = re.search(r"Opening odds:?[\s\S]{0,40}?([+-]?\d+\.\d{2})", t)
    return {"n": len(pts), "points": pts, "head": head, "monotonic_desc": mono,
            "opening": m.group(1) if m else None}

for k, v in SNAP["rawTooltips"].items():
    SNAP["histories"][k] = parse_tip(v)

# ---- 斷言 ----
ml = SNAP["markets"].get("ml", {})
if not ml.get("stake"): SNAP["assertFail"].append("ml:無Stake列")
elif len([x for x in ml["stake"][0]["odds"] if 1.0 < float(x) < 30]) < 2: SNAP["assertFail"].append("ml:賠率異常")
for k, h in SNAP["histories"].items():
    if h is None: continue
    for p in h["points"]:
        if p["t"] > (NOW + datetime.timedelta(minutes=5)).isoformat(): SNAP["assertFail"].append(f"{k}:未來時戳{p['t']}"); break

out = rf"C:\Users\User\Downloads\Sportbetting-PLUS\stake_lab\op_snap_{LEAGUE}.json"
json.dump(SNAP, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
hist_sum = {k: (h["n"] if h else "×") for k, h in SNAP["histories"].items()}
print(f"[{LEAGUE}] hdFav={SNAP['hdFav']}({SNAP['hdFavMode']})  歷史點數={json.dumps(hist_sum, ensure_ascii=False)}  斷言失敗={SNAP['assertFail'] or '無'}")
print("已存", out)
