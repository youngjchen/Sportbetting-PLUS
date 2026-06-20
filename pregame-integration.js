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

  // 跟你的 odds add-on 同樣的抓法：raw 主、Pages 相對路徑備援（不用另外設分支）
  var REPO = 'youngjchen/Sportbetting-PLUS';   // owner/repo（改名要同步改）
  var BRANCH = 'main';
  var FEED_URL = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/data/pregame_data.json';
  var FEED_FALLBACK = './data/pregame_data.json';

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
  function findGame(data, it, activeDate) {                     // 不限狀態：未開賽場才有 ERA，要能撈到
    if (!Array.isArray(data) || !it) return null;
    for (var i = 0; i < data.length; i++) {
      var g = data[i];
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
    // 設定（提前宣告：下面 load()/setInterval 會立刻用到，var 雖提升但賦值須在使用前）
    var AUTO_SETTLE = true;          // 全自動結算；不想要就設 false
    var SWEEP_MS = 180000;           // 每 3 分：重抓資料 + 掃描結算 + 更新即時比分面板
    // 即時比分浮動面板狀態（僅本次連線有效，重整會重置）
    var psDismissed = {};            // 你手動移除的「已結束」場：officialId → true
    var psExpanded = {};             // 展開逐局的場：officialId → true
    var psCollapsed = false;         // 面板是否收合成一條

    function fetchJson(url) {
      return fetch(url + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }
    function load() {
      fetchJson(FEED_URL)
        .catch(function () { return fetchJson(FEED_FALLBACK); })   // raw 失敗就改用 Pages 相對路徑
        .then(function (arr) {
          DATA = Array.isArray(arr) ? arr : []; loaded = true; console.log('[玩運彩融合] 載入', DATA.length, '場');
          try { renderPanel(); } catch (e) {}                       // 更新即時比分面板
          if (AUTO_SETTLE) setTimeout(autoSettleSweep, 1000);      // 載入後先掃一次（等板子就緒）
        })
        .catch(function (e) { console.warn('[玩運彩融合] 載入失敗（結算照常運作）:', e.message); });
    }
    load();
    setInterval(function () { load(); }, SWEEP_MS);                // 定時重抓最新資料，抓完再觸發掃描

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
      // doc 在板子裡是 let 宣告（全域語彙變數，不在 window 上）→ 必須讀裸 doc，像 odds add-on 那樣
      var activeDate = null;
      try { if (typeof doc !== 'undefined' && doc && doc.activeDate) activeDate = doc.activeDate; } catch (e) {}
      if (!activeDate && global.doc && global.doc.activeDate) activeDate = global.doc.activeDate;
      var g = findGame(DATA, it, activeDate);
      if (!g) return;                                                       // 沒對應場：完全不動

      var isFinal = g.status === 'finished';
      // 比分：只在「真正結束」才填（進行中是即時比分、未開賽沒比分，都不能當終場）
      var sFilled = isFinal ? ((fillIfEmpty('settleAwayScore', g.awayScore) | fillIfEmpty('settleHomeScore', g.homeScore)) ? true : false) : false;
      // ERA：只要有值就填（未開賽場才抓得到，這正是 ERA 驗證需要的時機）
      var hasEra = (g.awayERA || 0) > 0 || (g.homeERA || 0) > 0;
      if (hasEra) { fillIfEmpty('settleEraAway', g.awayERA); fillIfEmpty('settleEraHome', g.homeERA); }
      // 運彩盤口數值：讓分盤口→#settleHdVal、大小基準→#settleTotVal（填完觸發板子自動判讓分/大小）
      var lh = g.lotteryHandicap || {};
      var hdLine = (lh.line != null) ? lh.line : null;
      var totLine = (g.lotteryTotal != null) ? g.lotteryTotal : null;
      var hdFilled = hdLine != null ? fillIfEmpty('settleHdVal', hdLine) : false;
      var totFilled = totLine != null ? fillIfEmpty('settleTotVal', totLine) : false;
      var flip = buildFlipHint(g, it);

      var statusTxt = isFinal ? '已結束' : (g.status === 'inprogress' ? '進行中' : '未開賽');
      var scoreLine = (isFinal && g.awayScore != null && g.homeScore != null)
        ? ('比分 ' + g.awayScore + ' : ' + g.homeScore + (sFilled ? '（已帶入）' : '（你已填，未覆蓋）'))
        : ('比分 尚未結束（' + statusTxt + '，不帶比分）');
      var eraLine = hasEra
        ? ('先發 ERA 客 ' + g.awayERA + '／主 ' + g.homeERA + '（已帶入）')
        : '先發 ERA 無資料（賽前未抓到）';
      // 盤口行（運彩＝台彩盤口，非 STAKE；若你下的 STAKE 盤不同請自行改）
      var lineBits = [];
      if (hdLine != null) lineBits.push('讓分盤口 ' + hdLine);
      if (totLine != null) lineBits.push('大小基準 ' + totLine);
      var lineLine = lineBits.length
        ? ('運彩盤口：' + lineBits.join('／') + '（已帶入，台彩盤口非 STAKE，可改）')
        : '運彩盤口：賽前未抓到';
      var flipColor = flip.state === 'flip' ? '#ffb02e' : '#8aa0b4';

      var el = document.createElement('div');
      el.className = 'ps-banner';
      el.style.cssText = 'background:#13202c;border:1px solid #214055;border-left:3px solid #3aa0ff;border-radius:8px;padding:9px 11px;margin-bottom:12px;font-size:12.5px;line-height:1.75;color:#cfe3f2;';
      el.innerHTML =
        '<div style="font-weight:700;color:#7ec3ff;margin-bottom:2px;">玩運彩 ' + norm(g.date) + '（' + statusTxt + '）　藍框=自動填，可改</div>'
        + '<div>' + scoreLine + '</div>'
        + '<div>' + eraLine + '</div>'
        + '<div>' + lineLine + '</div>'
        + '<div style="margin-top:2px;">顛倒判定：<b style="color:' + flipColor + ';">' + flip.text + '</b>'
        + (flip.state === 'flip' ? '　<span style="color:#8aa0b4;">（勾選由你決定）</span>' : '') + '</div>';
      body.insertBefore(el, body.firstChild);
    }

    // ===== 即時比分浮動面板 =====
    function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
    function num0(v) { return v == null ? '' : v; }
    // 要顯示的場：進行中（永遠）＋ 已結束（未被你移除的）；進行中排前面，再依開賽時間
    function psScoreList() {
      return (DATA || []).filter(function (g) {
        if (g.status === 'inprogress') return true;
        if (g.status === 'finished' && !psDismissed[g.officialId]) return true;
        return false;
      }).sort(function (a, b) {
        var ai = a.status === 'inprogress' ? 0 : 1, bi = b.status === 'inprogress' ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return String(a.time || '').localeCompare(String(b.time || ''));
      });
    }
    function psLineTable(g) {
      var ls = g.lineScore;
      if (!ls || !ls.away) return '<div style="color:#6f8597;padding:3px 2px;">尚無逐局</div>';
      var n = Math.max(ls.away.length, ls.home.length);
      var th = function (t) { return '<td style="padding:1px 4px;text-align:center;color:#5f7587;">' + t + '</td>'; };
      var cell = function (v) { return '<td style="padding:1px 4px;text-align:center;color:#bcd3e6;">' + (v == null || v === '' ? '·' : esc(v)) + '</td>'; };
      var head = '<td style="padding:1px 4px;"></td>';
      for (var i = 1; i <= n; i++) head += th(i);
      head += '<td style="padding:1px 5px;text-align:center;color:#7ec3ff;border-left:1px solid #2a4357;">R</td>' + th('H') + th('E');
      var rowOf = function (name, arr, rhe) {
        var tds = '<td style="padding:1px 5px;color:#9fb6c9;white-space:nowrap;">' + esc(name) + '</td>';
        for (var i = 0; i < n; i++) tds += cell(arr[i]);
        var R = rhe ? num0(rhe.r) : '', H = rhe ? num0(rhe.h) : '', E = rhe ? num0(rhe.e) : '';
        tds += '<td style="padding:1px 5px;text-align:center;color:#e7f1fb;font-weight:700;border-left:1px solid #2a4357;">' + R + '</td>'
             + '<td style="padding:1px 4px;text-align:center;color:#9fb6c9;">' + H + '</td>'
             + '<td style="padding:1px 4px;text-align:center;color:#9fb6c9;">' + E + '</td>';
        return '<tr>' + tds + '</tr>';
      };
      return '<table style="border-collapse:collapse;font-size:11px;margin:2px 0 3px;">'
        + '<tr>' + head + '</tr>' + rowOf(g.awayTeam, ls.away, ls.awayRHE) + rowOf(g.homeTeam, ls.home, ls.homeRHE) + '</table>';
    }
    function psRowHtml(g) {
      var fin = g.status === 'finished';
      var as = g.awayScore == null ? '–' : g.awayScore;
      var hs = g.homeScore == null ? '–' : g.homeScore;
      var chip = fin ? '結束' : (g.inning || '進行中');
      var chipBg = fin ? '#37475a' : '#1f6f4a', chipFg = fin ? '#b9c9d6' : '#7df0b0';
      var x = fin ? '<span class="ps-x" data-oid="' + esc(g.officialId) + '" title="從面板移除" style="margin-left:5px;color:#7d92a3;cursor:pointer;font-weight:700;padding:0 3px;">✕</span>' : '';
      var head =
        '<div class="ps-row" data-oid="' + esc(g.officialId) + '" style="display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;border-top:1px solid #1b2c3a;">'
        +   '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#dcebf8;font-size:12.5px;">'
        +     esc(g.awayTeam) + ' <b style="color:#fff;">' + as + '</b> <span style="color:#5f7587;">:</span> <b style="color:#fff;">' + hs + '</b> ' + esc(g.homeTeam)
        +   '</span>'
        +   '<span style="font-size:10.5px;padding:1px 6px;border-radius:8px;background:' + chipBg + ';color:' + chipFg + ';white-space:nowrap;">' + esc(chip) + '</span>' + x
        + '</div>';
      var detail = psExpanded[g.officialId] ? '<div style="padding:0 8px 5px;overflow-x:auto;">' + psLineTable(g) + '</div>' : '';
      return head + detail;
    }
    function psCreateShell() {
      var p = document.createElement('div');
      p.id = 'ps-live-panel';
      p.style.cssText = 'position:fixed;top:66px;right:14px;width:236px;max-height:62vh;display:flex;flex-direction:column;z-index:9998;background:#101c27;border:1px solid rgba(33,66,85,.6);border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.45);font-family:inherit;overflow:hidden;';
      p.innerHTML =
        '<div class="ps-head" style="display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;background:#13202c;border-bottom:1px solid rgba(33,66,85,.4);user-select:none;">'
        +   '<span class="ps-caret" style="color:#7ec3ff;font-size:11px;">▾</span>'
        +   '<span style="font-weight:700;color:#7ec3ff;font-size:12.5px;">即時比分</span>'
        +   '<span class="ps-count" style="color:#8aa0b4;font-size:11.5px;flex:1;"></span>'
        + '</div>'
        + '<div class="ps-body" style="overflow-y:auto;"></div>';
      document.body.appendChild(p);
      p.addEventListener('click', function (ev) {
        var t = ev.target;
        var x = t.closest ? t.closest('.ps-x') : null;
        if (x) { psDismissed[x.getAttribute('data-oid')] = true; renderPanel(); return; }   // 移除已結束場
        if (t.closest && t.closest('.ps-head')) { psCollapsed = !psCollapsed; renderPanel(); return; }  // 收合/展開面板
        var row = t.closest ? t.closest('.ps-row') : null;
        if (row) { var oid = row.getAttribute('data-oid'); psExpanded[oid] = !psExpanded[oid]; renderPanel(); }  // 展開逐局
      });
      return p;
    }
    function renderPanel() {
      if (typeof document === 'undefined') return;
      var list = psScoreList();
      var p = document.getElementById('ps-live-panel');
      if (!list.length) { if (p) p.style.display = 'none'; return; }   // 沒有進行中/未移除的已結束 → 整個藏起來
      if (!p) p = psCreateShell();
      p.style.display = 'flex';
      var liveN = list.filter(function (g) { return g.status === 'inprogress'; }).length;
      p.querySelector('.ps-count').textContent = '(' + (liveN ? liveN + ' 進行中' : list.length + ' 場') + ')';
      p.querySelector('.ps-caret').textContent = psCollapsed ? '▸' : '▾';
      var body = p.querySelector('.ps-body');
      if (psCollapsed) { body.style.display = 'none'; return; }
      body.style.display = 'block';
      body.innerHTML = list.map(psRowHtml).join('');
    }

    // ===== 全自動結算 =====（AUTO_SETTLE / SWEEP_MS 已於頂端宣告）
    function getDoc() {
      try { if (typeof doc !== 'undefined' && doc) return doc; } catch (e) {}
      return global.doc || null;
    }
    function psToast(msg) {
      var t = document.getElementById('ps-toast');
      if (!t) {
        t = document.createElement('div'); t.id = 'ps-toast';
        t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#13202c;border:1px solid #3aa0ff;color:#cfe3f2;padding:9px 13px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .6s;';
        document.body.appendChild(t);
      }
      t.textContent = msg; t.style.opacity = '1';
      clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; }, 4500);
    }
    function allPicked(body) {
      return ['ml', 'hd', 'tot'].every(function (k) { return body.querySelector('.settle-q[data-key="' + k + '"] .opt.on'); });
    }
    // 結算單場：驅動板子自己的結算視窗（隱藏進行），缺項就放棄
    function autoSettleOne(it) {
      if (typeof global.openSettleModal !== 'function') return false;
      var modal = $('settleModal'); var prev = modal ? modal.style.display : '';
      if (modal) modal.style.display = 'none';                 // 全程隱藏，不閃畫面
      try {
        global.openSettleModal(it);                            // 板子渲染 + 我的 hook 帶值 + autoFill 自動點選
        var a = $('settleAwayScore'), h = $('settleHomeScore'), body = $('settleBody');
        if (!body || !a || !h || a.value === '' || h.value === '' || !allPicked(body)) {
          if (modal) modal.classList.remove('show'); return false;   // 缺比分/缺選項(走盤) → 交人工
        }
        var btn = $('settleConfirm'); if (!btn) { if (modal) modal.classList.remove('show'); return false; }
        btn.click();                                           // 走板子自己的結算流程（applySettlement）
        return true;
      } catch (e) { console.warn('[玩運彩融合] 自動結算單場失敗:', e); if (modal) modal.classList.remove('show'); return false; }
      finally { if (modal) modal.style.display = prev; }
    }
    function autoSettleSweep() {
      if (!AUTO_SETTLE || !loaded) return;
      var modal = $('settleModal');
      if (modal && modal.classList.contains('show') && modal.style.display !== 'none') return;  // 你正在手動結算 → 不打擾
      var d = getDoc(); if (!d || !d.boards) return;
      var n = 0;
      Object.keys(d.boards).forEach(function (date) {
        var items = (d.boards[date] && d.boards[date].items) || [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (!it || it.type !== 'match' || it.settled) continue;
          if (it.hdVal == null || it.hdVal === '' || it.totVal == null || it.totVal === '') continue;  // 只結算已填 STAKE 線的卡
          var g = findGame(DATA, it, date);
          if (!g || g.status !== 'finished' || g.awayScore == null || g.homeScore == null) continue;
          // 走盤(push) → 交人工
          var basis = parseFloat(it.totVal);
          if (!isNaN(basis) && (g.awayScore + g.homeScore) === basis) continue;
          var line = Math.abs(parseFloat(it.hdVal));
          var favS = it.hdFav === 'away' ? g.awayScore : g.homeScore;
          var undS = it.hdFav === 'away' ? g.homeScore : g.awayScore;
          if (!isNaN(line) && (favS - undS) === line) continue;
          if (autoSettleOne(it)) n++;
        }
      });
      if (n > 0) { console.log('[玩運彩融合] 自動結算', n, '場'); psToast('玩運彩：已自動結算 ' + n + ' 場'); }
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
    global.__psFusion = { inject: inject, _setData: function (d) { DATA = d || []; loaded = true; }, findGame: findGame, buildFlipHint: buildFlipHint, autoSettleSweep: autoSettleSweep, autoSettleOne: autoSettleOne, renderPanel: renderPanel, psScoreList: psScoreList };
  }

  // ---- 測試匯出 ----
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { teamMatch, dateEq, findGame, buildFlipHint, alias };
  }
})(typeof window !== 'undefined' ? window : globalThis);
