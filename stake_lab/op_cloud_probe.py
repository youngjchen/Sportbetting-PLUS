# Actions 可行性探針：datacenter IP + Linux patchright chromium 能不能完整跑一次收割
import os, json
os.environ.setdefault("OPW_REAL_CHROME", "0")
os.environ.setdefault("CI", "1")
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from op_watch import visit_game
URL = "https://www.oddsportal.com/baseball/h2h/chiba-lotte-marines-KKlHBnlo/nippon-ham-fighters-AyxT5jRb/#QBFHdnOF/"
V = visit_game(URL, "QBFHdnOF", "full", "all")
out = {
  "err": V.get("err"),
  "prematch_tab": V.get("prematch_tab"),
  "ml_stake": V["markets"].get("ml"),
  "ah_stake_lines": [s["line"] for s in V["markets"].get("ah", [])],
  "tips": {k: (len(v) if v else 0) for k, v in (V.get("tips") or {}).items()},
}
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(repo, "data", "op_actions_probe2.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False))
