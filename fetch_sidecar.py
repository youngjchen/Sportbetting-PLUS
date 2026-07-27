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
    """瀏覽器 JSON 檢視器包裝還原；不是 JSON 就原樣回傳。"""
    s = raw.lstrip()
    if s.startswith('{') or s.startswith('['):
        return raw
    m = JSON_WRAPPER_RE.search(raw)
    if m:
        inner = htmlmod.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip()
        if inner.startswith('{') or inner.startswith('['):
            return inner
    return raw


def main():
    try:
        from scrapling.fetchers import StealthySession
    except Exception as e:  # 沒裝 scrapling → 讓 Node 立刻退回 curl
        print(json.dumps({"ready": False, "err": f"import: {e}"}), flush=True)
        return 1

    session = StealthySession(headless=True, block_webrtc=True)
    session.__enter__()
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
        try:
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

    try:
        session.__exit__(None, None, None)
    except Exception:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
