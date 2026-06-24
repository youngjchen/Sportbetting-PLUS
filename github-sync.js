/* ============================================================
   GitHub 盤面同步 add-on
   目的：取代「匯出檔→上傳雲端→另一台下載→匯入」四步。
     · 電腦：☁ 上傳盤面到 GitHub（把 localStorage 的 doc 壓縮後 commit 進 repo）
     · 手機：☁ 從 GitHub 載入盤面（抓回來解壓、覆蓋本機、reload）
   設定（選項A：public repo）：
     - 寫入需 fine-grained PAT，「只」給「本 repo」的 Contents 讀寫，存在該裝置 localStorage。
     - 讀取公開 repo 不需權杖。
     - 單一寫者、後寫覆蓋（你早上電腦、下午手機，不會同時寫）。
     - doc 以 gzip 壓縮（瀏覽器內建 CompressionStream），省空間並避開 Contents API ~1MB 上限。
   用法：index.html 末尾加 <script src="./github-sync.js"></script>
   ============================================================ */
(function () {
  'use strict';
  if (window.__ghSyncLoaded) return; window.__ghSyncLoaded = true;

  var REPO = 'youngjchen/Sportbetting-PLUS';   // owner/repo（改名要同步改）
  var BRANCH = 'main';
  var PATH = 'state/board_state.json.gz';
  var DOC_KEY = 'sportbetting_plus_doc_v2';
  var PAT_KEY = 'gh_sync_pat';
  var API = 'https://api.github.com/repos/' + REPO + '/contents/' + PATH;

  function getPAT() { try { return localStorage.getItem(PAT_KEY) || ''; } catch (e) { return ''; } }
  function setPAT(t) { try { if (t) localStorage.setItem(PAT_KEY, t); else localStorage.removeItem(PAT_KEY); } catch (e) {} }
  function ensurePAT() {
    var t = getPAT();
    if (t) return t;
    t = window.prompt('貼上 GitHub 權杖（fine-grained PAT，權限只勾「本 repo 的 Contents：Read and write」）。只會存在這台裝置：');
    if (t) { t = t.trim(); setPAT(t); }
    return t || '';
  }

  function hasCS() { return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'; }
  async function gzipStr(str) {
    var bytes = new TextEncoder().encode(str);
    if (!hasCS()) return bytes;                                  // 不支援壓縮→原樣（仍可用，只是較大）
    var stream = new Response(bytes).body.pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function gunzipBytes(bytes) {
    var isGz = bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!isGz) return new TextDecoder().decode(bytes);          // 沒壓縮的舊檔也能讀
    var stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }
  function b64encode(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  function toast(msg) {
    var t = document.getElementById('gh-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'gh-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;background:#13202c;border:1px solid #3aa0ff;color:#cfe3f2;padding:10px 16px;border-radius:9px;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.45);transition:opacity .5s;max-width:90vw;text-align:center;';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; }, 4000);
  }

  async function upload() {
    if (window.closeMore) try { window.closeMore(); } catch (e) {}
    var doc = '';
    try { doc = localStorage.getItem(DOC_KEY) || ''; } catch (e) {}
    if (!doc) { alert('本機沒有盤面資料可上傳。'); return; }
    var pat = ensurePAT(); if (!pat) return;
    toast('上傳中…');
    try {
      var content = b64encode(await gzipStr(doc));
      var sha = null;
      var head = await fetch(API + '?ref=' + BRANCH + '&t=' + Date.now(),
        { headers: { 'Authorization': 'Bearer ' + pat, 'Accept': 'application/vnd.github+json' } });
      if (head.status === 200) { sha = (await head.json()).sha; }
      else if (head.status === 401 || head.status === 403) { setPAT(''); alert('權杖無效或權限不足，已清除。請用「🔑 設定 GitHub 權杖」重新輸入（需 Contents 讀寫）。'); return; }
      // 404＝檔案還不存在，照常 PUT 建立
      var body = { message: 'board state ' + new Date().toISOString(), content: content, branch: BRANCH };
      if (sha) body.sha = sha;
      var put = await fetch(API, {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + pat, 'Accept': 'application/vnd.github+json' },
        body: JSON.stringify(body)
      });
      if (put.ok) { toast('已上傳盤面到 GitHub ✓'); }
      else {
        var txt = await put.text(); console.warn('[GitHub同步] 上傳失敗', put.status, txt);
        if (put.status === 401 || put.status === 403) { setPAT(''); alert('上傳失敗：權杖權限不足，已清除。請重設權杖（Contents 讀寫）。'); }
        else alert('上傳失敗（HTTP ' + put.status + '）。');
      }
    } catch (err) { console.warn('[GitHub同步]', err); alert('上傳失敗：' + err.message); }
  }

  async function download() {
    if (window.closeMore) try { window.closeMore(); } catch (e) {}
    if (!confirm('從 GitHub 載入盤面會「覆蓋」這台裝置目前的盤面，確定？')) return;
    toast('載入中…');
    try {
      var pat = getPAT();
      var headers = { 'Accept': 'application/vnd.github.raw' };   // 直接拿檔案位元組（公開 repo 免權杖）
      if (pat) headers['Authorization'] = 'Bearer ' + pat;       // 有權杖就帶（提高速率上限）
      var r = await fetch(API + '?ref=' + BRANCH + '&t=' + Date.now(), { headers: headers });
      if (r.status === 404) { alert('GitHub 上還沒有盤面（先在電腦按「☁ 上傳盤面到 GitHub」）。'); return; }
      if (!r.ok) { alert('讀取失敗（HTTP ' + r.status + '）。'); return; }
      var json = await gunzipBytes(new Uint8Array(await r.arrayBuffer()));
      JSON.parse(json);                                          // 驗證是合法 JSON 再寫入
      localStorage.setItem(DOC_KEY, json);
      toast('已載入，重新整理中…');
      setTimeout(function () { location.reload(); }, 600);
    } catch (err) { console.warn('[GitHub同步]', err); alert('載入失敗：' + err.message); }
  }

  function setToken() {
    if (window.closeMore) try { window.closeMore(); } catch (e) {}
    var cur = getPAT();
    var t = window.prompt('設定 GitHub 權杖（留空＝清除）。fine-grained PAT，只勾「本 repo 的 Contents：Read and write」：', cur ? '' : '');
    if (t === null) return;
    setPAT(t.trim());
    toast(t.trim() ? '已儲存權杖（僅本機）' : '已清除權杖');
  }

  function injectButtons() {
    var menu = document.getElementById('moreMenu');
    if (!menu || document.getElementById('ghUploadBtn')) return;
    var anchor = document.getElementById('exportDataBtn');       // 放在本機備份那組之前
    var mk = function (id, label, fn) {
      var b = document.createElement('button'); b.id = id; b.textContent = label;
      b.onclick = function (e) { e.stopPropagation(); fn(); };
      return b;
    };
    var sep = document.createElement('div'); sep.className = 'sep';
    var up = mk('ghUploadBtn', '☁ 上傳盤面到 GitHub', upload);
    var dn = mk('ghDownloadBtn', '☁ 從 GitHub 載入盤面', download);
    var tk = mk('ghTokenBtn', '🔑 設定 GitHub 權杖', setToken);
    if (anchor) { menu.insertBefore(sep, anchor); menu.insertBefore(up, anchor); menu.insertBefore(dn, anchor); menu.insertBefore(tk, anchor); }
    else { [sep, up, dn, tk].forEach(function (n) { menu.appendChild(n); }); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButtons);
  else injectButtons();

  // 供測試
  window.__ghSync = { gzipStr: gzipStr, gunzipBytes: gunzipBytes, b64encode: b64encode, upload: upload, download: download };
})();
