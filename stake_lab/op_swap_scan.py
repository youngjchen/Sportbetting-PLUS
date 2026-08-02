# 一次性掃描：今天亞洲三聯盟全部場次的「對調痕跡」（Stake 死組在現讓分方對側）
# 唯讀，不動 watch_state（排程 sweep 擁有它）；結果存 op_swap_scan_<date>.json
import json, sys
from op_watch import visit_game, hd_fav, load_state, now

LG = sys.argv[1] if len(sys.argv) > 1 else None
st = load_state()
today = now().date().isoformat()
targets = sorted(
    [(h, g) for h, g in st["games"].items()
     if g["league"] in ("npb", "kbo", "cpbl") and g["startISO"][:10] == today
     and (LG is None or g["league"] == LG)],
    key=lambda kv: kv[1]["startISO"])
out = []
for h, g in targets:
    nm = f'{(g.get("awayZh") or g["awayEn"])}@{(g.get("homeZh") or g["homeEn"])}'
    V = visit_game(g["url"], h, "watch", "all")
    ah = V["markets"].get("ah", [])
    fav, mode, ev = hd_fav(ah)
    dead = [s for s in ah if s["struck"]]
    dead_givers = set()
    for d in dead:
        try: dead_givers.add("home" if float(d["line"]) < 0 else "away")
        except Exception: pass
    if not ah:
        verdict = "讓分未開盤"
    elif V.get("err"):
        verdict = "抓取失敗:" + str(V["err"])[:40]
    elif fav and (("home" in dead_givers and fav == "away") or ("away" in dead_givers and fav == "home")):
        verdict = "⇄ 對調痕跡"
    elif dead:
        verdict = "死組同側=梯子修剪"
    else:
        verdict = "無死組"
    rec = {"game": nm, "league": g["league"], "start": g["startISO"], "verdict": verdict,
           "fav": fav, "mode": mode, "ev": ev,
           "live": [{"line": s["line"], "odds": s["odds"][:3]} for s in ah if not s["struck"]],
           "dead": [{"line": s["line"], "odds": s["odds"][:3]} for s in dead]}
    out.append(rec)
    print(f'{g["league"]:4} {g["startISO"][11:16]} {nm:14} → {verdict}  活線={[s["line"] for s in ah if not s["struck"]]} 死組={[s["line"] for s in dead]}', flush=True)
json.dump(out, open(f"op_swap_scan_{today}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("已存 op_swap_scan_" + today + ".json")
