/* ============================================================
   排盤板 ⇄ 找高手明牌 add-on（DEMO：徽章＋面板＋一鍵套用）
   資料：data/expert_picks.json（expert_picks.js 每 2 小時抓一次）
   呈現：卡片尾端一條「🎯 明牌 ×N」窄條（與盤口動向同樣的區塊式呈現，
        不覆蓋既有控件、點擊不位移）；點開 → 面板列出各市場的高手與勝率；
        「⚡ 套用」把每位【尚未套用過的】高手 +1 燈到對應選項（上限 5 燈），
        絕不自動點燈——套用永遠是使用者的動作。
   歸類（使用者規則）：國際盤讓分→獨贏、大小→大/小；運彩盤 讓分/大小/不讓分→讓分/大小/獨贏。
   用法：index.html 末尾 <script src="./expert-picks-addon.js?v=..."></script>
   ============================================================ */
(function () {
  'use strict';
  if (window.__expertPicksLoaded) return; window.__expertPicksLoaded = true;

  var REPO = 'youngjchen/Sportbetting-PLUS';
  var FEED_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/data/expert_picks.json';
  var FEED_FALLBACK = './data/expert_picks.json';
  var REFRESH_MS = 5 * 60 * 1000;   // 賽前終盤資料要在開賽前 20 分到板上 → 5 分刷新（檔案僅 ~200KB）
  var TOL_MIN = 120;
  var data = null;

  /* ---- 工具 ---- */
  function hhmmToMin(s) { var m = /(\d{1,2}):(\d{2})/.exec(s == null ? '' : String(s)); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function minDiff(a, b) { var x = hhmmToMin(a), y = hhmmToMin(b); return (x == null || y == null) ? null : Math.abs(x - y); }
  var ALIAS = { '華老鷹': '韓華鷹' };
  function tmEq(a, b) {
    a = String(a == null ? '' : a).trim(); b = String(b == null ? '' : b).trim();
    a = ALIAS[a] || a; b = ALIAS[b] || b;
    return !!a && !!b && (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  /* ---- 配對＋聚合（純函式，供測試）---- */
  function picksForCard(it, dateKey, allPicks) {
    if (!it || it.type !== 'match' || !allPicks) return [];
    var lg = null;
    try { if (typeof leagueOf === 'function') lg = leagueOf(it); } catch (e) {}
    return allPicks.filter(function (p) {
      if (p.date !== dateKey) return false;
      if (lg && p.league && p.league !== lg) return false;
      var straight = tmEq(p.away, it.away) && tmEq(p.home, it.home);
      var swapped = tmEq(p.away, it.home) && tmEq(p.home, it.away);
      if (!straight && !swapped) return false;
      var d = minDiff(p.time, it.gameTime);
      return d == null || d <= TOL_MIN;                       // 雙重賽靠時間分場；缺時間就從寬
    });
  }
  // pick → 卡片選項鍵
  function optOf(it, p) {
    if (p.market === 'ou') return p.side === 'over' ? 'over' : 'under';
    if (!p.team) return null;
    if (p.market === 'ml') return tmEq(p.team, it.away) ? 'mlAway' : (tmEq(p.team, it.home) ? 'mlHome' : null);
    var favTeam = it.hdFav === 'away' ? it.away : it.home;     // hd：卡片讓方(STAKE)那排=hdGive
    if (tmEq(p.team, favTeam)) return 'hdGive';
    return (tmEq(p.team, it.away) || tmEq(p.team, it.home)) ? 'hdRecv' : null;
  }
  var OPT_LABEL = {
    mlAway: function (it) { return '獨贏 · ' + it.away; }, mlHome: function (it) { return '獨贏 · ' + it.home; },
    // 讓分：有台彩線就顯示「隊名 帶號線」（顛倒場時與卡片列正負號可能相反＝高手實際下的邊）
    hdGive: function (it, r) { var t = it.hdFav === 'away' ? it.away : it.home;
      return (r && r.tipLine != null) ? t + ' ' + (r.tipLine > 0 ? '+' : '') + r.tipLine : '讓分 · ' + t; },
    hdRecv: function (it, r) { var t = it.hdFav === 'away' ? it.home : it.away;
      return (r && r.tipLine != null) ? t + ' ' + (r.tipLine > 0 ? '+' : '') + r.tipLine : '受讓 · ' + t; },
    over: function () { return '大分'; }, under: function () { return '小分'; },
  };
  // 權重：本季 70%+ 的高手一注抵兩燈（2026-07-18 使用者拍板）；60~69% 一燈。
  var W2_WP = 70;
  function weightOf(p) { return (p.wp >= W2_WP) ? 2 : 1; }
  function aggregate(it, picks) {
    var applied = it.expertApplied || {};
    var by = {}, order = ['mlAway', 'mlHome', 'hdGive', 'hdRecv', 'over', 'under'];
    picks.forEach(function (p) {
      var opt = optOf(it, p); if (!opt) return;
      var g = by[opt] = by[opt] || { opt: opt, list: [], newCount: 0, newWeight: 0 };
      g.list.push(p);
      if (!applied[p.uid + '|' + opt]) { g.newCount++; g.newWeight += weightOf(p); }
    });
    var rows = order.filter(function (k) { return by[k]; }).map(function (k) { return by[k]; });
    // 讓分明牌帶「高手自己的台彩線」（多數決）：顛倒場時卡片列(STAKE)的正負號與台彩相反，
    // 標籤/判定一律以這條線為準，不借用卡片列的角色（2026-07-19 遊騎兵@勇士誤判案）。
    rows.forEach(function (r) {
      var cnt = {};
      r.list.forEach(function (p) { if (p.line != null) cnt[p.line] = (cnt[p.line] || 0) + 1; });
      var ks = Object.keys(cnt);
      if (ks.length) r.tipLine = +ks.sort(function (a, b) { return cnt[b] - cnt[a]; })[0];
    });
    return {
      rows: rows, total: picks.length,
      totalNew: rows.reduce(function (s, r) { return s + r.newCount; }, 0),
      totalNewWeight: rows.reduce(function (s, r) { return s + r.newWeight; }, 0),
    };
  }

  /* ---- 樣式（膠囊沿用板子 .bbadge 底，加琥珀識別色；點擊不變形不位移）----
     每列明牌膠囊＝固定 64px 網格欄（燈號後、注之前）。關鍵：欄位是「固定插進 grid 模板」的，
     且每一列（含零明牌的列）都渲染佔位格 → 所有列/所有卡片的欄位 x 座標恆等，不可能歪
     （2026-07-18 使用者對 DEMO 的一致性要求）。原模板 28|minmax(88,126)|max-content|24|48，
     實測內容 381px、卡內餘裕 ~100px → 插 64px 安全不溢出。 */
  var css = document.createElement('style');
  css.textContent =
    // .card 前綴＝特異度 (0,2,0)：板子主樣式表比本 add-on 晚掛進 head（實測 sheet#5 vs #3），
    // 同特異度會輸在來源順序 → 用特異度贏，不用 !important。
    '.card .bmkt-row{grid-template-columns:28px minmax(88px,126px) max-content 64px 24px 48px;}' +
    '.ep-cell{width:64px;display:flex;justify-content:flex-start;align-items:center;}' +
    // 標靶改純 CSS 同心圓：emoji 🎯 的字形基線天生偏離水平中線（2026-07-19 使用者反映），
    // CSS 圓形無基線問題，flex 置中＝幾何中心＝光學中心。line-height:1 讓數字也貼齊中線。
    '.ep-cell .ep-n{display:inline-flex;align-items:center;gap:4px;font-family:Oswald;font-weight:700;' +
      'font-size:12.5px;line-height:1;letter-spacing:.02em;color:#ffcf8a;background:rgba(255,176,46,.10);' +
      'border:1px solid rgba(255,176,46,.42);border-radius:999px;padding:3px 8px;cursor:pointer;' +
      'white-space:nowrap;font-variant-numeric:tabular-nums;}' +
    '.ep-cell .ep-n::before{content:"";width:10px;height:10px;border-radius:50%;flex:0 0 auto;' +
      'background:radial-gradient(circle,#ffd88a 0 2px,rgba(255,176,46,.15) 2px 3.2px,rgba(255,176,46,.95) 3.2px 4.6px,transparent 4.6px);}' +
    '.ep-cell .ep-n:hover{background:rgba(255,176,46,.2);}' +
    '.ep-cell .ep-n .st{color:#ffd873;font-size:11px;}' +
    '.bbadge.ep-badge{border-color:rgba(255,179,71,.55)!important;color:#ffcf8a!important;}' +
    '.bbadge.ep-badge:hover{background:rgba(255,179,71,.14)!important;}' +
    '.bbadge.ep-badge.ep-done{border-color:rgba(255,179,71,.25)!important;color:#8a7a5e!important;}' +
    // 面板放大版（2026-07-20 使用者要求）：min(460px,92vw)、字級整體 +2，行高加大
    '#ep-panel{position:fixed;z-index:99998;width:min(460px,92vw);max-height:76vh;overflow-y:auto;background:#151a22;' +
      'border:1px solid rgba(255,179,71,.45);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.6);' +
      'color:#e9eef5;font-size:14.5px;}' +
    '#ep-panel .ep-hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2a3340;' +
      'font-family:Oswald;letter-spacing:.06em;color:#ffb347;font-size:15px;}' +
    '#ep-panel .ep-x{width:32px;height:32px;display:flex;align-items:center;justify-content:center;' +
      'cursor:pointer;border-radius:8px;color:#8a96a6;flex:0 0 auto;}' +
    '#ep-panel .ep-x:hover{color:#e9eef5;background:rgba(255,255,255,.06);}' +
    '#ep-panel .ep-upd{margin-left:auto;font-size:12px;font-weight:600;color:#8fa3b8;letter-spacing:.02em;}' +
    '#ep-panel .ep-hd .ep-upd+.ep-x{margin-left:6px;}' +
    // 排序切換（勝率/時間）：只影響各市場組內列序，市場分組順序不動
    '#ep-panel .ep-srt{font-size:12.5px;font-weight:700;color:#8a96a6;border:1px solid #2a3340;border-radius:999px;' +
      'padding:3px 10px;cursor:pointer;letter-spacing:.04em;flex:0 0 auto;}' +
    '#ep-panel .ep-srt:hover{color:#e9eef5;background:rgba(255,255,255,.05);}' +
    '#ep-panel .ep-srt.on{color:#1a1205;background:#ff9f43;border-color:#ff9f43;}' +
    '#ep-panel .ep-sec{padding:10px 14px 3px;color:#9bd5ff;font-weight:700;font-size:14.5px;}' +
    '#ep-panel .ep-row{display:flex;align-items:baseline;gap:8px;padding:5px 14px;line-height:1.55;}' +
    '#ep-panel .ep-row .nm{color:#e6f0ff;}' +
    '#ep-panel .ep-row .src{color:#8a96a6;font-size:12px;}' +
    '#ep-panel .ep-row .wp{margin-left:auto;font-family:Oswald;color:#28c76f;font-size:15px;}' +
    '#ep-panel .ep-row .done{color:#5b6b80;font-size:11px;}' +
    '#ep-panel .ep-main{color:#ffb347;font-size:12px;}' +
    '#ep-panel .ep-row .tm{font-family:Oswald;font-size:12px;color:#6f7f92;letter-spacing:.02em;}' +
    '#ep-panel{padding-bottom:10px;}' +
    // 新推薦紅點：膠囊右上角琥珀圓點（開面板即消）
    '.bbadge.ep-badge.ep-new{position:relative;}' +
    '.bbadge.ep-badge.ep-new::after{content:"";position:absolute;top:-3px;right:-3px;width:9px;height:9px;' +
      'border-radius:50%;background:#ffb02e;box-shadow:0 0 0 2px #10151c;animation:epPulse 2s infinite;}' +
    '@keyframes epPulse{0%,100%{opacity:1}50%{opacity:.45}}' +
    '@media (prefers-reduced-motion: reduce){.bbadge.ep-badge.ep-new::after{animation:none;}}';
  document.head.appendChild(css);

  /* ---- 面板 ---- */
  var lastPanel = null;   // {it,x,y}：排序切換/資料更新時原地重建
  function closePanel() { var p = document.getElementById('ep-panel'); if (p) p.remove(); lastPanel = null; }
  // 組內排序（市場分組順序不動）：wp=勝率高→低（同勝率新單前）；at=時間新→舊（同時間勝率高前）
  var sortMode = 'wp';
  try { sortMode = localStorage.getItem('epSortMode') || 'wp'; } catch (e) {}
  function sortList(list) {
    var arr = list.slice();
    arr.sort(function (a, b) {
      var byAt = String(b.at || '').localeCompare(String(a.at || ''));
      var byWp = (b.wp || 0) - (a.wp || 0);
      return sortMode === 'at' ? (byAt || byWp) : (byWp || byAt);
    });
    return arr;
  }
  function openPanel(it, agg, x, y) {
    closePanel();
    lastPanel = { it: it, x: x, y: y };
    var p = document.createElement('div'); p.id = 'ep-panel';
    // 資料時間戳＝爬蟲上次完抓時間（updated），手機上判斷「新一輪抓完沒」全靠這個
    var upd = (data && data.updated) ? String(data.updated).slice(5, 16).replace('T', ' ') : '';
    var html = '<div class="ep-hd">🎯 高手明牌 ×' + agg.total +
      '<span class="ep-srt' + (sortMode === 'wp' ? ' on' : '') + '" data-m="wp" title="組內按勝率排序">勝率</span>' +
      '<span class="ep-srt' + (sortMode === 'at' ? ' on' : '') + '" data-m="at" title="組內按抓到時間排序">時間</span>' +
      (upd ? '<span class="ep-upd" title="明牌資料抓取時間">' + esc(upd) + '</span>' : '') +
      '<span class="ep-x" title="關閉">✕</span></div>';
    agg.rows.forEach(function (r) {
      html += '<div class="ep-sec">' + esc(OPT_LABEL[r.opt](it, r)) + ' ×' + r.list.length + '</div>';
      sortList(r.list).forEach(function (pk) {
        // 主推榜合格者 srcLabel 就是「主推」→ 不跟主推徽章重複顯示
        var srcTxt = (pk.main && pk.srcLabel === '主推') ? '' : String(pk.srcLabel || '');
        if (pk.free) srcTxt += (srcTxt ? '·' : '') + '免費附贈';
        html += '<div class="ep-row"><span class="nm">' + esc(pk.nickname) + '</span>' +
          (pk.at ? '<span class="tm">' + esc(String(pk.at).slice(11, 16)) + '</span>' : '') +
          (pk.main ? '<span class="ep-main">主推</span>' : '') +
          (srcTxt ? '<span class="src">' + esc(srcTxt) + '</span>' : '') +
          '<span class="wp">' + (pk.wp != null ? esc(pk.wp) + '%' : '追蹤') + '</span></div>';
      });
    });
    p.innerHTML = html;
    document.body.appendChild(p);
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800, r = p.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(vw - r.width - 8, x - r.width / 2)) + 'px';
    p.style.top = Math.max(8, Math.min(vh - r.height - 8, y + 12)) + 'px';
    p.querySelector('.ep-x').onclick = closePanel;
    p.querySelectorAll('.ep-srt').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        sortMode = b.dataset.m === 'at' ? 'at' : 'wp';
        try { localStorage.setItem('epSortMode', sortMode); } catch (e) {}
        var lp = lastPanel;
        if (lp) openPanel(lp.it, currentAgg(lp.it), lp.x, lp.y);
      };
    });
    markSeen(it);   // 點開名單＝已確認新推薦 → 膠囊/導覽列紅點消
    // 套用鈕已移除（2026-07-19 使用者拍板：明牌不進燈號、與手動燈徹底分帳）
    setTimeout(function () {
      document.addEventListener('pointerdown', function h(ev) {
        if (!p.contains(ev.target)) { closePanel(); document.removeEventListener('pointerdown', h); }
      });
    }, 0);
  }
  function badge(txt) {
    var b = document.getElementById('saveBadge');
    if (b) { b.textContent = txt; b.classList.add('show'); setTimeout(function () { b.classList.remove('show'); }, 1700); }
  }

  /* ---- 新推薦追蹤（2026-07-20）----
     簽名＝該卡當日全部明牌的 uid|選項|時戳 排序串；與 doc.epSeen[卡id] 不同＝有新單 →
     膠囊右上紅點＋導覽列紅點；點開名單即標已讀（doc 走 GitHub 同步，跨裝置一致）。 */
  function dateKeyNow() { try { return (typeof doc !== 'undefined' && doc && doc.activeDate) || null; } catch (e) { return null; } }
  function currentAgg(it) { return aggregate(it, picksForCard(it, dateKeyNow(), (data && data.picks) || [])); }
  function itemSig(it, picks) {
    return picks.map(function (p) { return p.uid + '|' + (optOf(it, p) || '') + '|' + (p.at || ''); }).sort().join(';');
  }
  function hasNewFor(it) {
    try {
      var dk = dateKeyNow();
      if (!data || !data.picks || !dk) return false;
      var picks = picksForCard(it, dk, data.picks);
      if (!picks.length) return false;
      var seen = (typeof doc !== 'undefined' && doc && doc.epSeen) || {};
      return seen[String(it.id)] !== itemSig(it, picks);
    } catch (e) { return false; }
  }
  function markSeen(it) {
    try {
      var dk = dateKeyNow();
      if (!data || !data.picks || !dk || typeof doc === 'undefined' || !doc) return;
      (doc.epSeen = doc.epSeen || {})[String(it.id)] = itemSig(it, picksForCard(it, dk, data.picks));
      if (typeof save === 'function') save();
      // 原地清紅點（不重繪整板，避免把剛開的面板洗掉）
      var pill = (typeof world !== 'undefined' ? world : document).querySelector('.card[data-id="' + it.id + '"] .ep-badge');
      if (pill) pill.classList.remove('ep-new');
      document.querySelectorAll('.nvtag[data-itid="' + it.id + '"] .nv-epnew').forEach(function (x) { x.remove(); });
    } catch (e) {}
  }
  // 開面板同時抓最新資料：資料真的變了才原地重建面板（顯示最新名單與時戳）
  function refreshPanelData() {
    var u0 = data && data.updated;
    fetchFeed().then(function () {
      if (!lastPanel || !document.getElementById('ep-panel')) return;
      if ((data && data.updated) !== u0) {
        var lp = lastPanel;
        openPanel(lp.it, currentAgg(lp.it), lp.x, lp.y);
      }
    });
  }

  /* ---- 掛進卡片渲染 ----
     1) 每個市場列插「固定 64px 明牌格」：一定插（沒明牌＝空格），grid 欄數恆定 → 永不歪。
        列序固定＝renderCardB 的產出順序：獨贏客/主、讓/受讓、大/小。
     2) 標頭膠囊【明牌 ×N】維持（總覽＋面板入口）。 */
  var ROW_OPTS = ['mlAway', 'mlHome', 'hdGive', 'hdRecv', 'over', 'under'];
  function decorate(it) {
    try {
      var cardEl = (typeof world !== 'undefined' ? world : document).querySelector('.card[data-id="' + it.id + '"]');
      if (!cardEl) return;
      var rows = cardEl.querySelectorAll('.bmkt-row');
      if (!rows.length) return;                                  // 已結算卡等無市場列 → 不動
      var dateKey = (typeof doc !== 'undefined' && doc && doc.activeDate) || null;
      var picks = (data && data.picks && dateKey) ? picksForCard(it, dateKey, data.picks) : [];
      var agg = aggregate(it, picks);
      var byOpt = {};
      agg.rows.forEach(function (r) { byOpt[r.opt] = r; });
      var openIt = function (ev) {
        ev.stopPropagation();
        openPanel(it, aggregate(it, picksForCard(it, dateKey, data.picks)), ev.clientX, ev.clientY);
        refreshPanelData();   // 開面板即抓最新：抓完資料有變就原地重建（時戳/名單同步更新）
      };
      rows.forEach(function (row, i) {
        if (row.querySelector('.ep-cell')) return;               // 重繪防重
        var cell = document.createElement('span');
        cell.className = 'ep-cell no-drag';
        var g = byOpt[ROW_OPTS[i]];
        if (g) {
          var stars = g.list.filter(function (p) { return weightOf(p) > 1; }).length;
          var lineTxt = (g.tipLine != null) ? ' · 台彩 ' + (g.tipLine > 0 ? '+' : '') + g.tipLine : '';
          cell.innerHTML = '<span class="ep-n" title="明牌 ' + g.list.length + ' 人' + (stars ? '（70%+ ' + stars + ' 人）' : '') + lineTxt + ' — 點看名單">' + g.list.length +
            (stars ? '<span class="st">⭐' + stars + '</span>' : '') + '</span>';
          cell.firstChild.onclick = openIt;
        }
        row.insertBefore(cell, row.children[3] || null);         // 燈號後、注之前（第 4 欄）
      });
      // 標頭總覽膠囊
      if (!picks.length || cardEl.querySelector('.ep-badge')) return;
      var head = cardEl.querySelector('.bhead');
      if (!head) return;
      var pill = document.createElement('button');
      pill.className = 'bbadge ep-badge' + (hasNewFor(it) ? ' ep-new' : '');
      pill.textContent = '明牌 ×' + agg.total;
      pill.title = '高手明牌 — 點看名單';
      pill.onclick = openIt;
      var preB = null;
      head.querySelectorAll('button.bbadge').forEach(function (b) { if (!preB && /^賽前/.test(b.textContent)) preB = b; });
      head.insertBefore(pill, preB || head.querySelector('.bico'));
    } catch (e) { /* add-on 永不弄壞排盤板 */ }
  }
  if (typeof renderCard === 'function') {
    var _orig = renderCard;
    renderCard = function (it) { _orig(it); decorate(it); };
  }

  function fetchFeed() {
    return fetch(FEED_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { return fetch(FEED_FALLBACK + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }); })
      .then(function (j) {
        if (!j || !j.picks) return;
        var changed = !data || data.updated !== j.updated;
        data = j;
        if (changed && typeof render === 'function' &&
            !document.querySelector('#settleModal.show, #modal.show, .bpop')) render();
      }).catch(function () {});
  }
  function boot() {
    fetchFeed(); setInterval(fetchFeed, REFRESH_MS);
    // 手機回前景立即補抓：背景分頁計時器被凍結，回來要等下個 5 分刷新才會看到新明牌
    document.addEventListener('visibilitychange', function () { if (!document.hidden) fetchFeed(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ---- 重點總結明牌軌（2026-07-19 拍板：K=5 加權、主導率 70%）----
     recs＝主導側自身加權 ≥EP_K 且 加權主導率 ≥EP_DOM 的選項（反對是扣分項不是否決票）；
     splits＝兩側總加權 ≥EP_K+1 且主導率 <EP_DOM ＝「分歧」（列資訊、不進推薦、不算命中）。 */
  var EP_K = 5, EP_DOM = 0.7;
  function epStrong(it, dateKey) {
    var out = { recs: [], splits: [] };
    try {
      if (!data || !data.picks || !it || it.type !== 'match') return out;
      var agg = aggregate(it, picksForCard(it, dateKey, data.picks));
      var W = {}, N = {}, L = {};
      agg.rows.forEach(function (r) {
        W[r.opt] = r.list.reduce(function (s, p) { return s + weightOf(p); }, 0);
        N[r.opt] = r.list.length;
        if (r.tipLine != null) L[r.opt] = r.tipLine;
      });
      var fav = it.hdFav === 'away' ? it.away : it.home, und = it.hdFav === 'away' ? it.home : it.away;
      var hdv = it.hdVal ? ' ' + it.hdVal : '', totv = it.totVal ? ' ' + it.totVal : '';
      var PAIRS = [
        ['mlAway', 'mlHome', '獨贏', [it.away, '獨贏', 'ml'], [it.home, '獨贏', 'ml']],
        ['hdGive', 'hdRecv', '讓分', [fav, '讓' + hdv, 'hd'], [und, '受讓' + hdv, 'recv']],
        ['over', 'under', '大小分', ['大分', '大小分' + totv, 'tot'], ['小分', '大小分' + totv, 'tot']],
      ];
      PAIRS.forEach(function (pr) {
        var aW = W[pr[0]] || 0, bW = W[pr[1]] || 0, tot = aW + bW;
        [[pr[0], aW, bW, pr[3]], [pr[1], bW, aW, pr[4]]].forEach(function (x) {
          if (x[1] >= EP_K && x[1] / (x[1] + x[2] || 1) >= EP_DOM) {
            var tl = L[x[0]];
            // 讓分推薦的標籤用高手的台彩帶號線（顛倒場與卡片列正負相反時，這才是他們實際下的邊）
            var mk = (tl != null && (x[0] === 'hdGive' || x[0] === 'hdRecv')) ? ((tl > 0 ? '+' : '') + tl + '（台彩）') : x[3][1];
            out.recs.push({ opt: x[0], pick: x[3][0], mk: mk, market: x[3][2], w: x[1], n: N[x[0]] || 0, tipLine: tl != null ? tl : null });
          }
        });
        if (aW && bW && tot >= EP_K + 1 && Math.max(aW, bW) / tot < EP_DOM)
          out.splits.push({ market: pr[2], txt: aW + ':' + bW });
      });
    } catch (e) {}
    return out;
  }

  window.__expertPicks = { picksForCard: picksForCard, aggregate: aggregate, optOf: optOf, weightOf: weightOf, epStrong: epStrong, hasNew: hasNewFor, _setData: function (d) { data = d; } };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { picksForCard: picksForCard, aggregate: aggregate, optOf: optOf, weightOf: weightOf, epStrong: epStrong, _setData: function (d) { data = d; } };
  }
})();
