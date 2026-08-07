"""BetExplorer 抓取模組（2026-08-07 使用者拍板改用此站）

為什麼換站：
  · OddsPortal 的上架列表 2026-08-07 起大量缺當日場次（美職只剩 1 場已結束＋遠期，
    韓職整頁空的），實測確認是站方狀態，非本機網路問題。
  · BetExplorer 同時段當日 9 場（日職 6＋中職 3）全在，且與 OddsPortal 共用 eventId
    （7 月 350 場中 347 場 ID 相同），歷史初盤抽驗 5/5 完全一致。
  · 純 HTTP 即可（不需瀏覽器）：整月結果頁 1 次請求 ~3 秒 ~400 場；
    單場三市場＋初盤 5 次請求 ~8 秒（OddsPortal 需 Playwright 逐頁點擊、單場約 60 秒）。

日期處理（2026-08-07 髒資料事故後的鐵則）：
  · 上架頁用 data-dt="日,月,年,時,分" 的【數字欄位】，不做格式猜測。
  · 結果頁用【網址的 month 參數】＋列上的 DD.MM.，兩者必須同月才採用。
  · 全部數值做範圍檢查；任何一列解析失敗就【跳過該列】，
    絕不繼承上一列的日期——那正是九月場次被寫成當日的成因。
  · 站方時區偏移不寫死：每次執行都用我們自己的賽程反推，至少 3 場一致才採用。
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

BASE = "https://www.betexplorer.com"
TW = timezone(timedelta(hours=8))
STAKE_BID = "997"                      # BetExplorer 的 Stake.com 莊家列 data-bid
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": BASE + "/baseball/",
    "Accept-Language": "en-US,en;q=0.9",
}

LEAGUE_TOURNAMENT = {
    "Japan: NPB": "npb",
    "Taiwan: CPBL": "cpbl",
    "South Korea: KBO": "kbo",
    "USA: MLB": "mlb",
}
LEAGUE_RESULTS_PATH = {
    "mlb": "/baseball/usa/mlb/results/",
    "npb": "/baseball/japan/npb/results/",
    "kbo": "/baseball/south-korea/kbo/results/",
    "cpbl": "/baseball/taiwan/cpbl/results/",
}


# ── 取得 ──────────────────────────────────────────────────────────────
def _open(url: str, ajax: bool = False, tries: int = 3, timeout: int = 45) -> str:
    headers = dict(UA)
    if ajax:
        headers["X-Requested-With"] = "XMLHttpRequest"
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers)
            return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")
        except Exception as exc:                      # 網路瞬斷重試；連續失敗才放棄
            last = exc
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"BetExplorer 讀取失敗 {url}：{last}")


def _json(url: str) -> Any:
    return json.loads(_open(url, ajax=True))


# ── 日期（三道關）────────────────────────────────────────────────────
def parse_data_dt(raw: str) -> datetime:
    """data-dt='7,8,2026,10,00' → 站方時區的 naive datetime。欄位是數字，無格式歧義。"""
    parts = [p.strip() for p in str(raw or "").split(",")]
    if len(parts) != 5 or not all(p.isdigit() for p in parts):
        raise ValueError(f"data-dt 欄位不合法：{raw!r}")
    day, month, year, hour, minute = (int(p) for p in parts)
    if not (2020 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31
            and 0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"data-dt 數值超出合理範圍：{raw!r}")
    return datetime(year, month, day, hour, minute)


def parse_result_date(cell_text: str, month_param: str, today_tw: datetime) -> str:
    """結果頁的日期：'30.04.' ＋ 網址 month=2026-04 → '2026-04-30'。
    'Today'/'Yesterday' 只在抓當月時可信；月份對不上一律拒收（不猜、不繼承）。"""
    text = str(cell_text or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}", str(month_param or "")):
        raise ValueError(f"month 參數不合法：{month_param!r}")
    year, month = (int(x) for x in month_param.split("-"))
    low = text.lower()
    if low in ("today", "yesterday"):
        base = today_tw.date() - timedelta(days=1 if low == "yesterday" else 0)
        if (base.year, base.month) != (year, month):
            raise ValueError(f"{text} 與 month={month_param} 不同月，拒收")
        return base.isoformat()
    match = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.?", text)
    if not match:
        raise ValueError(f"結果頁日期格式不認得：{text!r}")
    day, row_month = int(match.group(1)), int(match.group(2))
    if row_month != month:
        raise ValueError(f"列上月份 {row_month} 與 month={month_param} 不符，拒收")
    if not (1 <= day <= 31):
        raise ValueError(f"日不合法：{text!r}")
    return f"{year:04d}-{month:02d}-{day:02d}"


def detect_offset_hours(schedule: Iterable[dict[str, Any]], listing: Iterable[dict[str, Any]],
                        min_agree: int = 3) -> float:
    """用我們自己的賽程反推「站方時間→台灣時間」的時差。
    至少 min_agree 場一致才採用；不一致就丟例外（寧可不抓，也不要抓錯日期）。"""
    want: dict[tuple[str, str], str] = {}
    for row in schedule or []:
        away, home = row.get("awayTeam"), row.get("homeTeam")
        text = str(row.get("gameTime") or row.get("time") or "")
        hit = re.search(r"(\d{1,2}):(\d{2})", text)
        if away and home and hit:
            want[(away, home)] = f"{int(hit.group(1)):02d}:{hit.group(2)}"
    diffs: list[float] = []
    for game in listing or []:
        key = (game.get("awayZh"), game.get("homeZh"))
        target = want.get(key)
        site = game.get("siteStart")
        if not target or not isinstance(site, datetime):
            continue
        th, tm = int(target[:2]), int(target[3:5])
        diffs.append(((th * 60 + tm) - (site.hour * 60 + site.minute)) / 60.0)
    if len(diffs) < min_agree:
        raise RuntimeError(f"可比對場次僅 {len(diffs)} 場（需 {min_agree}），拒絕猜測時差")
    uniq = set(round(d, 2) for d in diffs)
    if len(uniq) != 1:
        raise RuntimeError(f"時差不一致 {sorted(uniq)}，拒絕採用")
    return diffs[0]


# ── 探索 ──────────────────────────────────────────────────────────────
_ROW_RE = re.compile(
    r'(?:<tr class="js-tournament">.*?class="table-main__tournament">(?:<i>.*?</i>)?([^<]+)</a>'
    r'|<tr data-dt="([^"]+)">(.*?)</tr>)', re.S)


def discover_upcoming(team_zh, leagues: Iterable[str] | None = None,
                      html: str | None = None) -> list[dict[str, Any]]:
    """/baseball/ 上架頁：今天＋明天的比賽。回傳站方時間，時差另外反推。"""
    page = html if html is not None else _open(BASE + "/baseball/")
    wanted = set(leagues or LEAGUE_TOURNAMENT.values())
    out: list[dict[str, Any]] = []
    tournament = None
    for match in _ROW_RE.finditer(page):
        if match.group(1):
            tournament = match.group(1).strip()
            continue
        league = LEAGUE_TOURNAMENT.get(tournament or "")
        if not league or league not in wanted:
            continue
        try:
            site_start = parse_data_dt(match.group(2))
        except ValueError:
            continue                                   # 解析不了就跳過，絕不繼承
        body = match.group(3)
        link = re.search(r'<a href="([^"]+)">([^<]+)</a>', body)
        if not link or " - " not in link.group(2):
            continue
        home, away = (t.strip() for t in link.group(2).split(" - ", 1))
        home_zh, away_zh = team_zh(home), team_zh(away)
        if not home_zh or not away_zh:
            continue
        out.append({
            "league": league, "matchId": link.group(1).rstrip("/").split("/")[-1],
            "homeName": home, "awayName": away, "homeZh": home_zh, "awayZh": away_zh,
            "siteStart": site_start, "url": BASE + link.group(1),
        })
    return out


_RESULT_ROW_RE = re.compile(
    r'<tr>\s*<td class="h-text-left">\s*<a data-test="\d+" href="(/baseball/[^"]+/([A-Za-z0-9]{6,12})/)"[^>]*>'
    r'(.*?)</a></td>.*?<td class="h-text-right h-text-no-wrap">([^<]*)</td>', re.S)


def discover_month(league: str, month: str, team_zh, today_tw: datetime | None = None,
                   html: str | None = None) -> list[dict[str, Any]]:
    """結果頁整月一次抓完（1 次 HTTP ~3 秒 ~400 場）。"""
    if league not in LEAGUE_RESULTS_PATH:
        raise ValueError(f"未知聯盟 {league}")
    today_tw = today_tw or datetime.now(TW).replace(tzinfo=None)
    page = html if html is not None else _open(f"{BASE}{LEAGUE_RESULTS_PATH[league]}?month={month}")
    out: list[dict[str, Any]] = []
    for href, match_id, title, date_cell in _RESULT_ROW_RE.findall(page):
        names = re.findall(r"<span>(?:<strong>)?([^<]+)(?:</strong>)?</span>", title)
        if len(names) < 2:
            continue
        home, away = names[0].strip(), names[1].strip()
        home_zh, away_zh = team_zh(home), team_zh(away)
        if not home_zh or not away_zh:
            continue
        try:
            date = parse_result_date(date_cell, month, today_tw)
        except ValueError:
            continue                                   # 拒收，不猜
        out.append({
            "league": league, "matchId": match_id, "date": date,
            "homeName": home, "awayName": away, "homeZh": home_zh, "awayZh": away_zh,
            "url": BASE + href,
        })
    return out


# ── Stake 賠率 ───────────────────────────────────────────────────────
_STAKE_ROW_RE = re.compile(rf'<tr data-bid="{STAKE_BID}"[^>]*>(.*?)</tr>', re.S)
_ATTR_RE = re.compile(r"""([\w-]+)=['"]([^'"]*)['"]""")


def stake_lines(match_id: str, market: str, odds_html: str | None = None) -> list[dict[str, Any]]:
    """market: ha｜ah｜ou。回傳 Stake 的每一條盤口。
    active=True 代表「現在還掛在架上」（該格帶 data-oid），False＝已下架。
    ——這是判斷讓分對調的依據：已下架的反向盤口＋現行盤口 = 曾經對調。"""
    if market not in ("ha", "ah", "ou"):
        raise ValueError(f"未知市場 {market}")
    if odds_html is None:
        payload = _json(f"{BASE}/match-odds-old/{match_id}/0/{market}/1/en/?sportname=baseball")
        odds_html = payload.get("odds", "") if isinstance(payload, dict) else ""
    out: list[dict[str, Any]] = []
    for row in _STAKE_ROW_RE.findall(odds_html):
        cells = [dict(_ATTR_RE.findall(attrs))
                 for attrs in re.findall(r"<td([^>]*data-odd[^>]*)>", row)]
        if len(cells) < 2:
            continue
        param = re.search(r"doubleparameter[^>]*>([^<]*)<", row)
        line_text = param.group(1).strip() if param else ""
        try:
            line = float(line_text) if line_text else None
        except ValueError:
            line = None
        out.append({
            "market": market, "line": line, "lineText": line_text,
            "first": cells[0], "second": cells[1],
            "active": "data-oid" in cells[0],
            "created": cells[0].get("data-created"),
        })
    return out


def archive_history(cell: dict[str, str]) -> list[dict[str, str]] | None:
    """該格的賠率變動史（新→舊）；已下架的格沒有 data-oid，查不到。"""
    need = ("data-oid", "data-bid", "data-bt", "data-sc", "data-hcp")
    if not all(k in cell for k in need):
        return None
    url = (f"{BASE}/archive-odds/{cell['data-oid']}/{cell['data-bid']}/"
           f"{cell['data-bt']}/{cell['data-sc']}/{cell['data-hcp']}/")
    try:
        value = _json(url)
    except Exception:
        return None
    return value if isinstance(value, list) and value else None


def opening_odds(cell: dict[str, str]) -> tuple[float | None, str | None]:
    """初盤＝變動史最舊一筆；查不到就退回該格現值（並回報其建立時間）。"""
    history = archive_history(cell)
    if history:
        oldest = history[-1]
        try:
            return float(oldest.get("odd")), oldest.get("date")
        except (TypeError, ValueError):
            return None, oldest.get("date")
    try:
        return float(cell.get("data-odd")), cell.get("data-created")
    except (TypeError, ValueError):
        return None, cell.get("data-created")


def handicap_swap(lines: list[dict[str, Any]]) -> dict[str, Any]:
    """讓分對調：現行盤口與『已下架盤口』的讓分方相反 = 曾經對調。
    盤口數值以主隊視角：負=主隊讓、正=客隊讓。
    2026-08-07 兄弟@台鋼實證：+1.5 已下架、-1.5 在架上 → 使用者親眼確認確實對調過。"""
    def side(line: dict[str, Any]) -> str | None:
        value = line.get("line")
        if value is None or value == 0:
            return None
        return "home" if value < 0 else "away"

    active = [side(x) for x in lines if x.get("active")]
    struck = [side(x) for x in lines if not x.get("active")]
    active_sides = {s for s in active if s}
    struck_sides = {s for s in struck if s}
    ever = bool(active_sides and struck_sides and struck_sides - active_sides)
    return {
        "ever": ever,
        "activeSide": sorted(active_sides),
        "struckSide": sorted(struck_sides),
        "lines": [{"line": x.get("line"), "active": x.get("active"), "created": x.get("created")}
                  for x in lines],
    }
