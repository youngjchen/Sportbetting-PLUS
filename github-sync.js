/* ============================================================
   GitHub 盤面同步 add-on
   目的：取代「匯出檔→上傳雲端→另一台下載→匯入」四步。
     · 電腦：☁ 上傳盤面到 GitHub（把 localStorage 的 doc 壓縮後 commit 進 repo）
     · 手機：☁ 從 GitHub 載入盤面（抓回來解壓、覆蓋本機、reload）
   設定（選項A：public repo）：
     - 寫入需 fine-grained PAT，「只」給「本 repo」的 Contents 讀寫，存在該裝置 localStorage。
     - 讀取公開 repo 不需權杖。
     - 上傳＝union、本機贏衝突（編輯那台為準）；下載＝union、雲端贏衝突（真的能「取代」，
       同時保留本機獨有的場次）。2026-07-15 之前是「單一寫者、後寫覆蓋」，該假設不成立
       （實測吃掉 5 場結算＋一整天卡片）；2026-07-15~17 間下載曾誤用「本機贏」，
       造成電腦上傳的燈號/賠率蓋不進手機。見 mergeDocs() 的註解。
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
  // 本機主檔自 2026-07-13 起以 "gz:"+base64(gzip) 存放（省 localStorage 配額）。
  // 雲端格式維持「gzip(純 JSON)」不變 → 上傳前先還原成純 JSON，跨裝置與分析腳本都不受影響。
  async function localDocPlain() {
    var raw = '';
    try { raw = localStorage.getItem(DOC_KEY) || ''; } catch (e) { return ''; }
    if (raw.slice(0, 3) !== 'gz:') return raw;
    var bin = atob(raw.slice(3)); var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return await gunzipBytes(u);
  }

  /* ── 合併：union，衝突由 keeper 贏 ──────────────────────────────────
     為什麼不能直接覆蓋（本檔原本的「單一寫者、後寫覆蓋」假設）：
     2026-07-15 實測到真實損失 —— 14:06 電腦上傳(2547 場)，21:42 手機上傳(2545 場)，
     手機那包整個蓋掉電腦的，7/14 已結算的 5 場（含手填 STAKE 賠率）＋7/15 整天 9 張卡就這樣沒了。
     「兩台裝置各自結算不同場次」是常態不是意外（電腦結算白天場、手機結算晚上場）。

     方向（2026-07-17 修正）：
      · 上傳：keeper=本機（正在編輯的那台贏），雲端獨有的東西補進來再一起推上去。
      · 下載：keeper=雲端（剛上傳那台贏）→ 同一場的燈號/賠率/結算以雲端版「取代」本機，
        本機獨有的場次與卡片仍保留。之前下載也用本機優先，結果電腦改好的燈號永遠蓋不進手機
        （使用者實際回報「所有燈號跟賠率都沒辦法覆蓋」）。

     鍵：
      · games → sid 優先、date+teams 後備（＝板上自己的 upsert 規則 index.html:1853-1858；
        實測 2545 筆零撞鍵，雙重賽也沒撞）。同一場在兩台各自結算會拿到不同 sid，故一定要有後備鍵。
      · 卡片 → away|home|gameTime。★ 不能用 id：卡片 id 是每台裝置各自從 1 起算的計數器
        （index.html: let uid = 1），跨裝置必撞 → 搬過來的卡一定要重新配號。 */
  function gkeyOf(g) { return g.date + '|' + g.awayTeam + '|' + g.homeTeam; }
  function ikeyOf(i) { return (i.away || '') + '|' + (i.home || '') + '|' + (i.gameTime || ''); }
  // mergeDocs(giver, keeper)：以 keeper 為底（衝突 keeper 贏、純量設定跟 keeper），giver 獨有的補進來。
  function mergeDocs(giver, keeper) {
    if (!keeper || !keeper.boards) return { doc: giver, addedG: 0, addedC: 0 };
    if (!giver || !giver.boards) return { doc: keeper, addedG: 0, addedC: 0 };
    var M = JSON.parse(JSON.stringify(keeper));
    M.games = (keeper.games || []).slice();
    var sids = {}, keys = {}, addedG = 0, addedC = 0;
    M.games.forEach(function (g) { sids[g.sid] = 1; keys[gkeyOf(g)] = 1; });
    (giver.games || []).forEach(function (g) {
      if (sids[g.sid] || keys[gkeyOf(g)]) return;         // 同一場：keeper 版本優先
      M.games.push(g); sids[g.sid] = 1; keys[gkeyOf(g)] = 1; addedG++;
    });
    M.games.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    // 已結算的卡片【要】合併：結算後卡片會留在板上（使用者就是靠它回顧），上面有手點的燈號，
    // 是重建不回來的東西。先前這裡擋掉已結算的卡，實測會丟掉另一台的燈號 → 已移除。
    // 但「🧹 清除已結算的舊日期」是明確的使用者動作（整天 delete doc.boards[d]），
    // 合併不該把它撤銷 → 用日期墓碑記住，union 時跳過。
    var purged = {};
    ((keeper.purgedDates) || []).forEach(function (d) { purged[d] = 1; });
    Object.keys(giver.boards || {}).forEach(function (d) {
      var cb = giver.boards[d]; if (!cb || !cb.items) return;
      if (purged[d] && !M.boards[d]) return;              // keeper 那邊清掉過這天 → 不要搬回來
      M.boards[d] = M.boards[d] || { items: [], summaryPos: cb.summaryPos || null };
      M.boards[d].items = M.boards[d].items || [];
      var have = {}, maxId = 0;
      M.boards[d].items.forEach(function (i) { have[ikeyOf(i)] = 1; if (+i.id > maxId) maxId = +i.id; });
      cb.items.forEach(function (it) {
        if (it.type !== 'match') return;                  // 只合併比賽卡；自由擺放的隊徽不碰（純裝飾、且無穩定身分）
        if (have[ikeyOf(it)]) return;                     // 同一場的卡：keeper 優先
        var c = JSON.parse(JSON.stringify(it));
        c.id = ++maxId;                                   // ★ 重新配號（見上方註解）
        M.boards[d].items.push(c); have[ikeyOf(c)] = 1; addedC++;
      });
      M.boards[d].items.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
    });
    var tomb = {};
    ((keeper.purgedDates) || []).concat((giver.purgedDates) || []).forEach(function (d) { tomb[d] = 1; });
    M.purgedDates = Object.keys(tomb);
    M.gamesVersion = (M.gamesVersion || 0) + 1;
    return { doc: M, addedG: addedG, addedC: addedC };
  }
  // 讀雲端現況（公開 repo 免權杖）。回傳 null＝雲端還沒有檔案；throw＝讀取失敗（呼叫端要當回事）
  async function fetchCloudDoc(pat) {
    var headers = { 'Accept': 'application/vnd.github.raw' };
    if (pat) headers['Authorization'] = 'Bearer ' + pat;
    var r = await fetch(API + '?ref=' + BRANCH + '&t=' + Date.now(), { headers: headers });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return JSON.parse(await gunzipBytes(new Uint8Array(await r.arrayBuffer())));
  }

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
    // 守門：本機儲存失敗(配額爆掉)時 localStorage 是「舊資料」，上傳等於把舊的推上雲端蓋掉好的。
    if (window.__boardSaveOK === false) {
      alert('⚠ 不能上傳：本機儲存空間已滿，localStorage 裡是「舊資料」，現在上傳會把雲端的蓋成舊的。\n\n請先「⋯ → 匯出備份檔」保住現在的資料，再清理空間。');
      return;
    }
    var doc = '';
    try { doc = await localDocPlain(); } catch (e) { alert('讀取本機盤面失敗：' + e.message); return; }
    if (!doc) { alert('本機沒有盤面資料可上傳。'); return; }
    var pat = ensurePAT(); if (!pat) return;
    toast('讀取雲端並合併中…');
    try {
      // 先把雲端那份合併進來，再寫回去。直接覆蓋會吃掉另一台裝置的結算成果（見 mergeDocs 註解）。
      var localDoc = JSON.parse(doc), merged = null;
      try {
        var cloudDoc = await fetchCloudDoc(pat);
        merged = mergeDocs(cloudDoc, localDoc);
      } catch (e) {
        if (!confirm('讀不到雲端現況（' + e.message + '），沒辦法合併。\n\n' +
          '要「直接覆蓋」雲端嗎？如果另一台裝置有你這台沒有的結算，會被蓋掉。\n\n' +
          '確定＝覆蓋　取消＝先不要上傳（建議）')) { toast('已取消上傳'); return; }
        merged = { doc: localDoc, addedG: 0, addedC: 0 };
      }
      if (merged.addedG || merged.addedC) toast('從雲端合併回 ' + merged.addedG + ' 場結算、' + merged.addedC + ' 張卡…');
      var content = b64encode(await gzipStr(JSON.stringify(merged.doc)));
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
      if (put.ok) {
        toast('已上傳 ✓' + (merged.addedG || merged.addedC ? '（合併回 ' + merged.addedG + ' 場結算、' + merged.addedC + ' 張卡）' : ''));
        // 合併結果也寫回本機，否則這台會一直缺另一台的資料，下次又要重合併一次
        if (merged.addedG || merged.addedC) {
          try { localStorage.setItem(DOC_KEY, JSON.stringify(merged.doc)); setTimeout(function () { location.reload(); }, 1200); }
          catch (e) { alert('雲端已更新，但合併結果寫不回本機（' + e.message + '）。請先清理空間再「☁ 從 GitHub 載入盤面」。'); }
        }
      }
      else {
        var txt = await put.text(); console.warn('[GitHub同步] 上傳失敗', put.status, txt);
        if (put.status === 401 || put.status === 403) { setPAT(''); alert('上傳失敗：權杖權限不足，已清除。請重設權杖（Contents 讀寫）。'); }
        else alert('上傳失敗（HTTP ' + put.status + '）。');
      }
    } catch (err) { console.warn('[GitHub同步]', err); alert('上傳失敗：' + err.message); }
  }

  async function download() {
    if (window.closeMore) try { window.closeMore(); } catch (e) {}
    // 守門：儲存失敗時，畫面上的資料只活在記憶體、雲端是舊的 → 載入＝當天資料直接蒸發（使用者實際踩過）
    if (window.__boardSaveOK === false) {
      alert('⚠ 危險：本機儲存空間已滿，畫面上今天的資料還沒被存下來。\n現在從雲端載入會用「舊資料」覆蓋，今天的東西會全部消失。\n\n請先「⋯ → 匯出備份檔」保住現在的資料，再清理空間。');
      return;
    }
    if (!confirm('從 GitHub 載入雲端盤面（以雲端為準）。\n\n' +
      '· 同一場比賽兩邊都有 → 用「雲端版」取代這台的（燈號/賠率/結算跟著剛上傳那台走）。\n' +
      '· 這台獨有的場次與卡片會保留，不會被刪掉。\n\n確定？')) return;
    toast('載入中…');
    try {
      var pat = getPAT();
      var cloudDoc;
      try { cloudDoc = await fetchCloudDoc(pat); }
      catch (e) { alert('讀取失敗（' + e.message + '）。'); return; }
      if (cloudDoc === null) { alert('GitHub 上還沒有盤面（先在電腦按「☁ 上傳盤面到 GitHub」）。'); return; }
      // 下載＝「以雲端為準」的 union：keeper=雲端（同一場雲端贏＝真的能覆蓋），
      // 本機獨有的補回來（不會像 2026-07-15 之前的整包覆蓋那樣吃掉這台沒上傳的結算）。
      // ⚠ 之前這裡 keeper=本機 → 手機上已存在的卡永遠留手機舊燈號，電腦改的蓋不進來（使用者實際回報）。
      var localDoc = null;
      try { var lp = await localDocPlain(); if (lp) localDoc = JSON.parse(lp); } catch (e) { localDoc = null; }
      var merged = mergeDocs(localDoc, cloudDoc);
      if (!merged.doc || !merged.doc.boards) { alert('合併結果不合法，已中止，沒有動到這台的資料。'); return; }
      localStorage.setItem(DOC_KEY, JSON.stringify(merged.doc));
      toast('已載入雲端盤面' + ((merged.addedG || merged.addedC) ? '（保留這台獨有 ' + merged.addedG + ' 場結算、' + merged.addedC + ' 張卡）' : '') + '，重新整理中…');
      setTimeout(function () { location.reload(); }, 1200);
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
  window.__ghSync = { gzipStr: gzipStr, gunzipBytes: gunzipBytes, b64encode: b64encode, localDocPlain: localDocPlain, upload: upload, download: download, mergeDocs: mergeDocs };
})();
