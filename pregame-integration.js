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
  // 開球時間(台灣 HH:MM)→分鐘；雙重賽(同日同對戰兩場)用它把卡片配到正確那一場
  function hhmmToMin(s) { var m = /(\d{1,2}):(\d{2})/.exec(s == null ? '' : String(s)); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function gameHHMM(g) {                                         // 玩運彩場次的開球時間：優先 time(HH:MM)，退回 startISO
    if (g && g.time && /\d{1,2}:\d{2}/.test(g.time)) return g.time.match(/\d{1,2}:\d{2}/)[0];
    return (g && g.startISO) ? String(g.startISO).slice(11, 16) : '';
  }
  function findGame(data, it, activeDate) {                     // 不限狀態：未開賽場才有 ERA，要能撈到
    if (!Array.isArray(data) || !it) return null;
    var cands = [];
    for (var i = 0; i < data.length; i++) {
      var g = data[i];
      if (!dateEq(activeDate, g.date)) continue;
      if (teamMatch(it.away, g.awayTeam) && teamMatch(it.home, g.homeTeam)) cands.push(g);
    }
    if (!cands.length) return null;
    // 同日同對戰可能有兩場（雙重賽，或美國連兩天賽程映射到同一台灣日期）——
    // 舊版「單一候選直接回傳」會讓 23:05 的卡被早上 07:05 已完賽那場錯誤結算（2026-07-04 實際發生）。
    // 修正：卡片有開球時間就一律驗時間（±120 分內才算同一場），對不上寧可回 null 交人工，絕不錯配。
    var TOL = 120;
    var want = hhmmToMin(it.gameTime);
    if (want == null) return cands.length === 1 ? cands[0] : null;  // 卡片沒記時間：多場=模糊 → 交人工
    var best = null, bd = Infinity;
    for (var j = 0; j < cands.length; j++) {
      var t = hhmmToMin(gameHHMM(cands[j])); if (t == null) continue;
      var d = Math.abs(t - want); if (d < bd) { bd = d; best = cands[j]; }
    }
    return (best && bd <= TOL) ? best : null;
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
    var PS_DATA = [];                // 玩運彩 feed（ERA / 盤口 / 非MLB如NPB場）
    var MLB_DATA = [];              // MLB 官方 API（權威即時比分+終場狀態，CORS 可直抓）
    var DATA = [], loaded = false;  // 合併：MLB 分數/狀態 為準，玩運彩補 ERA/盤口，非MLB場留玩運彩
    // 設定
    var AUTO_SETTLE = true;          // 全自動結算；不想要就設 false
    var SWEEP_MS = 180000;           // 玩運彩 feed（ERA/盤口）3 分重抓即可
    var MLB_POLL_MS = 60000;         // ★MLB 比分每 60 秒抓一次 → 終場後 ~1-2 分內結算
    var psDismissed = {}, psExpanded = {}, psMin = false;   // (即時比分面板已停用，保留宣告供舊碼不報錯)
    // MLB teamId → 中文（與 mlb_fetch.js 同步）
    var TEAM_CN = {108:'天使',109:'響尾蛇',110:'金鶯',111:'紅襪',112:'小熊',113:'紅人',114:'守護者',115:'落磯',116:'老虎',117:'太空人',118:'皇家',119:'道奇',120:'國民',121:'大都會',133:'運動家',134:'海盜',135:'教士',136:'水手',137:'巨人',138:'紅雀',139:'光芒',140:'遊騎兵',141:'藍鳥',142:'雙城',143:'費城人',144:'勇士',145:'白襪',146:'馬林魚',147:'洋基',158:'釀酒人'};

    function fetchJson(url) {
      return fetch(url + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }
    function twShift(iso) { var d = new Date(iso); return new Date(d.getTime() + 8 * 3600000); }   // UTC→台灣(以 UTC 表示)
    function twDateOf(iso) { return twShift(iso).toISOString().slice(0, 10); }
    function twHHMMof(iso) { var t = twShift(iso); return String(t.getUTCHours()).padStart(2,'0') + ':' + String(t.getUTCMinutes()).padStart(2,'0'); }

    // ★ 從 MLB 官方 API 抓即時比分/狀態（多抓 3 天 UTC 日期，按各場台灣日期歸類，涵蓋跨日）
    function loadMLB() {
      var ds = []; var now = Date.now();
      for (var k = -1; k <= 1; k++) ds.push(new Date(now + k * 86400000).toISOString().slice(0, 10));
      Promise.all(ds.map(function (d) {
        return fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + d + '&t=' + Date.now(), { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      })).then(function (res) {
        var byPk = {};
        res.forEach(function (j) {
          if (!j || !j.dates) return;
          j.dates.forEach(function (dd) { (dd.games || []).forEach(function (g) {
            var a = g.teams && g.teams.away, h = g.teams && g.teams.home;
            if (!a || !h || !a.team || !h.team) return;
            var aCN = TEAM_CN[a.team.id], hCN = TEAM_CN[h.team.id]; if (!aCN || !hCN) return;
            var ab = (g.status && g.status.abstractGameState) || '';
            var det = (g.status && g.status.detailedState) || '';
            // 延賽/中止/取消優先於 abstract 判定（Postponed 場的 abstract 可能是 Final，會被誤標 finished）
            var st = /Postponed|Suspended|Cancelled/i.test(det) ? 'postponed'
                   : ab === 'Final' ? 'finished' : (ab === 'Live' ? 'inprogress' : 'scheduled');
            byPk[g.gamePk] = { officialId: 'mlb' + g.gamePk, _mlb: true,
              date: twDateOf(g.gameDate), gameTime: twHHMMof(g.gameDate), time: twHHMMof(g.gameDate),
              awayTeam: aCN, homeTeam: hCN,
              awayScore: (a.score != null ? a.score : null), homeScore: (h.score != null ? h.score : null),
              status: st };
          }); });
        });
        MLB_DATA = Object.keys(byPk).map(function (k) { return byPk[k]; });
        rebuildDATA();
        if (AUTO_SETTLE) setTimeout(autoSettleSweep, 300);   // MLB 一更新就立刻掃一次
      }).catch(function (e) { console.warn('[結算] MLB 比分抓取失敗（玩運彩照常）:', e && e.message); });
    }
    function findPS(m) {   // 在玩運彩 feed 找對應 MLB 場（補 ERA/盤口）；同日同對戰多場以開球時間就近配對（防跨場錯掛盤口）
      var cands = [];
      for (var i = 0; i < PS_DATA.length; i++) { var p = PS_DATA[i];
        if (dateEq(m.date, p.date) && teamMatch(m.awayTeam, p.awayTeam) && teamMatch(m.homeTeam, p.homeTeam)) cands.push(p); }
      if (cands.length <= 1) return cands[0] || null;
      var want = hhmmToMin(m.gameTime);
      if (want == null) return cands[0];
      var best = cands[0], bd = Infinity;
      for (var j = 0; j < cands.length; j++) { var t = hhmmToMin(gameHHMM(cands[j])); if (t == null) continue;
        var d = Math.abs(t - want); if (d < bd) { bd = d; best = cands[j]; } }
      return best;
    }
    function rebuildDATA() {
      var used = {};
      var merged = MLB_DATA.map(function (m) {              // MLB 場：分數/狀態用 MLB，ERA/盤口補玩運彩
        var ps = findPS(m);
        if (ps) { used[ps.officialId] = 1;
          var o = {}; for (var key in ps) o[key] = ps[key];
          o.awayScore = m.awayScore; o.homeScore = m.homeScore; o.status = m.status;
          o.officialId = m.officialId; o.date = m.date; o.gameTime = m.gameTime || ps.gameTime; o._mlb = true;
          return o;
        }
        return m;
      });
      var rest = PS_DATA.filter(function (p) {              // 非 MLB（NPB 等）只有玩運彩 → 保留原路徑
        if (used[p.officialId]) return false;
        return !MLB_DATA.some(function (m) { return dateEq(m.date, p.date) && teamMatch(m.awayTeam, p.awayTeam) && teamMatch(m.homeTeam, p.homeTeam); });
      });
      DATA = merged.concat(rest); loaded = true;
      // 即時資料每輪更新後通知板子重繪，讓卡片/標籤呈現最新比分（板子端自行節流＋避開互動中）
      if (typeof global.__onLiveData === 'function') { try { global.__onLiveData(); } catch (e) {} }
    }
    function load() {     // 玩運彩 feed（ERA/盤口/非MLB場）
      fetchJson(FEED_URL)
        .catch(function () { return fetchJson(FEED_FALLBACK); })
        .then(function (arr) { PS_DATA = Array.isArray(arr) ? arr : []; rebuildDATA();
          if (AUTO_SETTLE) setTimeout(autoSettleSweep, 1000); })
        .catch(function (e) { console.warn('[結算] 玩運彩載入失敗（MLB 照常結算）:', e.message); });
    }
    load();  loadMLB();
    setInterval(load, SWEEP_MS);
    setInterval(loadMLB, MLB_POLL_MS);                              // ★ MLB 比分快輪詢
    // 手機回前景立即補抓：背景分頁計時器被瀏覽器凍結，回來不補會停留在切出去前的資料
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { load(); loadMLB(); } });

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

      var statusTxt = isFinal ? '已結束' : (g.status === 'inprogress' ? '進行中' : g.status === 'postponed' ? '延賽' : '未開賽');
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
      var el = document.createElement('div');
      el.className = 'ps-banner';
      el.style.cssText = 'margin-bottom:12px;';

      // 疑顛倒 → 唯一需要「第一眼看到」的警示：紅色膠囊，其餘狀態不干擾版面
      var warnHtml = '';
      if (flip.state === 'flip') {
        warnHtml =
          '<div title="' + esc(flip.text) + '" style="display:flex;align-items:center;gap:8px;'
          + 'background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.55);border-radius:8px;'
          + 'padding:8px 11px;margin-bottom:10px;font-size:13px;font-weight:700;color:#ff8a8a;">'
          + '<span>⚠ 疑顛倒場</span>'
          + '<span style="font-weight:400;color:#d3a3a3;">運彩讓分方與你相反 · 勾選由你決定</span>'
          + '</div>';
      }

      // 自動帶入的明細＝確認性資訊，收進可摺疊 <details>，預設收合，不再霸佔版面頂端
      var flipDetail = (flip.state === 'flip')
        ? ''                                                          // 已在上方膠囊呈現
        : '<div>顛倒判定：' + esc(flip.text) + '</div>';
      var foldHtml =
        '<details class="ps-fold" style="font-size:12px;color:#8aa0b4;">'
        + '<summary style="cursor:pointer;color:#7c93a8;list-style:disclosure-closed;">'
        +   '玩運彩 ' + norm(g.date) + '（' + statusTxt + '）· 已自動帶入，點看說明'
        + '</summary>'
        + '<div style="margin-top:6px;line-height:1.75;padding-left:2px;">'
        +   '<div>藍框＝自動填入的值，可直接改</div>'
        +   '<div>' + scoreLine + '</div>'
        +   '<div>' + eraLine + '</div>'
        +   '<div>' + lineLine + '</div>'
        +   flipDetail
        + '</div>'
        + '</details>';

      el.innerHTML = warnHtml + foldHtml;
      body.insertBefore(el, body.firstChild);
    }

    // ===== 即時比分浮動面板（可拖曳 / 縮放 / 最小化收進快捷鍵；只顯示當天）=====
    var PS_UI_KEY = 'ps_live_ui';
    var psUI = { left: null, top: null, w: null, bodyH: null, min: false };
    try { var _sv = JSON.parse(localStorage.getItem(PS_UI_KEY) || '{}'); if (_sv && typeof _sv === 'object') { psUI = Object.assign(psUI, _sv); psMin = !!psUI.min; } } catch (e) {}
    function psSaveUI() { try { localStorage.setItem(PS_UI_KEY, JSON.stringify(psUI)); } catch (e) {} }
    function twToday() {                                            // 台灣當天日期（與 scraper 的 g.date 同口徑）
      var now = new Date();
      var tw = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
      return tw.getFullYear() + '-' + String(tw.getMonth() + 1).padStart(2, '0') + '-' + String(tw.getDate()).padStart(2, '0');
    }
    function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
    function num0(v) { return v == null ? '' : v; }
    // 只列「當天」的 進行中 + 已結束（未被你移除的）；進行中排前面，再依開賽時間
    function psScoreList() {
      var today = twToday();
      return (DATA || []).filter(function (g) {
        if (g.date !== today) return false;                        // 只顯示當天（昨天卡住的延期場/已結束場一律不顯示）
        if (psDismissed[g.officialId]) return false;               // 你已手動移除
        return g.status === 'inprogress' || g.status === 'finished';
      }).sort(function (a, b) {
        var ai = a.status === 'inprogress' ? 0 : 1, bi = b.status === 'inprogress' ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return String(a.time || '').localeCompare(String(b.time || ''));
      });
    }
    function psLineTable(g) {
      var ls = g.lineScore;
      if (!ls || !ls.away) return '<div class="empty">尚無逐局</div>';
      var n = Math.max(ls.away.length, ls.home.length);
      var th = function (t) { return '<td class="hd">' + t + '</td>'; };
      var cell = function (v) { return '<td>' + (v == null || v === '' ? '·' : esc(v)) + '</td>'; };
      var head = '<td></td>';
      for (var i = 1; i <= n; i++) head += th(i);
      head += '<td class="rhd">R</td>' + th('H') + th('E');
      var rowOf = function (name, arr, rhe) {
        var tds = '<td class="nm">' + esc(name) + '</td>';
        for (var i = 0; i < n; i++) tds += cell(arr[i]);
        var R = rhe ? num0(rhe.r) : '', H = rhe ? num0(rhe.h) : '', E = rhe ? num0(rhe.e) : '';
        tds += '<td class="rcol">' + R + '</td><td>' + H + '</td><td>' + E + '</td>';
        return '<tr>' + tds + '</tr>';
      };
      return '<table>'
        + '<tr>' + head + '</tr>' + rowOf(g.awayTeam, ls.away, ls.awayRHE) + rowOf(g.homeTeam, ls.home, ls.homeRHE) + '</table>';
    }
    function psRowHtml(g) {
      var fin = g.status === 'finished';
      var as = g.awayScore == null ? '–' : g.awayScore;
      var hs = g.homeScore == null ? '–' : g.homeScore;
      var chip = fin ? '結束' : (g.inning || '進行中');
      // ✕ 每一列都有（不只已結束）→ 卡住的延期場也能手動移除
      var x = '<span class="ps-x" data-oid="' + esc(g.officialId) + '" title="從面板移除">✕</span>';
      var head =
        '<div class="ps-row" data-oid="' + esc(g.officialId) + '">'
        +   '<span class="ps-teams">'
        +     esc(g.awayTeam) + ' <b>' + as + '</b> <span class="sep">:</span> <b>' + hs + '</b> ' + esc(g.homeTeam)
        +   '</span>'
        +   '<span class="ps-chip ' + (fin ? 'fin' : 'live') + '">' + esc(chip) + '</span>' + x
        + '</div>';
      var detail = psExpanded[g.officialId] ? '<div class="ps-line">' + psLineTable(g) + '</div>' : '';
      return head + detail;
    }
    // ---- 最小化：收進快捷鍵的「比分」鈕 ----
    function psEnsureLauncher() {
      var b = document.getElementById('ps-launcher');
      if (b) return b;
      b = document.createElement('button');
      b.id = 'ps-launcher'; b.type = 'button'; b.title = '展開即時比分'; b.innerHTML = '比分<span class="usc" style="display:none"></span>';
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); psMin = false; psUI.min = false; psSaveUI(); renderPanel(); });
      var bar = document.getElementById('zoomctlBtns');               // 真的收進快捷鍵那一排（沿用快捷鍵按鈕樣式）
      if (bar) { b.className = 'fit'; bar.insertBefore(b, bar.firstChild); }
      else {                                                          // 沒有快捷鍵列就浮一顆小鈕
        b.style.cssText = 'position:fixed;right:14px;bottom:60px;z-index:9998;background:#13202c;color:#7ec3ff;border:1px solid #2a4f6a;border-radius:8px;padding:5px 11px;font-size:12.5px;cursor:pointer;';
        document.body.appendChild(b);
      }
      return b;
    }
    function psShowLauncher(list) {
      var b = psEnsureLauncher();
      var liveN = list.filter(function (g) { return g.status === 'inprogress'; }).length;
      var bd = b.querySelector('.usc');
      if (bd) { if (liveN) { bd.textContent = liveN; bd.style.display = ''; } else bd.style.display = 'none'; }
      b.style.display = '';
    }
    function psHideLauncher() { var b = document.getElementById('ps-launcher'); if (b) b.style.display = 'none'; }

    function psEnsureStyle() {
      if (document.getElementById('ps-style')) return;
      var s = document.createElement('style');
      s.id = 'ps-style';
      s.textContent = [
        '#ps-live-panel{background:var(--panel,#151a22);border:1px solid var(--line,#2a3340);border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.5);color:var(--ink,#e9eef5);font-family:"Noto Sans TC",sans-serif;font-variant-numeric:tabular-nums;}',
        '#ps-live-panel .ps-head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;background:linear-gradient(180deg,rgba(255,255,255,.05),transparent);border-bottom:1px solid var(--line,#2a3340);user-select:none;touch-action:none;}',
        '#ps-live-panel .ps-title{display:flex;align-items:center;gap:7px;font-family:"Oswald",sans-serif;font-weight:600;letter-spacing:.06em;font-size:14px;text-transform:uppercase;color:var(--ink,#e9eef5);}',
        '#ps-live-panel .ps-title .dot{width:9px;height:9px;border-radius:50%;background:var(--mlb,#28c76f);box-shadow:0 0 8px rgba(40,199,111,.6);}',
        '#ps-live-panel .ps-count{margin-left:auto;color:var(--ink-dim,#8a96a6);font-size:12px;}',
        '#ps-live-panel .ps-min{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;cursor:pointer;color:var(--ink-dim,#8a96a6);font-size:18px;line-height:1;}',
        '#ps-live-panel .ps-min:hover{color:var(--ink,#e9eef5);background:rgba(255,255,255,.06);}',
        '#ps-live-panel .ps-body{overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}',
        '#ps-live-panel .ps-row{display:flex;align-items:center;gap:7px;padding:9px 11px;cursor:pointer;border-top:1px solid var(--line,#2a3340);}',
        '#ps-live-panel .ps-row:hover{background:rgba(255,255,255,.03);}',
        '#ps-live-panel .ps-teams{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px;color:var(--ink,#e9eef5);}',
        '#ps-live-panel .ps-teams b{font-weight:800;color:var(--ink,#e9eef5);}',
        '#ps-live-panel .ps-teams .sep{color:var(--ink-dim,#8a96a6);margin:0 2px;}',
        '#ps-live-panel .ps-chip{font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:9px;white-space:nowrap;}',
        '#ps-live-panel .ps-chip.live{background:rgba(40,199,111,.16);color:var(--mlb,#28c76f);}',
        '#ps-live-panel .ps-chip.fin{background:rgba(138,150,166,.16);color:var(--ink-dim,#8a96a6);}',
        '#ps-live-panel .ps-x{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;flex:0 0 auto;cursor:pointer;color:var(--ink-dim,#8a96a6);font-weight:700;font-size:14px;}',
        '#ps-live-panel .ps-x:hover{color:var(--danger,#ff5b6e);background:rgba(255,91,110,.12);}',
        '#ps-live-panel .ps-line{padding:0 11px 7px;overflow-x:auto;}',
        '#ps-live-panel .ps-line table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;margin:2px 0 3px;}',
        '#ps-live-panel .ps-line td{padding:2px 5px;text-align:center;color:var(--ink,#e9eef5);}',
        '#ps-live-panel .ps-line .nm{text-align:left;white-space:nowrap;color:var(--ink-dim,#8a96a6);}',
        '#ps-live-panel .ps-line .hd{color:var(--ink-dim,#8a96a6);}',
        '#ps-live-panel .ps-line .rcol{font-weight:700;border-left:1px solid var(--line,#2a3340);}',
        '#ps-live-panel .ps-line .rhd{color:var(--kbo,#3d8bfd);border-left:1px solid var(--line,#2a3340);}',
        '#ps-live-panel .ps-line .empty{color:var(--ink-dim,#8a96a6);padding:3px 2px;}',
        '#ps-live-panel .ps-resize{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;opacity:.5;touch-action:none;background:linear-gradient(135deg,transparent 50%,var(--ink-dim,#8a96a6) 50%);border-bottom-right-radius:12px;}',
        '@media (pointer:coarse){',
        '#ps-live-panel .ps-row{padding:12px 11px;}',
        '#ps-live-panel .ps-teams{font-size:15px;}',
        '#ps-live-panel .ps-x{width:36px;height:36px;font-size:16px;}',
        '#ps-live-panel .ps-min{width:36px;height:36px;font-size:20px;}',
        '#ps-live-panel .ps-resize{width:30px;height:30px;}',
        '#ps-live-panel .ps-line table{font-size:13px;}',
        '}'
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    }
    function psCreateShell() {
      psEnsureStyle();
      var p = document.createElement('div');
      p.id = 'ps-live-panel';
      p.style.cssText = 'position:fixed;width:236px;max-height:62vh;display:flex;flex-direction:column;z-index:9998;overflow:hidden;';
      var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
      p.style.top = Math.max(0, Math.min(vh - 60, psUI.top != null ? psUI.top : 66)) + 'px';
      if (psUI.left != null) { p.style.left = Math.max(0, Math.min(vw - 120, psUI.left)) + 'px'; p.style.right = 'auto'; }
      else { p.style.right = '14px'; }
      if (psUI.w) p.style.width = psUI.w + 'px';
      p.innerHTML =
        '<div class="ps-head">'
        +   '<span class="ps-title"><span class="dot"></span>即時比分</span>'
        +   '<span class="ps-count"></span>'
        +   '<span class="ps-min" title="最小化（收進快捷鍵）">▁</span>'
        + '</div>'
        + '<div class="ps-body"></div>'
        + '<div class="ps-resize" title="拖曳調整大小"></div>';
      document.body.appendChild(p);
      if (psUI.bodyH) p.querySelector('.ps-body').style.maxHeight = psUI.bodyH + 'px';
      p.querySelector('.ps-head').addEventListener('pointerdown', psStartDrag);
      var minBtn = p.querySelector('.ps-min');
      minBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      minBtn.addEventListener('click', function (e) { e.stopPropagation(); psMin = true; psUI.min = true; psSaveUI(); renderPanel(); });
      p.querySelector('.ps-resize').addEventListener('pointerdown', psStartResize);
      p.addEventListener('click', function (ev) {
        var t = ev.target;
        var x = t.closest ? t.closest('.ps-x') : null;
        if (x) { psDismissed[x.getAttribute('data-oid')] = true; renderPanel(); return; }
        if (t.closest && (t.closest('.ps-head') || t.closest('.ps-resize'))) return;
        var row = t.closest ? t.closest('.ps-row') : null;
        if (row && (!psDrag || !psDrag.moved)) { var oid = row.getAttribute('data-oid'); psExpanded[oid] = !psExpanded[oid]; renderPanel(); }
      });
      return p;
    }
    // 拖曳（標題列）
    var psDrag = null, psRz = null;
    function psStartDrag(e) {
      if (e.target.closest && e.target.closest('.ps-min')) return;
      var p = document.getElementById('ps-live-panel'); if (!p) return;
      var r = p.getBoundingClientRect();
      psDrag = { offX: e.clientX - r.left, offY: e.clientY - r.top, moved: false };
      p.style.right = 'auto';
      try { p.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    }
    function psMoveDrag(e) {
      if (!psDrag) return;
      var p = document.getElementById('ps-live-panel'); if (!p) return;
      var w = p.offsetWidth, h = p.offsetHeight;
      var x = Math.max(0, Math.min((window.innerWidth || 1024) - w, e.clientX - psDrag.offX));
      var y = Math.max(0, Math.min((window.innerHeight || 768) - h, e.clientY - psDrag.offY));
      p.style.left = x + 'px'; p.style.top = y + 'px';
      psDrag.moved = true; psDrag.x = x; psDrag.y = y;
    }
    function psEndDrag() { if (!psDrag) return; if (psDrag.moved) { psUI.left = psDrag.x; psUI.top = psDrag.y; psSaveUI(); } var d = psDrag; psDrag = null; setTimeout(function () {}, 0); return d; }
    // 縮放（右下角）
    function psStartResize(e) {
      e.preventDefault(); e.stopPropagation();
      var p = document.getElementById('ps-live-panel'); if (!p) return;
      var body = p.querySelector('.ps-body');
      psRz = { startX: e.clientX, startY: e.clientY, startW: p.offsetWidth, startBH: body.offsetHeight };
      try { p.setPointerCapture(e.pointerId); } catch (_) {}
    }
    function psMoveResize(e) {
      if (!psRz) return;
      var p = document.getElementById('ps-live-panel'); if (!p) return;
      var body = p.querySelector('.ps-body');
      var w = Math.max(190, Math.min(460, psRz.startW + (e.clientX - psRz.startX)));
      var bh = Math.max(80, Math.min((window.innerHeight || 768) * 0.8, psRz.startBH + (e.clientY - psRz.startY)));
      p.style.width = Math.round(w) + 'px'; body.style.maxHeight = Math.round(bh) + 'px';
      psRz.w = Math.round(w); psRz.bh = Math.round(bh);
    }
    function psEndResize() { if (!psRz) return; if (psRz.w) psUI.w = psRz.w; if (psRz.bh) psUI.bodyH = psRz.bh; psSaveUI(); psRz = null; }
    if (!global.__psPanelMoveBound) {
      global.__psPanelMoveBound = true;
      document.addEventListener('pointermove', function (e) { if (psDrag) psMoveDrag(e); else if (psRz) psMoveResize(e); });
      document.addEventListener('pointerup', function () { psEndDrag(); psEndResize(); });
      document.addEventListener('pointercancel', function () { psEndDrag(); psEndResize(); });
    }

    function renderPanel() {   // ★即時比分面板已移除（反應落後、無參考價值）；清掉任何殘留 DOM
      var p = document.getElementById('ps-live-panel'); if (p) p.remove();
      var b = document.getElementById('ps-launcher'); if (b) b.remove();
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
    // 給板子取「即時比分」：對到當天該場，回進行中/已結束(未結算)比分；未開賽/無比分回 null
    function liveScoreFor(it, activeDate) {
      try {
        var g = findGame(DATA, it, activeDate);
        if (!g) return null;
        if (g.status !== 'inprogress' && g.status !== 'finished') return null;   // upcoming 場比分為 0，不能顯示
        if (g.awayScore == null || g.homeScore == null) return null;
        return { away: g.awayScore, home: g.homeScore, status: g.status, inning: g.inning || null, final: g.status === 'finished' };
      } catch (e) { return null; }
    }
    global.__psFusion = { inject: inject, _setData: function (d) { DATA = d || []; loaded = true; }, _setMLB: function (d) { MLB_DATA = d || []; rebuildDATA(); }, _setPS: function (d) { PS_DATA = d || []; rebuildDATA(); }, getData: function () { return DATA; }, getMLB: function () { return MLB_DATA; }, loadMLB: loadMLB, rebuildDATA: rebuildDATA, findGame: findGame, liveScoreFor: liveScoreFor, buildFlipHint: buildFlipHint, autoSettleSweep: autoSettleSweep, autoSettleOne: autoSettleOne, renderPanel: renderPanel };
  }

  // ---- 測試匯出 ----
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { teamMatch, dateEq, findGame, buildFlipHint, alias, gameHHMM, hhmmToMin };
  }
})(typeof window !== 'undefined' ? window : globalThis);
