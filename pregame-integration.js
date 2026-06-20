/* ============================================================
   玩運彩賽前數據 融合 add-on（模組 A → 排盤板）
   作用：結算視窗開啟時，自動帶入玩運彩對應場的
     · 比分 → #settleAwayScore / #settleHomeScore
     · 先發 ERA → #settleEraAway / #settleEraHome（賽前抓到才有）
     · 顛倒判定 → 比對運彩讓分方 vs 你的 STAKE 讓分方，只「提示」不動勾選
   規則：只填空白欄、不覆蓋你手填的值、不自動送出、全程可改。
   不改排盤板任何邏輯，只在 openSettleModal 之後掛一層。
   用法：在 index.html 末尾、其他 add-on 旁加一行
     <script src="pregame-integration.js"></script>
   ============================================================ */
(function (global) {
  'use strict';

  // ⚠️ 確認這條跟你的 odds add-on 同一個 repo/分支（main 或 master）
  var RAW_URL = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/pregame_data.json';

  // ---- 純邏輯（可單元測試）----
  var ALIAS = { '華老鷹': '韓華鷹' };               // 玩運彩→排盤板 唯一不規則隊名
  function alias(n) { return ALIAS[n] || n; }
  function norm(s) { return (s == null ? '' : String(s)).trim(); }

  function teamMatch(boardName, scrapedName) {
    var b = norm(boardName), s = norm(alias(scrapedName));
    if (!b || !s) return false;
    return b === s || b.indexOf(s) >= 0 || s.indexOf(b) >= 0;   // 長短名雙向包含
  }
  function dateEq(d1, d2) {                                      // 精確同日（板上日期=玩運彩gamedate；系列賽不可用容差）
    d1 = norm(d1).slice(0, 10); d2 = norm(d2).slice(0, 10);
    return !!d1 && !!d2 && d1 === d2;
  }
  function findGame(data, it, activeDate) {
    if (!Array.isArray(data) || !it) return null;
    for (var i = 0; i < data.length; i++) {
      var g = data[i];
      if (g.status !== 'finished') continue;                    // 只認真正結束的場
      if (!dateEq(activeDate, g.date)) continue;
      if (teamMatch(it.away, g.awayTeam) && teamMatch(it.home, g.homeTeam)) return g;
    }
    return null;
  }
  // 顛倒提示：比 運彩讓分方(favSide) vs STAKE讓分方(it.hdFav)，皆 'home'/'away'
  // 只認賽前運彩盤口(src='運彩')；賽後 on-box 是「過盤方」不是讓分方，14/14 驗證為誤，絕不拿來判顛倒
  function buildFlipHint(g, it) {
    var lh = g.lotteryHandicap || {};
    if (lh.src !== '運彩')                       // 沒有賽前運彩盤口 → 不判（避免用過盤結果誤判）
      return { state: 'na', text: '賽前運彩盤口未抓到，暫不判顛倒（賽後過盤結果不可用於判斷）' };
    var lotFav = lh.favSide || null;             // 運彩讓分方（賽前）
    var stakeFav = it.hdFav || null;             // 你的讓分方
    var sideTxt = function (side) {
      if (side === 'home') return '主（' + norm(it.home) + '）';
      if (side === 'away') return '客（' + norm(it.away) + '）';
      return '—';
    };
    if (!lotFav) return { state: 'na', text: '玩運彩無讓分方資料' };
    if (!stakeFav) return { state: 'na', text: '你的讓分方未設定' };
    if (lotFav !== stakeFav)
      return { state: 'flip', text: '運彩讓分方=' + sideTxt(lotFav) + '，你的=' + sideTxt(stakeFav) + ' → 相反，疑顛倒場' };
    return { state: 'same', text: '運彩讓分方=' + sideTxt(lotFav) + '，與你的一致（非顛倒）' };
  }

  // ---- 瀏覽器接線 ----
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    var DATA = [], loaded = false;

    function load() {
      fetch(RAW_URL + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (arr) { DATA = Array.isArray(arr) ? arr : []; loaded = true; console.log('[玩運彩融合] 載入', DATA.length, '場'); })
        .catch(function (e) { console.warn('[玩運彩融合] 載入失敗（結算照常運作）:', e.message); });
    }
    load();

    function $(id) { return document.getElementById(id); }
    function markFilled(inp) {
      if (!inp) return;
      inp.style.borderColor = '#3aa0ff';
      inp.style.boxShadow = '0 0 0 1px rgba(58,160,255,.4)';
      inp.dataset.psFilled = '1';
    }
    function fillIfEmpty(id, val) {
      var inp = $(id);
      if (!inp || val == null || val === '') return false;
      if (inp.value !== '' && inp.value != null) return false;   // 不覆蓋手填
      inp.value = val;
      inp.dispatchEvent(new Event('input', { bubbles: true }));  // 觸發即時判讀／ERA 驗證重算
      markFilled(inp);
      return true;
    }

    function inject(it) {
      var body = $('settleBody'); if (!body) return;
      var old = body.querySelector('.ps-banner'); if (old) old.remove();   // 修改結算重開時清掉
      var activeDate = (global.doc && global.doc.activeDate) || null;
      var g = findGame(DATA, it, activeDate);
      if (!g) return;                                                       // 沒對應場：完全不動

      var sFilled = (fillIfEmpty('settleAwayScore', g.awayScore) | fillIfEmpty('settleHomeScore', g.homeScore)) ? true : false;
      var hasEra = (g.awayERA || 0) > 0 || (g.homeERA || 0) > 0;
      if (hasEra) { fillIfEmpty('settleEraAway', g.awayERA); fillIfEmpty('settleEraHome', g.homeERA); }
      var flip = buildFlipHint(g, it);

      var scoreLine = (g.awayScore != null && g.homeScore != null)
        ? ('比分 ' + g.awayScore + ' : ' + g.homeScore + (sFilled ? '（已帶入）' : '（你已填，未覆蓋）'))
        : '比分 無';
      var eraLine = hasEra
        ? ('先發 ERA 客 ' + g.awayERA + '／主 ' + g.homeERA + '（已帶入）')
        : '先發 ERA 尚未帶入（賽前未抓到，玩運彩賽後即清空）';
      var flipColor = flip.state === 'flip' ? '#ffb02e' : (flip.state === 'same' ? '#8aa0b4' : '#8aa0b4');

      var el = document.createElement('div');
      el.className = 'ps-banner';
      el.style.cssText = 'background:#13202c;border:1px solid #214055;border-left:3px solid #3aa0ff;border-radius:8px;padding:9px 11px;margin-bottom:12px;font-size:12.5px;line-height:1.75;color:#cfe3f2;';
      el.innerHTML =
        '<div style="font-weight:700;color:#7ec3ff;margin-bottom:2px;">玩運彩 ' + norm(g.date) + ' 已帶入（藍框=自動填，可改）</div>'
        + '<div>' + scoreLine + '</div>'
        + '<div>' + eraLine + '</div>'
        + '<div style="margin-top:2px;">顛倒判定：<b style="color:' + flipColor + ';">' + flip.text + '</b>'
        + (flip.state === 'flip' ? '　<span style="color:#8aa0b4;">（勾選由你決定）</span>' : '') + '</div>';
      body.insertBefore(el, body.firstChild);
    }

    function hook() {
      if (typeof global.openSettleModal !== 'function') { console.warn('[玩運彩融合] 找不到 openSettleModal'); return; }
      if (global.openSettleModal.__psHooked) return;
      var orig = global.openSettleModal;
      var wrapped = function (it) {
        var r = orig.apply(this, arguments);
        try { if (loaded && it && it.type === 'match') inject(it); }
        catch (e) { console.warn('[玩運彩融合] inject 失敗（不影響結算）:', e); }
        return r;
      };
      wrapped.__psHooked = true;
      global.openSettleModal = wrapped;
      console.log('[玩運彩融合] 已掛上 openSettleModal');
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
    else hook();

    // 供測試：注入資料 / 直接呼叫
    global.__psFusion = { inject: inject, _setData: function (d) { DATA = d || []; loaded = true; }, findGame: findGame, buildFlipHint: buildFlipHint };
  }

  // ---- 測試匯出 ----
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { teamMatch, dateEq, findGame, buildFlipHint, alias };
  }
})(typeof window !== 'undefined' ? window : globalThis);
