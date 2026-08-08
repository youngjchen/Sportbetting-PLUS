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


LEAGUE_FIXTURES_PATH = {
    "mlb": "/baseball/usa/mlb/fixtures/",
    "npb": "/baseball/japan/npb/fixtures/",
    "kbo": "/baseball/south-korea/kbo/fixtures/",
    "cpbl": "/baseball/taiwan/cpbl/fixtures/",
}

_FIXTURE_ROW_RE = re.compile(
    r'<tr>\s*<td class="table-main__datetime">([^<]*)</td>\s*'
    r'<td class="h-text-left"><a href="([^"]+)" class="in-match">'
    r'<span>([^<]+)</span> - <span>([^<]+)</span>', re.S)


def parse_fixture_datetime(text: str, site_today, last: datetime | None) -> datetime:
    """賽程頁的時間欄：'Today 23:40'／'Tomorrow 00:05'／'31.08. 23:45'／空白。
    空白＝與上一列同一開賽時刻（站方把同時開打的場次分組，只有第一列標時間）。
    ——這是站方的既定語意，不是解析失誤；但仍加防火牆：還沒看到任何明確時間就跳過，
    絕不憑空生出日期（2026-08-07 髒資料事故的教訓）。"""
    raw = str(text or "").replace(" ", " ").replace("&nbsp;", " ").strip()
    if not raw:
        if last is None:
            raise ValueError("空白時間欄且尚無可繼承的時刻")
        return last
    hit = re.search(r"(\d{1,2}):(\d{2})\s*$", raw)
    if not hit:
        raise ValueError(f"賽程頁時間格式不認得：{text!r}")
    hour, minute = int(hit.group(1)), int(hit.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"時間數值不合法：{text!r}")
    head = raw[:hit.start()].strip().lower()
    if head.startswith("today"):
        day = site_today
    elif head.startswith("tomorrow"):
        day = site_today + timedelta(days=1)
    else:
        date_hit = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.?", head)
        if not date_hit:
            raise ValueError(f"賽程頁日期格式不認得：{text!r}")
        dd, mm = int(date_hit.group(1)), int(date_hit.group(2))
        if not (1 <= mm <= 12 and 1 <= dd <= 31):
            raise ValueError(f"日期數值不合法：{text!r}")
        for year in (site_today.year, site_today.year + 1):
            try:
                candidate = datetime(year, mm, dd).date()
            except ValueError:
                continue
            if candidate >= site_today:                # 賽程頁只會有未來場次
                day = candidate
                break
        else:
            raise ValueError(f"{text} 推不出未來的日期")
    return datetime(day.year, day.month, day.day, hour, minute)


def discover_fixtures(league: str, team_zh, site_today, html: str | None = None) -> list[dict[str, Any]]:
    """聯盟賽程頁：完整的未來場次（美職實測 331 場）。
    2026-08-07 換站後發現：/baseball/ 首頁只列少數場次（8/8 美職只有 3 場），
    要拿整份隔日賽程必須讀這一頁。site_today＝站方時區的今天（由時差反推）。"""
    if league not in LEAGUE_FIXTURES_PATH:
        raise ValueError(f"未知聯盟 {league}")
    page = html if html is not None else _open(f"{BASE}{LEAGUE_FIXTURES_PATH[league]}")
    out: list[dict[str, Any]] = []
    last: datetime | None = None
    for cell, href, home, away in _FIXTURE_ROW_RE.findall(page):
        try:
            start = parse_fixture_datetime(cell, site_today, last)
        except ValueError:
            last = None                                # 壞掉就斷開繼承鏈，不讓錯誤往下傳染
            continue
        last = start
        home_zh, away_zh = team_zh(home.strip()), team_zh(away.strip())
        if not home_zh or not away_zh:
            continue
        out.append({
            "league": league, "matchId": href.rstrip("/").split("/")[-1],
            "homeName": home.strip(), "awayName": away.strip(),
            "homeZh": home_zh, "awayZh": away_zh,
            "siteStart": start, "url": BASE + href,
        })
    return out


def parse_season_date(cell_text: str, today_tw: datetime, season_start: str) -> str:
    """整季結果頁（?month=all）的日期：只有 'DD.MM.'，沒有年份也沒有 month 參數可比對。
    年份用「不可能是未來」推定，並強制落在 [season_start, 今天] 區間內，否則拒收。
    ——同樣不繼承、不猜格式，超出區間一律丟掉。"""
    text = str(cell_text or "").strip()
    low = text.lower()
    if low in ("today", "yesterday"):
        return (today_tw.date() - timedelta(days=1 if low == "yesterday" else 0)).isoformat()
    match = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.?", text)
    if not match:
        raise ValueError(f"整季頁日期格式不認得：{text!r}")
    day, month = int(match.group(1)), int(match.group(2))
    if not (1 <= month <= 12 and 1 <= day <= 31):
        raise ValueError(f"日期數值不合法：{text!r}")
    for year in (today_tw.year, today_tw.year - 1):
        try:
            candidate = datetime(year, month, day).date()
        except ValueError:
            continue
        if candidate > today_tw.date():
            continue
        if candidate.isoformat() < season_start:
            continue
        return candidate.isoformat()
    raise ValueError(f"{text} 推不出落在 [{season_start}, {today_tw.date()}] 內的日期")


def discover_season(league: str, team_zh, season_start: str, today_tw: datetime | None = None,
                    html: str | None = None) -> list[dict[str, Any]]:
    """整季結果頁一次抓完（?month=all）。實測 2026 球季：
    美職 1731 場 3.0s、日職 594 場 4.8s、韓職 540 場 8.0s；中職站方只留近期 61 場。"""
    if league not in LEAGUE_RESULTS_PATH:
        raise ValueError(f"未知聯盟 {league}")
    today_tw = today_tw or datetime.now(TW).replace(tzinfo=None)
    page = html if html is not None else _open(f"{BASE}{LEAGUE_RESULTS_PATH[league]}?month=all")
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
            date = parse_season_date(date_cell, today_tw, season_start)
        except ValueError:
            continue
        out.append({
            "league": league, "matchId": match_id, "date": date,
            "homeName": home, "awayName": away, "homeZh": home_zh, "awayZh": away_zh,
            "url": BASE + href,
        })
    return out


def detect_offset_hours(schedule: Iterable[dict[str, Any]], listing: Iterable[dict[str, Any]],
                        min_agree: int = 3) -> float:
    """用已知開賽時間（我們的賽程檔／官方來源）反推「站方時間→台灣時間」的時差。

    2026-08-09 修正：同一組對戰在連續系列賽會出現在好幾天，若把 (客,主) 當唯一鍵
    就會取到別天的時間，算出一堆互相矛盾的時差（實例 2.5/4.42/4.5/5.5）而整輪中止。
    改成每組對戰保留所有候選時間，各場投票，取得票最高者；票數需達 min_agree
    且不得與第二名同票，否則拒絕採用（寧可不抓也不要抓錯日期）。
    """
    want: dict[tuple[str, str], set[str]] = {}
    for row in schedule or []:
        away, home = row.get("awayTeam"), row.get("homeTeam")
        text = str(row.get("gameTime") or row.get("time") or "")
        hit = re.search(r"(\d{1,2}):(\d{2})", text)
        if away and home and hit:
            want.setdefault((away, home), set()).add(f"{int(hit.group(1)):02d}:{hit.group(2)}")

    def norm(value: float) -> float:
        # 跨午夜：站方 23:40 對應台灣隔天 06:40 實際是 +7h，直接相減會得 −17h
        while value <= -12:
            value += 24
        while value > 12:
            value -= 24
        return round(value, 2)

    votes: dict[float, int] = {}
    matched = 0
    for game in listing or []:
        targets = want.get((game.get("awayZh"), game.get("homeZh")))
        site = game.get("siteStart")
        if not targets or not isinstance(site, datetime):
            continue
        matched += 1
        seen = set()
        for target in targets:
            th, tm = int(target[:2]), int(target[3:5])
            value = norm(((th * 60 + tm) - (site.hour * 60 + site.minute)) / 60.0)
            if value in seen:
                continue
            seen.add(value)
            votes[value] = votes.get(value, 0) + 1
    if not votes:
        raise RuntimeError(f"可比對場次僅 {matched} 場（需 {min_agree}），拒絕猜測時差")
    ranked = sorted(votes.items(), key=lambda kv: -kv[1])
    best, support = ranked[0]
    if support < min_agree:
        raise RuntimeError(f"最高票時差 {best}h 只有 {support} 場支持（需 {min_agree}），拒絕採用")
    if len(ranked) > 1 and ranked[1][1] == support:
        raise RuntimeError(f"時差同票無法決定：{ranked[:2]}，拒絕採用")
    return best


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
        # 2026-08-07 使用者質疑後修正：判斷「還掛不掛」要看 class 有沒有 inactive，
        # 不是看有沒有 data-oid。data-oid 只標記「被 highlight 的主盤」，同時掛著的
        # 其他盤口（如 +2.5、+4.5）也沒有 data-oid，用它會把在架上的盤口誤判成已下架。
        # 對照：兄弟@台鋼此法得「架上只剩 -1.5」，與使用者在 Stake 現場所見完全一致。
        classes = str(cells[0].get("class", "")) + " " + str(cells[1].get("class", ""))
        out.append({
            "market": market, "line": line, "lineText": line_text,
            "first": cells[0], "second": cells[1],
            "active": "inactive" not in classes,
            "primary": "data-oid" in cells[0],
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
