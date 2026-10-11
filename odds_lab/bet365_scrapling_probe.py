#!/usr/bin/env python3
"""bet365_scrapling_probe.py — 一次性探針：runner 上的 Scrapling 隱形瀏覽器能不能「看見」bet365。

背景（2026-10-11）：四聯盟 bet365 官網層全滅，errors 一律
「solve-cloudflare returned challenge/status 403」→ 全部退回 BetExplorer。
Scrapling 0.4.12~0.4.15 有指紋相關修正（UA 對齊實際 Chromium 版號、locale 不再強制 en-US、
Turnstile 解題不受 locale 影響），本探針用同一份腳本比較現役釘版 vs 最新版。

每個 模式×網址 記錄：HTTP 狀態、最終網址、標題、HTML 長度、內容標記、可見文字開頭、
bet365 網域的子請求狀態碼、瀏覽器指紋摘要，並截圖。結果寫進 --out 目錄的 summary.json。
"""
import argparse, asyncio, json, os, re, sys, time, urllib.request

TARGETS = {
    'sportsbook': 'https://www.bet365.com/#/AS/B16/',          # baseball_bet365_odds.js 的 SPORTSBOOK_URL
    'mlbhub': 'https://www.bet365.com/hub/en-us/baseball/mlb',  # baseball_bet365_odds.js 的 MLB_HUB_URL
}
# 環境變數覆寫：PROBE_TARGETS="name=url,name=url"、PROBE_MODES="stealth,solve,headful"
if os.environ.get('PROBE_TARGETS'):
    TARGETS = dict(item.split('=', 1) for item in os.environ['PROBE_TARGETS'].split(',') if '=' in item)
HEADERS = {'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9'}
CONTENT_RE = re.compile(r'data-item-name|data-fixture-id|gl-MarketGroup|src-Participant|ovm-Fixture|cpm-Participant')
FP_JS = """() => {
  const out = {ua: navigator.userAgent, webdriver: navigator.webdriver, platform: navigator.platform,
    languages: navigator.languages, hw: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: [screen.width, screen.height]};
  try { const c = document.createElement('canvas').getContext('webgl');
        const e = c.getExtension('WEBGL_debug_renderer_info');
        out.webgl = [c.getParameter(e.UNMASKED_VENDOR_WEBGL), c.getParameter(e.UNMASKED_RENDERER_WEBGL)]; }
  catch (err) { out.webgl = String(err); }
  return out;
}"""


def runner_geo():
    try:
        with urllib.request.urlopen('https://ipinfo.io/json', timeout=15) as r:
            d = json.loads(r.read().decode('utf-8'))
        return {k: d.get(k) for k in ('ip', 'city', 'region', 'country', 'org')}
    except Exception as e:
        return {'err': f'{type(e).__name__}: {e}'}


def classify(html):
    s = html or ''
    if not s.strip():
        return 'empty'
    if re.search(r'just a moment|cf-chl|challenge-platform', s, re.I):
        return 'cloudflare-challenge'
    if re.search(r'無法顯示此內容|content is unavailable|unable to display this content', s, re.I):
        return 'geo-or-restricted'
    if CONTENT_RE.search(s):
        return 'odds-content'
    if 'bl-Preloader' in s:
        return 'preloader-shell'
    return 'other'


async def probe_one(session, mode, name, url, out_dir):
    rec = {'mode': mode, 'target': name, 'url': url}
    holder = {'sub': [], 'fp': None, 'text': '', 'final': url}

    async def act(page):
        def on_resp(resp):
            u = str(getattr(resp, 'url', '') or '')
            if ('bet365' in u or '365lpodds' in u) and len(holder['sub']) < 40:
                holder['sub'].append([int(getattr(resp, 'status', 0) or 0), u[:160]])
        page.on('response', on_resp)
        try:
            await page.reload(wait_until='domcontentloaded')
        except Exception as e:
            holder['reload_err'] = f'{type(e).__name__}: {e}'[:200]
        await page.wait_for_timeout(12000)
        try:
            holder['fp'] = await page.evaluate(FP_JS)
        except Exception as e:
            holder['fp'] = {'err': str(e)[:200]}
        try:
            holder['text'] = (await page.evaluate('() => document.body ? document.body.innerText : ""'))[:600]
        except Exception:
            pass
        holder['final'] = str(getattr(page, 'url', '') or url)
        try:
            await page.screenshot(path=os.path.join(out_dir, f'{mode}_{name}.png'))
        except Exception as e:
            holder['shot_err'] = str(e)[:200]
        return page

    t0 = time.time()
    try:
        page = await session.fetch(url, extra_headers=HEADERS, page_action=act,
                                   google_search=False, timeout=90000)
        html = getattr(page, 'html_content', None) or str(page)
        rec['hub_links'] = sorted(set(re.findall(r'href="(?:https://www\.bet365\.com)?(/hub/en-us/baseball/[^"#?]*)"', html)))[:40]
        rec.update(status=int(getattr(page, 'status', 0) or 0), html_len=len(html),
                   title=(re.search(r'<title[^>]*>(.*?)</title>', html, re.S | re.I) or [None, ''])[1].strip()[:120],
                   verdict=classify(html))
        with open(os.path.join(out_dir, f'{mode}_{name}.html'), 'w', encoding='utf-8') as f:
            f.write(html[:400000])
    except Exception as e:
        rec.update(status=0, verdict='exception', err=f'{type(e).__name__}: {e}'[:400])
    rec.update(secs=round(time.time() - t0, 1), final_url=holder['final'], visible_text=holder['text'],
               subrequests=holder['sub'], fingerprint=holder['fp'])
    for k in ('reload_err', 'shot_err'):
        if k in holder:
            rec[k] = holder[k]
    print(json.dumps({k: rec.get(k) for k in ('mode', 'target', 'status', 'verdict', 'title', 'secs', 'final_url')},
                     ensure_ascii=False), flush=True)
    return rec


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--label', required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    from scrapling.fetchers import AsyncStealthySession
    import importlib.metadata as md
    versions = {}
    for pkg in ('scrapling', 'patchright', 'playwright', 'browserforge', 'apify_fingerprint_datapoints', 'curl_cffi'):
        try:
            versions[pkg] = md.version(pkg)
        except Exception:
            versions[pkg] = None
    summary = {'label': args.label, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'versions': versions, 'geo': runner_geo(), 'results': []}
    print(json.dumps({'versions': versions, 'geo': summary['geo']}), flush=True)

    modes = [
        ('stealth', dict(headless=True, block_webrtc=True)),                        # 現役 fetch_sidecar.py 主層設定
        ('solve', dict(headless=True, block_webrtc=True, solve_cloudflare=True)),   # 現役第二層
    ]
    if os.environ.get('DISPLAY'):
        modes.append(('headful', dict(headless=False, block_webrtc=True)))          # 有畫面（xvfb）對照組
    wanted = [m for m in os.environ.get('PROBE_MODES', '').split(',') if m]
    if wanted:
        modes = [m for m in modes if m[0] in wanted]
    for mode, kw in modes:
        try:
            cm = AsyncStealthySession(**kw)
            session = await cm.__aenter__()
        except Exception as e:
            summary['results'].append({'mode': mode, 'verdict': 'session-start-failed', 'err': f'{type(e).__name__}: {e}'[:400]})
            continue
        try:
            for name, url in TARGETS.items():
                summary['results'].append(await probe_one(session, mode, name, url, args.out))
        finally:
            try:
                await cm.__aexit__(None, None, None)
            except Exception:
                pass
    with open(os.path.join(args.out, 'summary.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
