"""初盤→收盤走向的可判讀性分析（獨贏／讓分／大小分）

問題：賠率從初盤走到收盤，這個「走向」有沒有預測力？哪些方向真的可判讀？

資料：data/oddsportal_archive/*.json（Stake 初盤/收盤）＋ BetExplorer 結果頁比分。
以 eventId 配對，日期偏移不影響本分析（不用日期做任何判斷）。

統計原則：
  · 每個假說都跟「盤口本身的隱含機率」比，不是跟 50% 比——盤口已經很準，
    贏過 50% 不代表有價值，要贏過盤口才有。
  · 一律附樣本數與雙尾檢定 p 值；p 只是門檻，同時看效果量（實際差幾個百分點）。
  · 多重比較：一次檢定很多方向，α=0.05 會有偽陽性，用 Bonferroni 校正後的門檻標示。
"""

from __future__ import annotations

import argparse
import glob
import json
import math
from collections import Counter, defaultdict


# ── 統計工具（不依賴 scipy）────────────────────────────────────────
def norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def binom_test(hits: int, n: int, p0: float) -> float:
    """雙尾常態近似（n 夠大時足夠）。回傳 p 值。"""
    if n <= 0 or p0 <= 0 or p0 >= 1:
        return 1.0
    se = math.sqrt(p0 * (1 - p0) / n)
    if se == 0:
        return 1.0
    z = (hits / n - p0) / se
    return 2 * (1 - norm_cdf(abs(z)))


def wilson(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = hits / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - half) / d, (c + half) / d)


def devig(odd_a: float, odd_b: float) -> float | None:
    """兩邊賠率 → 去除莊家抽水後的 a 方隱含機率。"""
    try:
        ia, ib = 1.0 / float(odd_a), 1.0 / float(odd_b)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    total = ia + ib
    return ia / total if total > 0 else None


# ── 資料 ──────────────────────────────────────────────────────────
def load_games(archive_dir: str, scores_path: str) -> list[dict]:
    scores = {k: tuple(v) for k, v in json.load(open(scores_path, encoding="utf-8")).items()}
    rows, seen = [], set()
    for path in sorted(glob.glob(f"{archive_dir}/*.json")):
        for game in json.load(open(path, encoding="utf-8")).get("games", {}).values():
            eid = game.get("eventId")
            if not eid or eid in seen or eid not in scores:
                continue
            seen.add(eid)                       # 同一場只取一筆（月檔間有重複條目）
            home_score, away_score = scores[eid]
            game = dict(game)
            game["homeScore"], game["awayScore"] = home_score, away_score
            rows.append(game)
    return rows


def market(game, name, phase):
    return ((game.get("markets") or {}).get(name) or {}).get(phase) or None


# ── 各市場的樣本建構 ──────────────────────────────────────────────
def ml_rows(games):
    """獨贏：需要初盤與收盤兩邊賠率＋比分。"""
    out = []
    for g in games:
        o, c = market(g, "ml", "open"), market(g, "ml", "close")
        if not o or not c:
            continue
        p_open = devig(o.get("home"), o.get("away"))
        p_close = devig(c.get("home"), c.get("away"))
        if p_open is None or p_close is None:
            continue
        if g["homeScore"] == g["awayScore"]:
            continue                            # 和局不列入
        out.append({"league": g["league"], "pOpen": p_open, "pClose": p_close,
                    "homeWin": g["homeScore"] > g["awayScore"],
                    "swap": bool((g.get("stakeSwap") or {}).get("ever"))})
    return out


def hd_rows(games):
    """讓分：以【讓分方】視角。line 是絕對值，favorite 指哪一邊讓。"""
    out = []
    for g in games:
        o, c = market(g, "hd", "open"), market(g, "hd", "close")
        if not o or not c:
            continue
        fav_open, fav_close = o.get("favorite"), c.get("favorite")
        line_open, line_close = o.get("line"), c.get("line")
        if fav_open not in ("home", "away") or line_open is None or line_close is None:
            continue
        # 讓分方賠率（該側）
        if fav_close == "home":
            odd_fav_c, odd_dog_c = c.get("home"), c.get("away")
        else:
            odd_fav_c, odd_dog_c = c.get("away"), c.get("home")
        if fav_open == "home":
            odd_fav_o, odd_dog_o = o.get("home"), o.get("away")
        else:
            odd_fav_o, odd_dog_o = o.get("away"), o.get("home")
        p_open = devig(odd_fav_o, odd_dog_o)
        p_close = devig(odd_fav_c, odd_dog_c)
        if p_open is None or p_close is None:
            continue
        # 2026-08-08 修正：月檔混了兩種慣例——BetExplorer 存絕對值、舊 OddsPortal 存帶號值
        # （-1.5 代表主隊讓）。直接拿 line 比會讓「分差 > -1.5」幾乎恆真 ⇒ 假過盤，
        # 讓分方過盤率被灌水 +4.2pp。一律取絕對值。
        line_open, line_close = abs(line_open), abs(line_close)
        margin = (g["homeScore"] - g["awayScore"]) if fav_close == "home" else (g["awayScore"] - g["homeScore"])
        if abs(margin) == line_close:
            continue                            # 走盤不列入
        out.append({"league": g["league"], "pOpen": p_open, "pClose": p_close,
                    "covered": margin > line_close,
                    "lineOpen": line_open, "lineClose": line_close,
                    "favFlip": fav_open != fav_close,
                    "swap": bool((g.get("stakeSwap") or {}).get("ever"))})
    return out


def ou_rows(games):
    out = []
    for g in games:
        o, c = market(g, "ou", "open"), market(g, "ou", "close")
        if not o or not c:
            continue
        p_open = devig(o.get("over"), o.get("under"))
        p_close = devig(c.get("over"), c.get("under"))
        line_open, line_close = o.get("line"), c.get("line")
        if p_open is None or p_close is None or line_close is None or line_open is None:
            continue
        line_open, line_close = abs(line_open), abs(line_close)
        total = g["homeScore"] + g["awayScore"]
        if total == line_close:
            continue                            # 走盤不列入
        out.append({"league": g["league"], "pOpen": p_open, "pClose": p_close,
                    "over": total > line_close,
                    "lineOpen": line_open, "lineClose": line_close})
    return out


# ── 檢定 ──────────────────────────────────────────────────────────
def calibration(rows, prob_key, hit_key, label):
    """校準度：盤口說 X%，實際就是 X% 嗎？（盤口本身準不準）"""
    n = len(rows)
    if n == 0:
        return None
    expected = sum(r[prob_key] for r in rows)
    hits = sum(1 for r in rows if r[hit_key])
    p0 = expected / n
    return {"label": label, "n": n, "hits": hits, "rate": hits / n,
            "expected": p0, "diff": hits / n - p0,
            "p": binom_test(hits, n, p0), "ci": wilson(hits, n)}


def drift_buckets(rows, hit_key, label, bins=(-1, -0.03, -0.01, 0.01, 0.03, 1)):
    """走向分桶：收盤機率 − 初盤機率（正＝該側被買進）。
    每桶問：實際命中率 vs 收盤盤口隱含機率（贏得過盤口才算有判讀性）。"""
    out = []
    for lo, hi in zip(bins, bins[1:]):
        sub = [r for r in rows if lo <= (r["pClose"] - r["pOpen"]) < hi]
        if len(sub) < 30:
            out.append({"bucket": f"[{lo:+.2f},{hi:+.2f})", "n": len(sub), "skip": True})
            continue
        n = len(sub)
        hits = sum(1 for r in sub if r[hit_key])
        p0 = sum(r["pClose"] for r in sub) / n
        out.append({"bucket": f"[{lo:+.2f},{hi:+.2f})", "n": n, "hits": hits,
                    "rate": hits / n, "expected": p0, "diff": hits / n - p0,
                    "p": binom_test(hits, n, p0), "ci": wilson(hits, n), "skip": False})
    return {"label": label, "buckets": out}


def flag_split(rows, flag_key, hit_key, label):
    """旗標分組（如讓分方對調過、讓分線移動過）：有旗標 vs 無旗標，各自 vs 盤口。"""
    out = []
    for value in (True, False):
        sub = [r for r in rows if bool(r.get(flag_key)) is value]
        if len(sub) < 30:
            out.append({"group": "有" if value else "無", "n": len(sub), "skip": True})
            continue
        n = len(sub)
        hits = sum(1 for r in sub if r[hit_key])
        p0 = sum(r["pClose"] for r in sub) / n
        out.append({"group": "有" if value else "無", "n": n, "hits": hits,
                    "rate": hits / n, "expected": p0, "diff": hits / n - p0,
                    "p": binom_test(hits, n, p0), "ci": wilson(hits, n), "skip": False})
    return {"label": label, "groups": out}


def line_move_split(rows, hit_key, label):
    """盤口線本身移動（讓分 1.5→2.5、大小 8.5→9.5）：移動方向有沒有預測力。"""
    out = []
    for name, pred in (("線變大", lambda r: r["lineClose"] > r["lineOpen"]),
                       ("線不動", lambda r: r["lineClose"] == r["lineOpen"]),
                       ("線變小", lambda r: r["lineClose"] < r["lineOpen"])):
        sub = [r for r in rows if pred(r)]
        if len(sub) < 30:
            out.append({"group": name, "n": len(sub), "skip": True})
            continue
        n = len(sub)
        hits = sum(1 for r in sub if r[hit_key])
        p0 = sum(r["pClose"] for r in sub) / n
        out.append({"group": name, "n": n, "hits": hits, "rate": hits / n,
                    "expected": p0, "diff": hits / n - p0,
                    "p": binom_test(hits, n, p0), "ci": wilson(hits, n), "skip": False})
    return {"label": label, "groups": out}


def fmt(entry) -> str:
    if entry.get("skip"):
        return f"樣本 {entry['n']} 不足 30，跳過"
    lo, hi = entry["ci"]
    return (f"n={entry['n']:5d}  實際 {entry['rate']*100:5.1f}%  盤口 {entry['expected']*100:5.1f}%  "
            f"差 {entry['diff']*100:+5.1f}pp  95%CI[{lo*100:.1f},{hi*100:.1f}]  p={entry['p']:.3f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-dir", default="data/oddsportal_archive")
    parser.add_argument("--scores", default="C:/Users/User/AppData/Local/Temp/scores.json")
    parser.add_argument("--league", default="")
    args = parser.parse_args()

    games = load_games(args.archive_dir, args.scores)
    if args.league:
        games = [g for g in games if g.get("league") == args.league]
    print(f"配對到有比分的比賽：{len(games)} 場  "
          f"{dict(Counter(g['league'] for g in games))}\n")

    ml, hd, ou = ml_rows(games), hd_rows(games), ou_rows(games)
    print(f"可分析樣本：獨贏 {len(ml)}／讓分 {len(hd)}／大小 {len(ou)}\n")

    tests = []
    print("=" * 88)
    print("① 盤口本身準不準（校準度）——這是所有判讀的基準線")
    print("=" * 88)
    for rows, pk, hk, name in ((ml, "pClose", "homeWin", "獨贏 收盤 vs 主隊實際勝率"),
                               (ml, "pOpen", "homeWin", "獨贏 初盤 vs 主隊實際勝率"),
                               (hd, "pClose", "covered", "讓分 收盤 vs 讓分方實際過盤率"),
                               (hd, "pOpen", "covered", "讓分 初盤 vs 讓分方實際過盤率"),
                               (ou, "pClose", "over", "大小 收盤 vs 實際開大率"),
                               (ou, "pOpen", "over", "大小 初盤 vs 實際開大率")):
        r = calibration(rows, pk, hk, name)
        if r:
            tests.append(r)
            print(f"  {name:32s} {fmt(r)}")

    print()
    print("=" * 88)
    print("② 走向分桶：收盤機率 − 初盤機率（正＝該側被買進）")
    print("   問的是「贏不贏得過收盤盤口」，不是「贏不贏 50%」")
    print("=" * 88)
    for rows, hk, name in ((ml, "homeWin", "獨贏（主隊視角）"),
                           (hd, "covered", "讓分（讓分方視角）"),
                           (ou, "over", "大小（大分視角）")):
        block = drift_buckets(rows, hk, name)
        print(f"  【{block['label']}】")
        for b in block["buckets"]:
            tests.append(b) if not b.get("skip") else None
            print(f"    {b['bucket']:16s} {fmt(b)}")

    print()
    print("=" * 88)
    print("③ 盤口線移動（讓分 1.5→2.5、大小 8.5→9.5）")
    print("=" * 88)
    for rows, hk, name in ((hd, "covered", "讓分線移動 → 讓分方過盤率"),
                           (ou, "over", "大小線移動 → 開大率")):
        block = line_move_split(rows, hk, name)
        print(f"  【{block['label']}】")
        for g in block["groups"]:
            tests.append(g) if not g.get("skip") else None
            print(f"    {g['group']:8s} {fmt(g)}")

    print()
    print("=" * 88)
    print("④ 旗標：讓分方對調過 / 讓分方在初收之間換邊")
    print("=" * 88)
    for rows, flag, hk, name in ((hd, "swap", "covered", "Stake 曾對調 → 讓分方過盤率"),
                                 (hd, "favFlip", "covered", "初收之間讓分方換邊 → 過盤率"),
                                 (ml, "swap", "homeWin", "Stake 曾對調 → 主隊勝率")):
        block = flag_split(rows, flag, hk, name)
        print(f"  【{block['label']}】")
        for g in block["groups"]:
            tests.append(g) if not g.get("skip") else None
            print(f"    {g['group']:4s} {fmt(g)}")

    print()
    print("=" * 88)
    valid = [t for t in tests if t and not t.get("skip")]
    alpha = 0.05
    bonf = alpha / max(1, len(valid))
    hits = [t for t in valid if t["p"] < bonf]
    print(f"多重比較校正：共 {len(valid)} 個檢定，Bonferroni 門檻 p < {bonf:.4f}")
    if hits:
        print("通過校正的方向（真正可判讀的候選）：")
        for t in hits:
            name = t.get("label") or t.get("bucket") or t.get("group")
            print(f"  ★ {name}: {fmt(t)}")
    else:
        print("★ 沒有任何方向通過多重比較校正 → 目前資料看不到穩定的超額判讀力")
    weak = [t for t in valid if bonf <= t["p"] < alpha]
    if weak:
        print(f"未校正下顯著（{len(weak)} 個，需更多樣本才能確認，不可直接下注）：")
        for t in weak:
            name = t.get("label") or t.get("bucket") or t.get("group")
            print(f"  · {name}: {fmt(t)}")


if __name__ == "__main__":
    main()
