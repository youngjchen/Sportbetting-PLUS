# ============================================================================
# op_b365_fill.py — titan 缺 bet365 讓分線時，用 OddsPortal 的 bet365 列補上
# ============================================================================
# 使用者指示（2026-08-02）：「如果TITAN那邊的BET365沒抓到賠率，直接用ODDS PORTAL的補上」
# 產出：data/b365_op_fill.json（獨立檔，供爬蟲 buildIntlState 併入；不直接改 intl_state）
#   { "updated": ISO, "games": { "<lg>|<date>|<away>|<home>": {
#        "line": -1.5, "side": "home"|"away", "home": 2.85, "away": 1.40,
#        "src": "oddsportal", "at": ISO, "url": ... } } }
# 語意（沿用 7/21 鎖定的鐵則）：OP 的 AH 線是「主隊基準」→ 線為負=主隊讓、正=主隊受讓。
#   side 直接寫「誰在讓」，與 titan 的 is 欄同語意（is=home 表示主隊讓）。
# 紀律：只補 titan 缺的場（不覆蓋 titan 既有值）；開賽後不補（走地污染）；
#   多條 AH 線時取 |線|最小的活線（主線）；劃線死組一律排除。
# ============================================================================
import json, os, sys, datetime
from op_watch import (visit_game, load_state, now, iso, TZ, log, LEAGUES)

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ROOT)
OUT_F = os.path.join(REPO, "data", "b365_op_fill.json")
INTL_F = os.path.join(REPO, "data", "intl_state.json")
MAX_FILL = int(os.environ.get("OPB_MAX", "6"))

def load_json(p, dflt):
    try:
        with open(p, encoding="utf-8") as f: return json.load(f)
    except Exception: return dflt

def main():
    intl = load_json(INTL_F, {"games": {}})
    out = load_json(OUT_F, {"updated": None, "games": {}})
    st = load_state()
    # titan 缺 bet365 讓分線、且尚未開賽的場 → 待補清單
    need = []
    for key, e in (intl.get("games") or {}).items():
        if e.get("is"): continue                      # titan 有值 → 不覆蓋
        lg, date, away, home = (key.split("|") + ["", "", "", ""])[:4]
        g = None
        for h, cand in st["games"].items():
            if cand["league"] != lg or cand.get("dateTW") != date: continue
            if (cand.get("awayZh") == away and cand.get("homeZh") == home):
                g = cand; break
        if not g:
            log(f"補 bet365：{key} 在 watch_state 找不到對應場次（跳過）"); continue
        try:
            if now() >= datetime.datetime.fromisoformat(g["startISO"]):
                continue                              # 已開賽 → 不補（走地污染）
        except Exception: continue
        need.append((key, g))
    log(f"補 bet365：待補 {len(need)} 場（上限 {MAX_FILL}）")
    filled = 0
    for key, g in need[:MAX_FILL]:
        V = visit_game(g["url"], g["hash"], "watch", [])
        if V.get("err"):
            log(f"  ✗ {key}: {V['err']}"); continue
        rows = V.get("_allAh") or []
        b365 = [r for r in rows if "bet365" in r["book"].lower() and not r["struck"] and len(r["odds"]) >= 3]
        if not b365:
            log(f"  · {key}: OP 上 bet365 無讓分列"); continue
        def absline(r):
            try: return abs(float(r["line"]))
            except Exception: return 99
        main_row = min(b365, key=absline)
        try:
            ln = float(main_row["line"])
            home_od, away_od = float(main_row["odds"][1]), float(main_row["odds"][2])
        except Exception:
            log(f"  ✗ {key}: 解析失敗 {main_row}"); continue
        rec = {"line": ln, "side": "home" if ln < 0 else "away",
               "il": abs(ln), "home": home_od, "away": away_od,
               "src": "oddsportal", "at": iso(now()), "url": g["url"]}
        out["games"][key] = rec
        filled += 1
        log(f"  ✓ {key}: bet365 {'主' if ln < 0 else '客'}讓{abs(ln)}  {home_od}/{away_od}")
    out["updated"] = iso(now())
    # 修剪 3 天前的
    cut = (now() - datetime.timedelta(days=3)).date().isoformat()
    for k in list(out["games"].keys()):
        d = k.split("|")[1] if "|" in k else ""
        if d and d < cut: del out["games"][k]
    os.makedirs(os.path.dirname(OUT_F), exist_ok=True)
    with open(OUT_F, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    log(f"補 bet365 完成：本輪 {filled} 場，檔內共 {len(out['games'])} 場 → {OUT_F}")

if __name__ == "__main__":
    main()
