# 把 watch_state.json 收割結果匯出成板頁用的精簡檔 data/stake_odds.json
# 只輸出「已收割且通過斷言」的場；鍵=league|date|awayZh|homeZh（板上同款）
import json, os, sys, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from op_watch import load_state, now, iso

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_F = os.path.join(REPO, "data", "stake_odds.json")
KEEP_DAYS = 10

def main():
    st = load_state()
    out = {"updated": iso(now()), "games": {}}
    cut = (now() - datetime.timedelta(days=KEEP_DAYS)).date().isoformat()
    n_ok = n_swap = 0
    for h, g in st["games"].items():
        if g.get("dateTW", "") < cut: continue
        b = g.get("board") or {}
        has_odds = any(b.get(k) is not None for k in ("openOddsAway", "openOddsHome", "closeOddsAway", "closeOddsHome"))
        if not (g.get("harvested") and has_odds) and not g.get("latched"): continue
        # 污染標記的一律不輸出賠率（走地價絕不能進結算畫面）
        dirty = any(("live-widget" in a or "走地" in a or "match-switched" in a) for a in g.get("asserts", []))
        rec = {}
        if has_odds and not dirty:
            rec.update({"openAway": b.get("openOddsAway"), "openHome": b.get("openOddsHome"),
                        "closeAway": b.get("closeOddsAway"), "closeHome": b.get("closeOddsHome"),
                        "closeAt": b.get("closeAtAway") or b.get("closeAtHome")})
            n_ok += 1
        if g.get("latched"):
            rec["swapAt"] = g.get("swapAt"); n_swap += 1
        if not rec: continue
        rec["src"] = "oddsportal/stake"; rec["url"] = g.get("url")
        out["games"][g["gid"]] = rec
    os.makedirs(os.path.dirname(OUT_F), exist_ok=True)
    with open(OUT_F, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"匯出 {len(out['games'])} 場（賠率 {n_ok}、對調 {n_swap}）→ data/stake_odds.json")

if __name__ == "__main__":
    main()
