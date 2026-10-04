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
        if (msg.status >= 200 && msg.status < 400 && msg.b64) {
          const body = Buffer.from(msg.b64, 'base64').toString('utf8');
          p.resolve(msg.rendered ? {
            html: body,
            finalUrl: String(msg.finalUrl || ''),
            captured: Array.isArray(msg.captured) ? msg.captured : [],
          } : body);
        }
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

function makeSidecarRequest(id, url, headers, timeoutMs, options) {
  const request = { id, url, headers: Object.assign({}, headers || {}), timeoutMs };
  const opts = options && typeof options === 'object' ? options : null;
  if (opts && opts.rendered) {
    request.rendered = true;
    request.waitMs = Math.max(0, Math.min(20000, Number(opts.waitMs) || 0));
    if (opts.waitSelector) request.waitSelector = String(opts.waitSelector).slice(0, 240);
    if (Array.isArray(opts.capturePatterns)) {
      request.capturePatterns = opts.capturePatterns.map((value) => String(value).slice(0, 240)).slice(0, 12);
    }
  }
  return request;
}

async function sidecarGet(url, headers, timeoutMs, options) {
  await startSidecar();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('sidecar 請求逾時')); }, timeoutMs + 30e3);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try { proc.stdin.write(JSON.stringify(makeSidecarRequest(id, url, headers, timeoutMs, options)) + '\n'); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}

async function fetchRendered(url, options, timeoutMs) {
  const opts = options && typeof options === 'object' ? options : {};
  const headers = opts.headers && typeof opts.headers === 'object' ? opts.headers : {};
  const limit = Number(timeoutMs) || 90000;
  return sidecarGet(url, headers, limit, { ...opts, rendered: true });
}

// 挑戰頁辨識（2026-07-29 稽核吞單案：挑戰頁回 HTTP 200、內容空殼，被當成功頁 → 高手被誤判撤單）
// 200 ≠ 有效內容；收到挑戰＝該層被擋，往下一層走或拋錯讓呼叫端計為抓取失敗。
function isChallenged(body) {
  const head = String(body || '').slice(0, 3000);
  return head.includes('Just a moment') || head.includes('challenges.cloudflare.com');
}

// 對外唯一入口：語義同原本的 curlGet
async function fetchText(url, headers, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  if (FORCE === 'curl') {
    const b = await curlGet(url, headers, timeoutMs);
    if (isChallenged(b)) throw new Error('challenge page (curl)');
    return b;
  }
  if (!curlBlocked) {
    try {
      const b = await curlGet(url, headers, timeoutMs);
      if (!isChallenged(b)) return b;
      curlBlocked = true;
      console.log('  ⓘ curl 收到挑戰頁 → 立即用隱形瀏覽器重試同一頁，本輪後續沿用瀏覽器');
    }
    catch (e) {
      if (shouldUseBrowserFallback(e)) {
        curlBlocked = true;
        const reason = e.httpCode == null ? (e.code || e.message) : e.httpCode;
        console.log(`  ⓘ curl 無法取得有效回應（${reason}）→ 立即用隱形瀏覽器重試同一頁，本輪後續沿用瀏覽器`);
      } else { throw e; }
    }
  }
  const b = await sidecarGet(url, headers, timeoutMs);
  if (isChallenged(b)) throw new Error('challenge page (sidecar)');   // python 端 solve 層也沒過 → 當抓取失敗
  return b;
}

// curl 的 status 0／連線重設與 403 挑戰頁一樣，都代表「這個傳輸層拿不到頁面」，
// 不能直接讓整輪爬蟲失敗。真正的 4xx（例如 404 月檔尚未發佈）則保留原錯誤，
// 避免把不存在的網址也丟進瀏覽器浪費整輪時間。
function shouldUseBrowserFallback(error) {
  const status = Number(error && error.httpCode);
  if (!Number.isFinite(status) || status === 0) return true;
  return status === 403 || status === 429 || status >= 500;
}

function stopSidecarProcess(child, graceMs = 5000) {
  if (!child) return null;
  try { child.stdin.write(JSON.stringify({ quit: true }) + '\n'); } catch (_) {}
  try { child.stdin.end(); } catch (_) {}
  // Scrapling／瀏覽器收尾偶爾卡住，會讓 node index.js 永不結束，整條五分鐘迴圈因此停擺。
  // 先給正常清理時間；仍未退出就強制終止，避免一輪請求拖垮整個工作流。
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, graceMs);
  if (timer.unref) timer.unref();
  if (child.once) child.once('exit', () => clearTimeout(timer));
  return timer;
}

function shutdown() {
  stopSidecarProcess(proc);
}

module.exports = { fetchText, fetchRendered, shutdown, stopSidecarProcess, makeSidecarRequest, shouldUseBrowserFallback, usingSidecar: () => curlBlocked };
