# ============================================================================
# op_watch.py — OddsPortal×Stake 盯哨工作流（sweep 模式，2026-08-02 首版）
# ============================================================================
# 使用者需求（8/2 拍板）：
#   ① 結算畫面的初盤/收盤賠率之後由本工作流供給（初盤=浮窗 Opening odds、收盤=浮窗最後一點）
#   ② 讓分對調：讓分盤出現即開始盯、30 分/次、抓到一次即閂鎖停盯、彈窗通知
#   ③ 全部資料存檔可複查
# 執行模式：Windows 工作排程器每 30 分呼叫 `python op_watch.py sweep`，跑完即退。
#   狀態全在 data/watch_state.json → 耐崩潰/睡眠/斷電，漏掃自動由下一輪補。
# 合規姿勢：只用瀏覽器渲染頁面（頁面自呼自家 API），永不直打 /feed/ /match-event/ 等內部端點。
# 資料紀律（titan 事故三陷阱的反面）：全部時戳 ISO+08:00、序列新→舊照浮窗原樣存但另存
#   derived 欄位、開賽後 10 分仍可收割但 close 只認 t ≤ 開賽+10min 的點、斷言失敗大聲寫入不靜默。
# 快照邏輯與 op_snapshot.py v1.1 同源（該檔保留為已驗證探針，本檔自帶一份以免互相牽動）。
# ============================================================================
import json, re, sys, io, os, datetime, subprocess, traceback
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
os.makedirs(DATA, exist_ok=True)
STATE_F = os.path.join(DATA, "watch_state.json")
ALERT_F = os.path.join(DATA, "alerts.log")
LOG_F = os.path.join(DATA, "watch_log.txt")
LOCK_F = os.path.join(DATA, "watch.lock")

TZ = datetime.timezone(datetime.timedelta(hours=8))
def now(): return datetime.datetime.now(TZ)
def iso(dt): return dt.isoformat(timespec="seconds")

MAX_VISITS = int(os.environ.get("OPW_MAX_VISITS", "8"))
WALL_CAP_MIN = 22
CHECK_GAP_MIN = 28          # 盯哨間隔（排程 30 分，留 2 分裕度）
SCHED_STALE_H = 3           # 賽程快取壽命
HARVEST_DELAY_MIN = 10      # 開賽後幾分鐘才收割
HARVEST_WINDOW_H = 9        # 開賽超過這麼久就放棄收割（標記 miss）

LEAGUES = {
    "mlb":  "https://www.oddsportal.com/baseball/usa/mlb/",
    "npb":  "https://www.oddsportal.com/baseball/japan/npb/",
    "kbo":  "https://www.oddsportal.com/baseball/south-korea/kbo/",
    "cpbl": "https://www.oddsportal.com/baseball/taiwan/cpbl/",
}
# OddsPortal 英文名 → 板上標準中文名（index.js LEAGUE_TEAMS 權威表）
TEAM_MAP = {
 # MLB
 "baltimore orioles":"金鶯","boston red sox":"紅襪","new york yankees":"洋基","tampa bay rays":"光芒",
 "toronto blue jays":"藍鳥","chicago white sox":"白襪","cleveland guardians":"守護者","detroit tigers":"老虎",
 "kansas city royals":"皇家","minnesota twins":"雙城","houston astros":"太空人","los angeles angels":"天使",
 "athletics":"運動家","oakland athletics":"運動家","seattle mariners":"水手","texas rangers":"遊騎兵",
 "atlanta braves":"勇士","miami marlins":"馬林魚","new york mets":"大都會","philadelphia phillies":"費城人",
 "washington nationals":"國民","chicago cubs":"小熊","cincinnati reds":"紅人","milwaukee brewers":"釀酒人",
 "pittsburgh pirates":"海盜","st.louis cardinals":"紅雀","st. louis cardinals":"紅雀","arizona diamondbacks":"響尾蛇",
 "colorado rockies":"落磯","los angeles dodgers":"道奇","san diego padres":"教士","san francisco giants":"巨人",
 # NPB
 "yomiuri giants":"讀賣巨人","hanshin tigers":"阪神虎","yokohama baystars":"橫濱DeNA","yokohama dena baystars":"橫濱DeNA",
 "hiroshima carp":"廣島鯉魚","hiroshima toyo carp":"廣島鯉魚","yakult swallows":"養樂多燕子","tokyo yakult swallows":"養樂多燕子",
 "chunichi dragons":"中日龍","fukuoka s. hawks":"軟銀鷹","fukuoka softbank hawks":"軟銀鷹","softbank hawks":"軟銀鷹",
 "nippon ham fighters":"日本火腿","hokkaido nippon-ham fighters":"日本火腿","chiba lotte marines":"羅德","lotte marines":"羅德",
 "rakuten gold. eagles":"樂天金鷲","rakuten golden eagles":"樂天金鷲","tohoku rakuten golden eagles":"樂天金鷲",
 "seibu lions":"西武獅","saitama seibu lions":"西武獅","orix buffaloes":"歐力士",
 # KBO
 "lg twins":"LG雙子","kt wiz suwon":"KT巫師","kt wiz":"KT巫師","ssg landers":"SSG登陸者","nc dinos":"NC恐龍",
 "doosan bears":"斗山熊","kia tigers":"起亞虎","lotte giants":"樂天巨人","samsung lions":"三星獅",
 "hanwha eagles":"韓華鷹","kiwoom heroes":"培證英雄",
 # CPBL
 "uni lions":"統一獅","uni-president lions":"統一獅","rakuten monkeys":"樂天桃猿","wei chuan dragons":"味全龍",
 "chinatrust brothers":"中信兄弟","ctbc brothers":"中信兄弟","fubon guardians":"富邦悍將","tsg hawks":"台鋼雄鷹",
}
def zh(name):
    return TEAM_MAP.get(re.sub(r"\s+", " ", str(name or "")).strip().lower())

def log(msg):
    line = f"[{iso(now())}] {msg}"
    print(line, flush=True)
    try:
        if os.path.exists(LOG_F) and os.path.getsize(LOG_F) > 2_000_000:
            os.replace(LOG_F, LOG_F + ".1")
        with open(LOG_F, "a", encoding="utf-8") as f: f.write(line + "\n")
    except Exception: pass

def alert(msg, popup=True):
    log("🔔 " + msg)
    try:
        with open(ALERT_F, "a", encoding="utf-8") as f: f.write(f"[{iso(now())}] {msg}\n")
    except Exception: pass
    if popup:
        try:
            import winsound
            winsound.Beep(1200, 250); winsound.Beep(900, 250); winsound.Beep(1200, 250)
        except Exception: pass
        try:
            safe = msg.replace("'", " ").replace('"', " ")
            subprocess.Popen(
                ["powershell", "-NoProfile", "-Command",
                 f"Add-Type -AssemblyName PresentationFramework;[System.Windows.MessageBox]::Show('{safe}','排盤板 對調警報')"],
                creationflags=0x00000008)
        except Exception as e:
            log("popup失敗:" + str(e)[:80])

def load_state():
    try:
        with open(STATE_F, encoding="utf-8") as f: return json.load(f)
    except Exception:
        return {"v": 1, "scheduleRefreshedAt": None, "games": {}}

def save_state(st):
    tmp = STATE_F + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_F)

# ---------------- 瀏覽器共用件（與 op_snapshot v1.1 同源） ----------------
from scrapling.fetchers import StealthyFetcher
COMMON = dict(headless=True, real_chrome=True, network_idle=True,
              locale="zh-TW", timezone_id="Asia/Taipei", timeout=240000)
HOLD = {}

JS_LEAGUE = """
() => {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent) } catch(e){ return null } }).filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));
  return ld.filter(o => o && /Event/i.test(String(o['@type'])))
           .map(e => ({ n: e.name, d: e.startDate, u: e.url }));
}
"""
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
JS_WHOAMI = """
() => {
  const h1 = document.querySelector('h1');
  return { header: h1 ? h1.innerText.replace(/\\s+/g,' ').trim() : null, url: location.href };
}
"""
JS_GOTO_HASH = """
(h) => { const a = [...document.querySelectorAll('a[href]')].find(x => (x.getAttribute('href')||'').includes('#' + h));
         if (a) { a.click(); return true; } return false; }
"""
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
    args.marks.forEach(mk => {
      if (cells.length > mk.idx) { cells[mk.idx].id = mk.id; got.push(mk.id); }
    });
    return { ok: got.length > 0, got };
  }
  return { ok: false };
}
"""
JS_TAG = "() => { document.querySelectorAll('body *').forEach(e => e.setAttribute('data-pp','1')); return true; }"
JS_FRESH = """
() => {
  const fresh = [...document.querySelectorAll('body *:not([data-pp])')]
    .filter(e => !(e.closest && (e.closest('#onetrust-consent-sdk') || e.closest('[id*="onetrust"]'))));
  if (!fresh.length) return null;
  const roots = fresh.filter(e => !e.parentElement || e.parentElement.hasAttribute('data-pp'));
  const cand = roots.map(r => (r.innerText || '').trim()).filter(t => t.length > 5);
  const good = cand.filter(t => /ODDS MOVEMENT/i.test(t) || /\\d{1,2}:\\d{2}/.test(t));
  const pool = good.length ? good : cand;
  pool.sort((a, b) => b.length - a.length);
  return pool[0] ? pool[0].slice(0, 6000) : null;
}
"""

def parse_tip(txt):
    if not txt or str(txt).startswith("HOVER_FAIL"): return None
    t = str(txt).replace(" ", " ")
    if not re.search(r"ODDS MOVEMENT|Opening odds", t, re.I): return {"n": 0, "points": [], "note": "非賠率浮窗"}
    times = re.findall(r"(\d{1,2}\s+[A-Z][a-z]{2}),?\s*(\d{1,2}:\d{2})", t)
    nums = re.findall(r"(?<![\d.,+:-])([+-]?\d+\.\d{2})(?![\d%])", t)
    vals = [o for o in nums if not (o.startswith("+") or o.startswith("-"))]
    def to_dt(md, hm):
        dt = datetime.datetime.strptime(f"{md} {now().year} {hm}", "%d %b %Y %H:%M").replace(tzinfo=TZ)
        if dt > now() + datetime.timedelta(days=2): dt = dt.replace(year=now().year - 1)
        return dt
    pts, head = [], None
    try:
        stamps = [to_dt(md, hm) for md, hm in times]
        if len(stamps) >= 3 and stamps[1] > stamps[0]:
            head = {"t": iso(stamps[0]), "o": float(vals[0]) if vals else None}
            stamps, vals = stamps[1:], vals[1:]
        n = min(len(stamps), len(vals))
        pts = [{"t": iso(stamps[i]), "o": float(vals[i])} for i in range(n)]
    except Exception as e:
        return {"n": 0, "points": [], "err": str(e)[:100]}
    m = re.search(r"Opening odds:?[\s\S]{0,40}?([+-]?\d+\.\d{2})", t)
    return {"n": len(pts), "points": pts, "head": head, "opening": float(m.group(1)) if m else None}

def hd_fav(ah_rows):
    """雙模式讓分方判定。回傳 (fav, mode, evidence)"""
    live = [s for s in ah_rows if not s["struck"] and len(s["odds"]) >= 3]
    lines = {s["line"]: s for s in live}
    try:
        if "-1.5" in lines and "+1.5" in lines:
            h = float(lines["-1.5"]["odds"][1]); a = float(lines["+1.5"]["odds"][2])
            return ("home" if h < a else "away", "ladder", f"h-1.5@{h} vs a-1.5@{a}")
        if live:
            sgn = [float(s["line"]) for s in live]
            if all(v < 0 for v in sgn): return ("home", "single", ",".join(s["line"] for s in live))
            if all(v > 0 for v in sgn): return ("away", "single", ",".join(s["line"] for s in live))
            return (None, "mixed", ",".join(s["line"] for s in live))
    except Exception as e:
        return (None, "err", str(e)[:80])
    return (None, "no-ah", "")

# ---------------- 瀏覽器訪問 ----------------
def fetch_league(lg):
    HOLD.pop("cur", None)
    def a(page):
        page.wait_for_timeout(3000)
        try:
            b = page.query_selector("#onetrust-reject-all-handler")
            if b: b.click(timeout=4000); page.wait_for_timeout(1000)
        except Exception: pass
        for _ in range(3):
            page.evaluate("() => window.scrollBy(0, 1600)"); page.wait_for_timeout(700)
        page.wait_for_timeout(2000)
        HOLD["cur"] = page.evaluate(JS_LEAGUE)
        return page
    StealthyFetcher.fetch(LEAGUES[lg], page_action=a, **COMMON)
    return HOLD.get("cur") or []

def visit_game(url, want_hash, mode, hover_keys):
    """mode='watch'（只 AH）或 'full'（三市場＋hover）。結果寫 HOLD['visit']"""
    HOLD["visit"] = {"who": None, "markets": {}, "tips": {}, "err": None}
    def a(page):
        V = HOLD["visit"]
        page.wait_for_timeout(3200)
        try:
            b = page.query_selector("#onetrust-reject-all-handler")
            if b: b.click(timeout=4000); page.wait_for_timeout(1000)
        except Exception: pass
        page.wait_for_timeout(4500)
        who = page.evaluate(JS_WHOAMI)
        if want_hash and want_hash not in (who.get("url") or ""):
            try:
                page.evaluate(JS_GOTO_HASH, want_hash); page.wait_for_timeout(4000)
            except Exception: pass
            who = page.evaluate(JS_WHOAMI)
        V["who"] = who
        if want_hash and want_hash not in (who.get("url") or ""):
            V["err"] = "match-switched"
            return page
        tabs = [("ah", "Asian Handicap")] if mode == "watch" else \
               [("ml", "Home/Away"), ("ou", "Over/Under"), ("ah", "Asian Handicap")]
        for label, tab in tabs:
            page.evaluate(JS_CLICK_TAB, tab); page.wait_for_timeout(4200)
            page.evaluate(JS_EXPAND); page.wait_for_timeout(3200)
            rows = page.evaluate(JS_HARVEST)
            V["markets"][label] = [x for x in rows if "stake" in x["book"].lower()]
            V.setdefault("b365", {})[label] = [x for x in rows if "bet365" in x["book"].lower()]
            if mode != "full": continue
            # hover 收割：ML 兩格；AH ±1.5 兩側；OU 主線兩側
            marks = []
            if label == "ml" and V["markets"]["ml"]:
                marks = [({"wantLine": None, "marks": [{"id": "pp_a", "idx": 0}, {"id": "pp_b", "idx": 1}]},
                          [("ml_home", "pp_a"), ("ml_away", "pp_b")])]
            if label == "ah" and V["markets"]["ah"]:
                Ls = {s["line"] for s in V["markets"]["ah"] if not s["struck"]}
                marks = []
                if "-1.5" in Ls: marks.append(({"wantLine": "-1.5", "marks": [{"id": "pp_c", "idx": 1}]}, [("ah_home-1.5", "pp_c")]))
                if "+1.5" in Ls: marks.append(({"wantLine": "+1.5", "marks": [{"id": "pp_d", "idx": 2}]}, [("ah_away-1.5", "pp_d")]))
                if not marks and V["markets"]["ah"]:
                    ln = V["markets"]["ah"][0]["line"]
                    marks = [({"wantLine": ln, "marks": [{"id": "pp_c", "idx": 1}, {"id": "pp_d", "idx": 2}]},
                              [(f"ah_h{ln}", "pp_c"), (f"ah_a{ln}", "pp_d")])]
            if label == "ou" and V["markets"]["ou"]:
                live = [s for s in V["markets"]["ou"] if not s["struck"] and len(s["odds"]) >= 3]
                if live:
                    mn = min(live, key=lambda s: abs(float(s["odds"][1]) - float(s["odds"][2])))
                    marks = [({"wantLine": mn["line"], "marks": [{"id": "pp_e", "idx": 1}, {"id": "pp_f", "idx": 2}]},
                              [(f"ou{mn['line']}_over", "pp_e"), (f"ou{mn['line']}_under", "pp_f")])]
            for margs, targets in marks:
                mm = page.evaluate(JS_MARK_MULTI, margs)
                if not mm.get("ok"): continue
                for key, eid in targets:
                    if key not in hover_keys and hover_keys != "all": continue
                    page.evaluate(JS_TAG)
                    try:
                        page.hover("#" + eid, timeout=5000)
                    except Exception:
                        continue
                    page.wait_for_timeout(1350)
                    tip = page.evaluate(JS_FRESH)
                    if not tip or not re.search(r"ODDS MOVEMENT|\d{1,2}:\d{2}", tip):
                        try:
                            page.mouse.move(5, 5); page.wait_for_timeout(350)
                            page.evaluate(JS_TAG)
                            page.hover("#" + eid, timeout=5000); page.wait_for_timeout(1350)
                            tip = page.evaluate(JS_FRESH) or tip
                        except Exception: pass
                    V["tips"][key] = tip
                    try: page.mouse.move(5, 5); page.wait_for_timeout(300)
                    except Exception: pass
        return page
    try:
        StealthyFetcher.fetch(url, page_action=a, **COMMON)
    except Exception as e:
        HOLD["visit"]["err"] = str(e)[:200]
    return HOLD["visit"]

# ---------------- 排程與比賽選擇 ----------------
def refresh_schedule(st):
    added = 0
    for lg in LEAGUES:
        try:
            evs = fetch_league(lg)
        except Exception as e:
            log(f"賽程 {lg} 失敗: {str(e)[:120]}"); continue
        for e in evs:
            try:
                t = datetime.datetime.fromisoformat(str(e["d"]).replace("Z", "+00:00")).astimezone(TZ)
            except Exception: continue
            if not (now() - datetime.timedelta(hours=HARVEST_WINDOW_H) <= t <= now() + datetime.timedelta(hours=26)):
                continue
            m = re.search(r"#([A-Za-z0-9]+)/?$", str(e["u"] or ""))
            if not m: continue
            h = m.group(1)
            if h in st["games"]:
                st["games"][h]["startISO"] = iso(t)     # 延賽改時間要跟上
                continue
            nm = str(e["n"] or ""); parts = [x.strip() for x in nm.split(" - ")]
            home_en, away_en = (parts[0], parts[1]) if len(parts) == 2 else (nm, "")
            g = {"hash": h, "league": lg, "url": str(e["u"]).split("#")[0] + "#" + h + "/",
                 "homeEn": home_en, "awayEn": away_en, "homeZh": zh(home_en), "awayZh": zh(away_en),
                 "startISO": iso(t), "found": iso(now()),
                 "checks": [], "ahSeen": None, "hdFav": None, "latched": False,
                 "open": None, "close": None, "harvested": False, "asserts": []}
            g["dateTW"] = iso(t)[:10]
            g["gid"] = f'{lg}|{g["dateTW"]}|{g["awayZh"] or away_en}|{g["homeZh"] or home_en}'
            if not g["homeZh"] or not g["awayZh"]:
                g["asserts"].append(f"隊名映射失敗: {away_en}/{home_en}")
                log(f"⚠ 映射失敗 {lg} {away_en}@{home_en}")
            st["games"][h] = g; added += 1
    st["scheduleRefreshedAt"] = iso(now())
    log(f"賽程更新：新增 {added} 場，庫存 {len(st['games'])} 場")

def due_actions(st):
    harvests, watches = [], []
    for h, g in st["games"].items():
        try:
            t0 = datetime.datetime.fromisoformat(g["startISO"])
        except Exception: continue
        mins = (now() - t0).total_seconds() / 60
        if g.get("harvested"):
            continue
        if mins >= HARVEST_DELAY_MIN:
            if g.get("deferUntil") and now() < datetime.datetime.fromisoformat(g["deferUntil"]):
                continue
            if mins <= HARVEST_WINDOW_H * 60:
                harvests.append((mins, h))
            else:
                g["harvested"] = True; g["asserts"].append("harvest-missed")
            continue
        if g.get("latched"):        # 已抓到對調 → 停盯（但收割仍會做，上面分支）
            continue
        last = g["checks"][-1]["t"] if g.get("checks") else None
        if last and (now() - datetime.datetime.fromisoformat(last)).total_seconds() < CHECK_GAP_MIN * 60:
            continue
        watches.append(((t0 - now()).total_seconds(), h))
    harvests.sort()                 # 開賽越久的越先收
    watches.sort()                  # 越接近開賽的越先盯
    return [("full", h) for _, h in harvests] + [("watch", h) for _, h in watches]

def derive_open_close(g, tips, start_dt):
    """初盤=浮窗 opening；收盤=t ≤ 開賽+10min 的最新一點。附斷言。"""
    H = {k: parse_tip(v) for k, v in tips.items()}
    g["histories"] = H
    limit = start_dt + datetime.timedelta(minutes=10)
    # ‼️ 走地浮窗守門（8/2 巨人場實錘）：開賽後頁面賠率區=走地市場，其浮窗歷史全是開賽後的點
    # （會把走地價當收盤寫進去）。判別法=浮窗至少要有一個「開賽前」的點才算賽前盤資料。
    def is_live_widget(key):
        hh = H.get(key)
        if not hh or not hh.get("points"): return False
        return not any(datetime.datetime.fromisoformat(p["t"]) < start_dt for p in hh["points"])
    def close_of(key):
        hh = H.get(key)
        if not hh or not hh.get("points") or is_live_widget(key): return None
        for p in hh["points"]:          # 新→舊
            if datetime.datetime.fromisoformat(p["t"]) <= limit: return p
        return None
    def open_of(key):
        hh = H.get(key)
        if not hh or is_live_widget(key): return None
        return hh.get("opening")
    board = {"openOddsHome": open_of("ml_home"), "openOddsAway": open_of("ml_away"),
             "closeOddsHome": (close_of("ml_home") or {}).get("o"),
             "closeOddsAway": (close_of("ml_away") or {}).get("o"),
             "closeAtHome": (close_of("ml_home") or {}).get("t"),
             "closeAtAway": (close_of("ml_away") or {}).get("t")}
    for k, v in [("openOddsHome", board["openOddsHome"]), ("openOddsAway", board["openOddsAway"]),
                 ("closeOddsHome", board["closeOddsHome"]), ("closeOddsAway", board["closeOddsAway"])]:
        if v is not None and not (1.01 < float(v) < 30): g["asserts"].append(f"{k} 值異常:{v}")
    if any(is_live_widget(k) for k in ("ml_home", "ml_away")):
        g["asserts"].append("live-widget(走地浮窗，賽後重收)")
    if board["closeOddsHome"] is None or board["closeOddsAway"] is None:
        g["asserts"].append("close 缺點(浮窗無 ≤開賽+10min 的點)")
    g["board"] = board

def do_visit(st, mode, h):
    g = st["games"][h]
    label = f'{g["league"]} {g.get("awayZh") or g["awayEn"]}@{g.get("homeZh") or g["homeEn"]}'
    V = visit_game(g["url"], h, mode, "all")
    if V.get("err"):
        g["asserts"].append(f"{mode}:{V['err']}")
        log(f"✗ {label} {mode} 失敗: {V['err']}"); return
    ah = V["markets"].get("ah", [])
    fav, fmode, ev = hd_fav(ah)
    # ‼️ 開賽後頁面讓分區重建為「走地線」（跟著戰況跑，實測 13:15 巨人場）→
    # 對調判定/hdFav 更新只准用賽前資料，開賽後的訪問只收割不判盤
    started = now() >= datetime.datetime.fromisoformat(g["startISO"])
    if started:
        fav = None
    entry = {"t": iso(now()), "fav": fav, "mode": fmode, "ev": ev,
             "dead": [{"line": s["line"], "odds": s["odds"][:3]} for s in ah if s["struck"]][:4]}
    b365ah = (V.get("b365", {}) or {}).get("ah", [])
    b365live = [x for x in b365ah if not x["struck"] and len(x["odds"]) >= 3]
    if b365live:
        try:
            sgn = [float(x["line"]) for x in b365live]
            entry["b365fav"] = "home" if all(v < 0 for v in sgn) else ("away" if all(v > 0 for v in sgn) else None)
            entry["b365"] = [{"line": x["line"], "odds": x["odds"][:3]} for x in b365live][:3]
        except Exception: pass
    g["checks"].append(entry)
    if ah and not g.get("ahSeen"): g["ahSeen"] = iso(now())
    prev = g.get("hdFav")
    if fav:
        # 對調偵測（閂鎖）：前後兩次盯到的讓分方不同、或畫面上有劃線死組在對側
        if prev and prev != fav and not g.get("latched"):
            g["latched"] = True; g["swapAt"] = iso(now())
            g["swapEvidence"] = {"before": prev, "after": fav, "mode": fmode, "ev": ev}
            alert(f"⇄ 對調：{label}（開賽 {g['startISO'][11:16]}）")   # 使用者規格：不判讓分方，方向自己在官網看
        g["hdFav"] = fav
        dead_sides = set()
        for d in entry["dead"]:
            try: dead_sides.add("home" if float(d["line"]) < 0 else "away")
            except Exception: pass
        if (("home" in dead_sides and fav == "away") or ("away" in dead_sides and fav == "home")) and not g.get("latched"):
            g["latched"] = True; g["swapAt"] = iso(now())
            g["swapEvidence"] = {"before": "劃線死組在對側", "after": fav, "mode": fmode, "ev": ev}
            alert(f"⇄ 對調：{label}（開賽 {g['startISO'][11:16]}）")
    if mode == "full":
        start_dt = datetime.datetime.fromisoformat(g["startISO"])
        g["closeSnapshot"] = {k: v for k, v in V["markets"].items()}
        derive_open_close(g, V.get("tips", {}), start_dt)
        g["harvested"] = True; g["harvestedAt"] = iso(now())
        # 收盤缺點/走地浮窗 → 重試；走地浮窗直接延到賽後（完賽頁會恢復賽前盤＋完整歷史）
        bad = [a for a in g["asserts"] if ("close 缺點" in a or "live-widget" in a)]
        if bad and g.get("harvestRetries", 0) < 3:
            g["harvestRetries"] = g.get("harvestRetries", 0) + 1
            g["harvested"] = False
            g["asserts"] = [a for a in g["asserts"] if a not in bad]
            if any("live-widget" in a for a in bad):
                g["deferUntil"] = iso(start_dt + datetime.timedelta(hours=4))
                log(f"  ↻ 走地浮窗，延到賽後重收（{g['deferUntil'][11:16]} 後）")
            else:
                log(f"  ↻ 收盤缺點，安排重試（第 {g['harvestRetries']} 次）")
        b = g.get("board", {})
        log(f"✓ 收割 {label}  初盤 {b.get('openOddsAway')}/{b.get('openOddsHome')} 收盤 {b.get('closeOddsAway')}/{b.get('closeOddsHome')}  斷言={g['asserts'] or '無'}")
    else:
        if not ah:
            log(f"· {label} 讓分未開盤（盯哨待命）")
        else:
            log(f"· 盯哨 {label} 讓分方={fav}({fmode}) {'⇄已閂鎖' if g.get('latched') else ''}")

def sweep():
    if os.path.exists(LOCK_F):
        try:
            age = (now() - datetime.datetime.fromisoformat(open(LOCK_F, encoding="utf-8").read().strip())).total_seconds()
            if age < 40 * 60:
                log("另一輪 sweep 進行中，跳過"); return
        except Exception: pass
    open(LOCK_F, "w", encoding="utf-8").write(iso(now()))
    t_start = now()
    try:
        st = load_state()
        stale = True
        if st.get("scheduleRefreshedAt"):
            stale = (now() - datetime.datetime.fromisoformat(st["scheduleRefreshedAt"])).total_seconds() > SCHED_STALE_H * 3600
        if stale:
            refresh_schedule(st); save_state(st)
        acts = due_actions(st)
        log(f"待辦：收割 {sum(1 for m, _ in acts if m == 'full')}、盯哨 {sum(1 for m, _ in acts if m == 'watch')}（上限 {MAX_VISITS} 訪問）")
        done = 0
        for mode, h in acts:
            if done >= MAX_VISITS: break
            if (now() - t_start).total_seconds() > WALL_CAP_MIN * 60:
                log("達本輪時間上限，收工"); break
            try:
                do_visit(st, mode, h)
            except Exception as e:
                st["games"][h]["asserts"].append(f"visit-crash:{str(e)[:100]}")
                log(f"✗ visit 例外 {h}: {str(e)[:150]}\n{traceback.format_exc()[-300:]}")
            done += 1
            save_state(st)
        log(f"本輪完成 {done} 訪問，用時 {int((now() - t_start).total_seconds())}s")
    finally:
        try: os.remove(LOCK_F)
        except Exception: pass

def status():
    st = load_state()
    print(f"賽程更新於 {st.get('scheduleRefreshedAt')}；庫存 {len(st['games'])} 場")
    for h, g in sorted(st["games"].items(), key=lambda kv: kv[1]["startISO"]):
        flag = "⇄對調!" if g.get("latched") else ("✓收割" if g.get("harvested") else ("盯:" + str(g.get("hdFav"))))
        print(f'  {g["startISO"][5:16]} {g["league"]:4} {(g.get("awayZh") or g["awayEn"])}@{(g.get("homeZh") or g["homeEn"])}: {flag} 查{len(g.get("checks", []))}次 {("⚠" + ";".join(g["asserts"])) if g.get("asserts") else ""}')

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "sweep"
    if cmd == "sweep": sweep()
    elif cmd == "status": status()
    else: print("用法: op_watch.py [sweep|status]")
