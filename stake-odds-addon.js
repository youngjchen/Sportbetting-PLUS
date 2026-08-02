/* ============================================================
   STAKE 賠率自動帶入 add-on（2026-08-02）
   來源：data/stake_odds.json（由 stake_lab/op_watch.py 收割後推上 repo）
   行為：結算視窗開啟時，把「初盤 / 收盤」兩列的空格自動填入 STAKE 賠率。
     · 只填空格——手填過的值永不覆蓋（手動至上，使用者鐵則）
     · 自動填的格帶 🤖 標記與淡綠底；點一下即解除自動、轉回手動格
     · 「下注賠率」列一律不碰（那是使用者實際成交價，只有本人知道）
   對調：若該場有對調紀錄，在賠率區上方顯示一行（僅記錄，不判方向——使用者 8/2 規格）
   ============================================================ */
(function () {
  'use strict';
  if (window.__stakeOddsLoaded) return; window.__stakeOddsLoaded = true;

  var SRC = 'data/stake_odds.json';
  var DB = null, RAW = '';

  function gid(it) {
    var lg = (typeof leagueOf === 'function') ? leagueOf(it) : (it.league || 'mlb');
    return lg + '|' + doc.activeDate + '|' + it.away + '|' + it.home;
  }
  function rec(it) {
    if (!DB || !DB.games || !it) return null;
    var base = gid(it);
    var tm = String(it.gameTime || '').match(/\d{1,2}:\d{2}/);
    return (tm && DB.games[base + '|' + tm[0].padStart(5, '0')]) || DB.games[base] || null;
  }

  async function load() {
    try {
      var r = await fetch(SRC + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;                       // 檔案還沒推上來＝正常，靜靜跳過
      var txt = await r.text();
      if (txt === RAW) return;
      RAW = txt; DB = JSON.parse(txt);
    } catch (e) { /* 網路/解析失敗不影響板子運作 */ }
  }

  // 自動填一格：只填空的，並標記為 auto
  function fill(id, val) {
    var el = document.getElementById(id);
    if (!el || val == null) return false;
    if (String(el.value).trim() !== '') return false;      // 已有值（手填或先前存檔）→ 不動
    el.value = val;
    el.dataset.autoFilled = '1';
    el.style.background = 'rgba(29,158,117,.14)';
    el.style.borderColor = 'rgba(29,158,117,.55)';
    el.title = 'STAKE 自動帶入（點一下改手動）';
    // 使用者一碰就轉手動（focus 在程式呼叫時不一定觸發 → 多事件保險）
    var release = function () {
      delete el.dataset.autoFilled;
      el.style.background = ''; el.style.borderColor = ''; el.title = '';
      ['focus', 'pointerdown', 'keydown', 'input'].forEach(function (ev) { el.removeEventListener(ev, release); });
    };
    ['focus', 'pointerdown', 'keydown', 'input'].forEach(function (ev) { el.addEventListener(ev, release); });
    return true;
  }

  function decorate() {
    var grid = document.querySelector('#settleBody .odds-grid');
    if (!grid || grid.dataset.stakeDone === '1') return;
    var it = (typeof settleTarget !== 'undefined' && settleTarget) ? settleTarget : null;
    if (!it) return;
    var r = rec(it);
    grid.dataset.stakeDone = '1';
    var old = document.getElementById('stakeOddsNote');
    if (old) old.remove();
    var note = document.createElement('div');
    note.id = 'stakeOddsNote';
    note.style.cssText = 'font-size:11.5px;line-height:1.7;margin:2px 0 6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    if (!r) {
      note.innerHTML = '<span style="color:var(--ink-dim)">🤖 STAKE 賠率：本場尚無資料（賽後收割完成後自動補）</span>';
    } else {
      var n = 0;
      n += fill('openOddsAway', r.openAway) ? 1 : 0;
      n += fill('openOddsHome', r.openHome) ? 1 : 0;
      n += fill('closeOddsAway', r.closeAway) ? 1 : 0;
      n += fill('closeOddsHome', r.closeHome) ? 1 : 0;
      var parts = ['<span style="color:#2bbfa0">🤖 STAKE 已帶入 ' + n + ' 格</span>'];
      if (r.closeAt) parts.push('<span style="color:var(--ink-dim)">收盤 ' + String(r.closeAt).slice(11, 16) + '</span>');
      if (r.swapAt) parts.push('<span style="color:#e0a020">⇄ ' + String(r.swapAt).slice(11, 16) + ' 對調</span>');
      note.innerHTML = parts.join('');
      if (n && typeof updateSettleOddsCalc === 'function') { try { updateSettleOddsCalc(); } catch (e) {} }
    }
    grid.parentNode.insertBefore(note, grid);
  }

  // 結算視窗是動態生成的 → 用 observer 等它出現
  var mo = new MutationObserver(function () {
    var m = document.getElementById('settleModal');
    if (m && m.classList.contains('show')) decorate();
  });
  function boot() {
    load();
    var m = document.getElementById('settleModal');
    if (m) mo.observe(m, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setInterval(load, 10 * 60 * 1000);         // 每 10 分重抓一次（收割會不定時更新）
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__stakeOdds = { load: load, rec: rec, db: function () { return DB; } };
})();
