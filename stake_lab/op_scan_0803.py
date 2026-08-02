# 8/3 MLB 全場讓分對調 DOM 檢查（一次性、唯讀、不動 watch_state）
# 依據＝使用者鐵則：對調的有力證據＝劃線死組（strikethrough）在現讓分方的對側
import json, sys, datetime
from op_watch import visit_game, hd_fav, load_state, now, iso, log

DATE = sys.argv[1] if len(sys.argv) > 1 else "2026-08-03"
LG = sys.argv[2] if len(sys.argv) > 2 else "mlb"
st = load_state()
targets = sorted([(h, g) for h, g in st["games"].items()
                  if g["league"] == LG and g.get("dateTW") == DATE],
                 key=lambda kv: kv[1]["startISO"])
print(f"=== {DATE} {LG.upper()} 共 {len(targets)} 場 ===", flush=True)
out = []
for h, g in targets:
    nm = f'{(g.get("awayZh") or g["awayEn"])}@{(g.get("homeZh") or g["homeEn"])}'
    V = visit_game(g["url"], h, "watch", [])
    ah = V["markets"].get("ah", [])          # Stake 的 AH 列
    allah = V.get("_allAh") or []            # 全書商 AH 列
    fav, mode, ev = hd_fav(ah)
    dead = [s for s in ah if s["struck"]]
    live = [s for s in ah if not s["struck"]]
    dead_sides = set()
    for d in dead:
        try: dead_sides.add("home" if float(d["line"]) < 0 else "away")
        except Exception: pass
    swap = bool(fav and (("home" in dead_sides and fav == "away") or ("away" in dead_sides and fav == "home")))
    if V.get("err"):        verdict = "✗ 抓取失敗:" + str(V["err"])[:30]
    elif not ah:            verdict = "讓分未開盤/無Stake"
    elif swap:              verdict = "⇄ 對調痕跡"
    elif dead:              verdict = "死組同側=梯子修剪"
    else:                   verdict = "無死組"
    b365 = [r for r in allah if "bet365" in r["book"].lower() and not r["struck"]]
    rec = {"game": nm, "start": g["startISO"][11:16], "verdict": verdict, "fav": fav, "mode": mode,
           "live": [{"line": s["line"], "odds": s["odds"][:3]} for s in live],
           "dead": [{"line": s["line"], "odds": s["odds"][:3]} for s in dead],
           "bet365": [{"line": r["line"], "odds": r["odds"][:3]} for r in b365][:3],
           "checkedAt": iso(now()), "url": g["url"]}
    out.append(rec)
    print(f'  {g["startISO"][11:16]} {nm:16} {verdict:14} 活線={[s["line"] for s in live]} 死組={[s["line"] for s in dead]}', flush=True)
json.dump(out, open(f"op_scan_{DATE}_{LG}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
sw = [r for r in out if "對調" in r["verdict"]]
print(f'\n=== 結論：{len(targets)} 場中 {len(sw)} 場有對調痕跡 ===')
for r in sw: print(f'  ⇄ {r["game"]} 現讓分方={r["fav"]} 活線={[x["line"] for x in r["live"]]} 死組={[x["line"] for x in r["dead"]]}')
print("已存 op_scan_" + DATE + "_" + LG + ".json")
