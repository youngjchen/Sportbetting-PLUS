"""官方賽事來源的開賽時間（第三道確認）

2026-08-07 使用者要求：抓到的時間要跟「棒球比賽官網」對照後再換算成台灣時間，三重確認。
  第一重：BetExplorer 的 data-dt（站方時區）
  第二重：本專案 data/pregame_data.json（台灣時間）
  第三重：官方來源 —— 本檔

各聯盟官方來源與狀態：
  mlb  statsapi.mlb.com          純 HTTP、回 UTC ISO 時間 → 可用
  npb  npb.jp 月賽程頁            純 HTTP、日本時間(JST=UTC+9，台灣 = JST−1h) → 可用
  cpbl www.cpbl.com.tw           Vue 前端渲染，純 HTTP 拿不到時間 → 需瀏覽器，暫不支援
  kbo  koreabaseball.com         同上，暫不支援
支援不到的聯盟由呼叫端自行決定要不要放行（本檔只回傳「查得到的」，不假裝有資料）。
"""

from __future__ import annotations

import json
import re
import ssl
import urllib.request
from datetime import datetime, timedelta, timezone

TW = timezone(timedelta(hours=8))
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except Exception:                                    # certifi 不在就用系統憑證
    _SSL = ssl.create_default_context()


def _get(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(request, timeout=timeout, context=_SSL).read().decode("utf-8", "ignore")


def mlb_start_times(date_tw: str) -> list[str]:
    """官方 statsapi：回傳該台灣日期所有 MLB 開賽時間（HH:MM，台灣時間）。"""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_tw):
        raise ValueError(f"日期格式不對：{date_tw}")
    # 台灣日期涵蓋的 UTC 範圍跨兩天，官方以美東日期分場次 → 查前後各一天再過濾
    day = datetime.fromisoformat(date_tw)
    lo = (day - timedelta(days=1)).date().isoformat()
    hi = (day + timedelta(days=1)).date().isoformat()
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate={lo}&endDate={hi}"
    payload = json.loads(_get(url))
    out = []
    for block in payload.get("dates", []):
        for game in block.get("games", []):
            raw = str(game.get("gameDate") or "")
            if not raw.endswith("Z"):
                continue
            utc = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            tw = utc.astimezone(TW)
            if tw.date().isoformat() == date_tw:
                out.append(tw.strftime("%H:%M"))
    return sorted(out)


def npb_start_times(date_tw: str) -> list[str]:
    """官方 npb.jp 月賽程：日本時間 → 台灣時間（JST−1h）。"""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_tw):
        raise ValueError(f"日期格式不對：{date_tw}")
    year, month, day = (int(x) for x in date_tw.split("-"))
    page = _get(f"https://npb.jp/games/{year}/schedule_{month:02d}_detail.html")
    text = re.sub(r"<[^>]+>", "|", page)
    marker = f"{month}/{day} "
    start = text.find(marker)
    if start < 0:
        return []
    nxt = text.find(f"{month}/{day + 1} ", start + 1)
    block = text[start:nxt if nxt > start else start + 4000]
    out = []
    for hh, mm in re.findall(r"\|(\d{1,2}):(\d{2})\|", block):
        jst = datetime(year, month, day, int(hh), int(mm), tzinfo=timezone(timedelta(hours=9)))
        out.append(jst.astimezone(TW).strftime("%H:%M"))
    return sorted(out)


def mlb_start_map(date_tw: str, team_zh) -> dict[tuple[str, str], str]:
    """官方 statsapi：{(客隊中文, 主隊中文): 'HH:MM'(台灣時間)}。
    用途：推導 BetExplorer 站方時差時的基準——官方比我們自己的賽程檔更早有隔日資料
    （2026-08-07 23:3x 實例：我們的 pregame 還沒有 8/8，官方已經有）。"""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_tw):
        raise ValueError(f"日期格式不對：{date_tw}")
    day = datetime.fromisoformat(date_tw)
    lo = (day - timedelta(days=1)).date().isoformat()
    hi = (day + timedelta(days=1)).date().isoformat()
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate={lo}&endDate={hi}"
    payload = json.loads(_get(url))
    out: dict[tuple[str, str], str] = {}
    for block in payload.get("dates", []):
        for game in block.get("games", []):
            raw = str(game.get("gameDate") or "")
            if not raw.endswith("Z"):
                continue
            tw = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(TW)
            if tw.date().isoformat() != date_tw:
                continue
            teams = game.get("teams") or {}
            away = ((teams.get("away") or {}).get("team") or {}).get("name")
            home = ((teams.get("home") or {}).get("team") or {}).get("name")
            away_zh, home_zh = team_zh(away), team_zh(home)
            if away_zh and home_zh:
                out[(away_zh, home_zh)] = tw.strftime("%H:%M")
    return out


SUPPORTED = {"mlb": mlb_start_times, "npb": npb_start_times}


def official_start_times(league: str, date_tw: str) -> list[str] | None:
    """查不到官方來源就回 None（不假裝有資料，讓呼叫端自己決定）。"""
    fetch = SUPPORTED.get(league)
    if not fetch:
        return None
    try:
        return fetch(date_tw)
    except Exception:
        return None


def cross_check(league: str, date_tw: str, converted: list[str], tolerance_min: int = 0) -> dict:
    """把換算後的台灣時間與官方時間對照。
    回傳 {'source': ..., 'ok': bool|None, 'official': [...], 'ours': [...], 'note': ...}
    ok=None 代表沒有官方來源可比（不算通過也不算失敗）。"""
    official = official_start_times(league, date_tw)
    ours = sorted(converted)
    if official is None:
        return {"source": None, "ok": None, "official": None, "ours": ours,
                "note": f"{league} 無可用官方來源（需瀏覽器渲染），僅雙重確認"}
    if not official:
        return {"source": league, "ok": None, "official": [], "ours": ours,
                "note": "官方來源當日無場次資料"}
    if tolerance_min <= 0:
        ok = set(ours).issubset(set(official))
    else:
        def near(value):
            hh, mm = (int(x) for x in value.split(":"))
            mine = hh * 60 + mm
            return any(abs(mine - (int(o[:2]) * 60 + int(o[3:5]))) <= tolerance_min for o in official)
        ok = all(near(x) for x in ours)
    return {"source": league, "ok": ok, "official": official, "ours": ours,
            "note": "換算後時間全部落在官方時刻內" if ok else "換算後時間與官方不符"}
