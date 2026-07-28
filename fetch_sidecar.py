#!/usr/bin/env python3
"""fetch_sidecar.py — 常駐隱形瀏覽器取頁服務（給 Node 爬蟲當傳輸層）

背景（2026-07-27~28）：玩運彩上 Cloudflare 機器人防護，非瀏覽器 HTTP 客戶端
（axios/curl）從資料中心 IP 一律 403「Just a moment...」挑戰頁。實測 GitHub
runner 上 scrapling StealthySession 直接 200 拿到真內容、每頁 1.1~1.3 秒。

協定（行導向，避免二進位混淆）：
  stdin  一行 JSON: {"url": "...", "id": 7}
  stdout 一行 JSON: {"id": 7, "status": 200, "b64": "<base64 body>"}
                    失敗: {"id": 7, "status": 0, "err": "..."}
  啟動完成時先送一行: {"ready": true}

JSON 端點注意：瀏覽器可能把 JSON 包進檢視器 HTML（<pre> 或 <p>），
本檔負責還原成純 JSON 再回傳，Node 端不必知道差別。
"""
import sys, json, base64, re, html as htmlmod

JSON_WRAPPER_RE = re.compile(
    r'<(?P<tag>pre|p)\b[^>]*>(.*?)</(?P=tag)>',
    re.S | re.I,
)


def unwrap_json(raw: str) -> str:
    """瀏覽器 JSON 包裝還原；不是 JSON 就原樣回傳。

    雲端 camoufox 對 application/json 的包裝與本機不同（2026-07-28 實測）：
    本機回乾淨 JSON、雲端回無 head 的「<html><bod...」純文字包裝且無 <pre>
    → 先試 <pre>/<p>，不中就整頁剝標籤、定位第一個 {/[、配對括號漸進解析。
    HTML 頁（有 rankers 以外的真標記）不會誤傷：剝完不是合法 JSON 就原樣回傳。
    """
    s = raw.lstrip()
    if s.startswith('{') or s.startswith('['):
        return raw
    m = JSON_WRAPPER_RE.search(raw)
    if m:
        inner = htmlmod.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip()
        if inner.startswith('{') or inner.startswith('['):
            return inner
    txt = htmlmod.unescape(re.sub(r'<[^>]+>', ' ', raw))
    for opener, closer in (('{', '}'), ('[', ']')):
        i = txt.find(opener)
        if i < 0:
            continue
        j = txt.rfind(closer)
        while j > i:
            cand = txt[i:j + 1].strip()
            try:
                json.loads(cand)
                return cand
            except Exception:
                j = txt.rfind(closer, i, j)
    return raw


def main():
    try:
        from scrapling.fetchers import StealthySession, FetcherSession
    except Exception as e:  # 沒裝 scrapling → 讓 Node 立刻退回 curl
        print(json.dumps({"ready": False, "err": f"import: {e}"}), flush=True)
        return 1

    session = StealthySession(headless=True, block_webrtc=True)
    session.__enter__()
    # JSON 端點專用：chrome TLS 模擬的純 HTTP（2026-07-29 probe4 實證雲端 200＋真 rankers）。
    # ‼️ 不可用瀏覽器「導航」拿 JSON：雲端會回 SPA 外殼（118KB Vue 頁、資料不在內），
    #    外殼 JS 原始碼裡含 "rankers" 字樣 → 字串判定會誤判成功，一定要 json.loads 驗證。
    http = FetcherSession(impersonate='chrome')
    http.__enter__()
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get('quit'):
            break
        rid, url = req.get('id'), req.get('url')
        headers = {
            str(k): str(v) for k, v in (req.get('headers') or {}).items()
            if str(k).lower() != 'user-agent'
        }
        timeout_ms = max(1000, int(req.get('timeoutMs') or 30000))
        wants_json = 'json' in (headers.get('Accept') or headers.get('accept') or '').lower()
        try:
            if wants_json:
                r = http.get(url, headers=headers)
                status = getattr(r, 'status', 200) or 200
                raw = getattr(r, 'body', None)
                if raw is None:
                    raw = str(r)
                if isinstance(raw, (bytes, bytearray)):
                    raw = raw.decode('utf-8', 'replace')
            else:
                page = session.fetch(
                    url,
                    extra_headers=headers,
                    google_search=False,
                    timeout=timeout_ms,
                )
                status = getattr(page, 'status', 200) or 200
                raw = getattr(page, 'html_content', None)
                if raw is None:
                    raw = str(page)
            body = unwrap_json(raw)
            out = {"id": rid, "status": status,
                   "b64": base64.b64encode(body.encode('utf-8', 'replace')).decode('ascii')}
        except Exception as e:
            out = {"id": rid, "status": 0, "err": f"{type(e).__name__}: {e}"}
        print(json.dumps(out), flush=True)

    for s in (http, session):
        try:
            s.__exit__(None, None, None)
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
