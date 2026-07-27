// sidecar_client.js — Node 端傳輸層：curl 優先，403 就切換常駐隱形瀏覽器（fetch_sidecar.py）
//
// 2026-07-27~28：玩運彩上 Cloudflare 機器人防護。
//   · 住宅 IP + curl → 200（本機備援走這條，最快）
//   · 資料中心 IP（GitHub runner）+ curl/axios → 403 挑戰頁
//   · 任何 IP + scrapling 隱形瀏覽器 → 200（雲端實測 1.1~1.3 秒/頁）
// 策略：先 curl；第一次 403/503 就永久切 sidecar，並用 sidecar 重試同一個請求。
// 不可先丟掉前幾個 403：呼叫端會把漏抓頁面誤判成撤單，進而刪除既有明牌。
// 環境變數 EP_TRANSPORT=sidecar|curl 可強制指定（測試用）。
'use strict';
const { execFile, spawn } = require('child_process');
const path = require('path');

const FORCE = (process.env.EP_TRANSPORT || '').toLowerCase();

let curlBlocked = FORCE === 'sidecar';
let proc = null, ready = null, seq = 0;
const pending = new Map();

function curlGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--max-redirs', '5', '--compressed', '-m', String(Math.ceil(timeoutMs / 1000)),
      '-w', '\n__CURL_CODE__%{http_code}'];
    for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
    args.push(url);
    execFile('curl', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const i = out.lastIndexOf('__CURL_CODE__');
      if (i < 0) return reject(new Error(`curl: ${(err && err.message) || String(stderr || '').trim() || 'no response'}`));
      const code = parseInt(out.slice(i + '__CURL_CODE__'.length), 10);
      if (code >= 200 && code < 400) return resolve(out.slice(0, Math.max(0, i - 1)));
      const e = new Error(`Request failed with status code ${code}`);
      e.httpCode = code;
      reject(e);
    });
  });
}

function startSidecar() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const py = process.env.PYTHON_BIN || 'python';
    proc = spawn(py, [path.join(__dirname, 'fetch_sidecar.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('sidecar 啟動逾時')); } }, 180e3);
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.ready === true && !settled) { settled = true; clearTimeout(timer); resolve(); continue; }
        if (msg.ready === false && !settled) { settled = true; clearTimeout(timer); reject(new Error(msg.err || 'sidecar 無法啟動')); continue; }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.status >= 200 && msg.status < 400 && msg.b64) p.resolve(Buffer.from(msg.b64, 'base64').toString('utf8'));
        else p.reject(new Error(msg.err || `Request failed with status code ${msg.status}`));
      }
    });
    proc.on('exit', (code) => {
      proc = null; ready = null;
      const err = new Error('sidecar 已結束 code=' + code);
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
  });
  return ready;
}

function makeSidecarRequest(id, url, headers, timeoutMs) {
  return { id, url, headers: Object.assign({}, headers || {}), timeoutMs };
}

async function sidecarGet(url, headers, timeoutMs) {
  await startSidecar();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('sidecar 請求逾時')); }, timeoutMs + 30e3);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try { proc.stdin.write(JSON.stringify(makeSidecarRequest(id, url, headers, timeoutMs)) + '\n'); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}

// 對外唯一入口：語義同原本的 curlGet
async function fetchText(url, headers, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  if (FORCE === 'curl') return curlGet(url, headers, timeoutMs);
  if (!curlBlocked) {
    try { return await curlGet(url, headers, timeoutMs); }
    catch (e) {
      if (e.httpCode === 403 || e.httpCode === 503) {
        curlBlocked = true;
        console.log(`  ⓘ curl 被擋（${e.httpCode}）→ 立即用隱形瀏覽器重試同一頁，本輪後續沿用瀏覽器`);
      } else { throw e; }
    }
  }
  return sidecarGet(url, headers, timeoutMs);
}

function shutdown() {
  if (proc) { try { proc.stdin.write(JSON.stringify({ quit: true }) + '\n'); } catch (_) {} try { proc.stdin.end(); } catch (_) {} }
}

module.exports = { fetchText, shutdown, makeSidecarRequest, usingSidecar: () => curlBlocked };
