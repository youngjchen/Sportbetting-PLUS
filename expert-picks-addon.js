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
  var REFRESH_MS = 10 * 60 * 1000;
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
    hdGive: function (it) { return '讓分 · ' + (it.hdFav === 'away' ? it.away : it.home); },
    hdRecv: function (it) { return '受讓 · ' + (it.hdFav === 'away' ? it.home : it.away); },
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
    return {
      rows: rows, total: picks.length,
      totalNew: rows.reduce(function (s, r) { return s + r.newCount; }, 0),
      totalNewWeight: rows.reduce(function (s, r) { return s + r.newWeight; }, 0),
    };
  }

  /* ---- 樣式（膠囊沿用板子 .bbadge 底，加琥珀識別色；點擊不變形不位移）---- */
  var css = document.createElement('style');
  css.textContent =
    '.bbadge.ep-badge{border-color:rgba(255,179,71,.55)!important;color:#ffcf8a!important;}' +
    '.bbadge.ep-badge:hover{background:rgba(255,179,71,.14)!important;}' +
    '.bbadge.ep-badge.ep-done{border-color:rgba(255,179,71,.25)!important;color:#8a7a5e!important;}' +
    '#ep-panel{position:fixed;z-index:99998;width:300px;max-height:70vh;overflow-y:auto;background:#151a22;' +
      'border:1px solid rgba(255,179,71,.45);border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.55);' +
      'color:#e9eef5;font-size:12.5px;}' +
    '#ep-panel .ep-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a3340;' +
      'font-family:Oswald;letter-spacing:.06em;color:#ffb347;}' +
    '#ep-panel .ep-x{margin-left:auto;width:30px;height:30px;display:flex;align-items:center;justify-content:center;' +
      'cursor:pointer;border-radius:8px;color:#8a96a6;}' +
    '#ep-panel .ep-x:hover{color:#e9eef5;background:rgba(255,255,255,.06);}' +
    '#ep-panel .ep-sec{padding:8px 12px 2px;color:#9bd5ff;font-weight:700;}' +
    '#ep-panel .ep-row{display:flex;align-items:baseline;gap:7px;padding:4px 12px;line-height:1.5;}' +
    '#ep-panel .ep-row .nm{color:#e6f0ff;}' +
    '#ep-panel .ep-row .src{color:#8a96a6;font-size:11px;}' +
    '#ep-panel .ep-row .wp{margin-left:auto;font-family:Oswald;color:#28c76f;}' +
    '#ep-panel .ep-row .done{color:#5b6b80;font-size:10.5px;}' +
    '#ep-panel .ep-main{color:#ffb347;font-size:11px;}' +
    '#ep-panel .ep-ft{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #2a3340;}' +
    '#ep-panel .ep-apply{flex:1;height:38px;border:0;border-radius:9px;background:#ffb347;color:#151a22;' +
      'font-weight:800;font-size:13px;cursor:pointer;}' +
    '#ep-panel .ep-apply:disabled{opacity:.45;cursor:default;}' +
    '#ep-panel .ep-apply:active{opacity:.85;}' +
    '#ep-panel .ep-note{padding:0 12px 10px;color:#6f7f92;font-size:10.5px;line-height:1.5;}';
  document.head.appendChild(css);

  /* ---- 面板 ---- */
  function closePanel() { var p = document.getElementById('ep-panel'); if (p) p.remove(); }
  function openPanel(it, agg, x, y) {
    closePanel();
    var p = document.createElement('div'); p.id = 'ep-panel';
    var html = '<div class="ep-hd">🎯 高手明牌 ×' + agg.total + '<span class="ep-x" title="關閉">✕</span></div>';
    agg.rows.forEach(function (r) {
      html += '<div class="ep-sec">' + esc(OPT_LABEL[r.opt](it)) + ' ×' + r.list.length + '</div>';
      r.list.forEach(function (pk) {
        var done = (it.expertApplied || {})[pk.uid + '|' + r.opt];
        html += '<div class="ep-row"><span class="nm">' + esc(pk.nickname) + '</span>' +
          (pk.main ? '<span class="ep-main">主推</span>' : '') +
          '<span class="src">' + esc(pk.srcLabel) + (pk.free ? '·免費附贈' : '') + '</span>' +
          '<span class="wp">' + esc(pk.wp) + '%' + (weightOf(pk) > 1 ? '＝+2燈' : '') + '</span>' +
          (done ? '<span class="done">已套用</span>' : '') + '</div>';
      });
    });
    html += '<div class="ep-ft"><button class="ep-apply"' + (agg.totalNewWeight ? '' : ' disabled') + '>⚡ 套用（+' + agg.totalNewWeight + ' 燈）</button></div>' +
      '<div class="ep-note">60~69% 每人 +1 燈、' + W2_WP + '%↑ 每人 +2 燈（上限 5 燈），已套用過的不重複；' +
      '門檻＝本季 ' + esc(((data || {}).thresholds || {}).wp || 60) + '%↑ 且 ≥' + esc(((data || {}).thresholds || {}).minBets || 30) + ' 注（免費附贈單同樣過門檻）。可用復原(↩)反悔。</div>';
    p.innerHTML = html;
    document.body.appendChild(p);
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800, r = p.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(vw - r.width - 8, x - r.width / 2)) + 'px';
    p.style.top = Math.max(8, Math.min(vh - r.height - 8, y + 12)) + 'px';
    p.querySelector('.ep-x').onclick = closePanel;
    var btn = p.querySelector('.ep-apply');
    btn.onclick = function () {
      if (typeof snapshot === 'function') try { snapshot(); } catch (e) {}
      it.expertApplied = it.expertApplied || {};
      agg.rows.forEach(function (rr) {
        rr.list.forEach(function (pk) {
          var key = pk.uid + '|' + rr.opt;
          if (it.expertApplied[key]) return;
          it[rr.opt] = it[rr.opt] || { lights: 0 };
          it[rr.opt].lights = Math.min(5, (it[rr.opt].lights || 0) + weightOf(pk));
          it.expertApplied[key] = 1;
        });
      });
      if (typeof save === 'function') save();
      if (typeof render === 'function') render();
      closePanel();
      badge('已套用高手明牌 ✓');
    };
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

  /* ---- 掛進卡片渲染：標頭膠囊【明牌 ×N】（與 顛倒/賽前 同一排，2026-07-18 使用者指定）---- */
  function decorate(it) {
    try {
      if (!data || !data.picks || typeof doc === 'undefined' || !doc.activeDate) return;
      var cardEl = (typeof world !== 'undefined' ? world : document).querySelector('.card[data-id="' + it.id + '"]');
      if (!cardEl || cardEl.querySelector('.ep-badge')) return;
      var head = cardEl.querySelector('.bhead');
      if (!head) return;
      var picks = picksForCard(it, doc.activeDate, data.picks);
      if (!picks.length) return;
      var agg = aggregate(it, picks);
      var pill = document.createElement('button');
      pill.className = 'bbadge ep-badge' + (agg.totalNewWeight ? '' : ' ep-done');
      pill.textContent = '明牌 ×' + agg.total;
      pill.title = '找高手明牌（本季 60%↑ 合格者）— 點看名單與套用' + (agg.totalNewWeight ? '' : '（已全部套用）');
      pill.onclick = function (ev) {
        ev.stopPropagation();
        openPanel(it, aggregate(it, picksForCard(it, doc.activeDate, data.picks)), ev.clientX, ev.clientY);
      };
      // 插在「賽前」膠囊前（顛倒那一排）；找不到就放在收合鈕前
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
  function boot() { fetchFeed(); setInterval(fetchFeed, REFRESH_MS); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__expertPicks = { picksForCard: picksForCard, aggregate: aggregate, optOf: optOf, weightOf: weightOf, _setData: function (d) { data = d; } };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { picksForCard: picksForCard, aggregate: aggregate, optOf: optOf, weightOf: weightOf };
  }
})();
