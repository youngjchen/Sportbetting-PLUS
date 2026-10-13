'use strict';
// ============================================================
// failover-alert.js — 本機備援停擺警示（2026-10-14 使用者規格）
// 背景：本機備援（使用者電腦的排程 BB-ScrapeFailover，每 5 分）兩度無聲停擺——
//   8/7–8/9 約 33h、10/12 10:21–10/13 23:05 約 37h（git rebase 衝突卡死）。
//   期間 BET365 美職官網失效也沒有備援可用，使用者事後才發現資料缺。
// 判定（三種通知共用這一套，改規格只改這裡）：
//   · 心跳＝棒球 BET365 兩道備援檔 updatedAt 取「較新」那個：
//       data/oddsportal_summary.json（BetExplorer，第一道）
//       data/oddsportal_bet365.json（OddsPortal，第二道）
//     兩檔都只有本機備援在寫（雲端被 WAF 擋）、各每 30 分一輪；只停一道＝那道爬蟲壞、另一道仍在備援，
//     不算整條停擺。日後若雲端 oddsportal-scrape 又能寫摘要，這個心跳要改成只看 oddsportal_bet365。
//   · 超過 90 分（＝連漏 3 輪）沒更新，而且 36 小時內還有未開賽棒球（玩運彩 pregame_data）才算停擺。
//     36h＝OddsPortal BET365 備援本身往前追蹤的範圍；更遠的場次備援本來也還不會抓，停了不缺資料。
//   · 檔案讀不到（斷網等）＝不知道，一律不警示，避免假警報。
// 三種通知：排盤板頂部紅條（本檔 install）、GitHub issue（failover-watchdog.yml）、
//   Windows 桌面通知（failover_task.cmd → failover_watch.js --desktop）。
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  const STALL_MIN = 90;
  const HORIZON_HOURS = 36;
  const BASEBALL = ['MLB', 'NPB', 'KBO', 'CPBL'];
  const RAW_DIR = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/';
  const REFRESH_MS = 5 * 60 * 1000;
  const TICK_MS = 60 * 1000;
  const LOG_HINT = '到電腦上看 D:\\Sportbetting-PLUS\\.runtime\\bb_failover.log，或工作排程器的 BB-ScrapeFailover';

  function parseTime(value) {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  // 玩運彩的 date／time 是台灣時間
  function gameStartMs(game) {
    const date = String((game && game.date) || '').slice(0, 10);
    const hm = String((game && (game.time || game.gameTime)) || '').match(/^(\d{1,2}):(\d{2})/);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !hm) return null;
    return parseTime(date + 'T' + hm[1].padStart(2, '0') + ':' + hm[2] + ':00+08:00');
  }

  function pregameList(pregame) {
    if (Array.isArray(pregame)) return pregame;
    if (pregame && Array.isArray(pregame.games)) return pregame.games;
    return null;
  }

  // 36h 內的未開賽棒球（延賽／取消／進行中／已完賽都不算），依開賽時間排序
  function upcomingBaseball(pregame, now, horizonHours) {
    const until = now + (horizonHours == null ? HORIZON_HOURS : horizonHours) * 3600e3;
    return (pregameList(pregame) || [])
      .filter(function (g) {
        return g && BASEBALL.includes(String(g.league || '').toUpperCase()) && (!g.status || g.status === 'upcoming');
      })
      .map(function (g) {
        return { league: String(g.league).toUpperCase(), away: g.awayTeam || g.away || '', home: g.homeTeam || g.home || '', at: gameStartMs(g) };
      })
      .filter(function (g) { return g.at != null && g.at > now && g.at <= until; })
      .sort(function (a, b) { return a.at - b.at; });
  }

  // state：ok＝備援有在更新／stalled＝停擺，要警示／idle＝沒更新但 36h 內沒有未開賽棒球（不警示）
  //        unknown＝備援檔或賽程讀不到，無從判斷（不警示）
  function failoverStatus(input) {
    const opts = input || {};
    const now = opts.now == null ? Date.now() : opts.now;
    const stallMin = opts.stallMin == null ? STALL_MIN : opts.stallMin;
    const betExplorerAt = parseTime(opts.summary && opts.summary.updatedAt);
    const oddsPortalAt = parseTime(opts.opBet365 && opts.opBet365.updatedAt);
    const stamps = [betExplorerAt, oddsPortalAt].filter(function (v) { return v != null; });
    const lastAt = stamps.length ? Math.max.apply(null, stamps) : null;
    const status = {
      state: 'unknown', stalled: false, now: now, lastAt: lastAt, betExplorerAt: betExplorerAt, oddsPortalAt: oddsPortalAt,
      ageMin: lastAt == null ? null : Math.max(0, Math.floor((now - lastAt) / 60000)),
      upcomingCount: 0, nextGame: null,
    };
    if (lastAt == null) return status;
    if (now - lastAt <= stallMin * 60000) { status.state = 'ok'; return status; }
    if (!pregameList(opts.pregame)) return status;
    const upcoming = upcomingBaseball(opts.pregame, now, opts.horizonHours);
    status.upcomingCount = upcoming.length;
    status.nextGame = upcoming[0] || null;
    status.state = upcoming.length ? 'stalled' : 'idle';
    status.stalled = upcoming.length > 0;
    return status;
  }

  function formatAge(min) {
    if (min == null) return '';
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return m + ' 分';
    return m ? h + ' 小時 ' + m + ' 分' : h + ' 小時';
  }

  // 一律顯示台灣時間（手機時區設錯也不受影響）
  function formatTw(ms) {
    if (ms == null) return '—';
    const d = new Date(ms + 8 * 3600e3);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  // 三種通知共用的文字：title＝一句話結論；short＝紅條／桌面第二行；lines＝細節
  function describe(status) {
    const s = status || {};
    const g = s.nextGame;
    return {
      title: '本機備援已停 ' + formatAge(s.ageMin),
      short: '最後更新 ' + formatTw(s.lastAt) + '・36h 內 ' + s.upcomingCount + ' 場棒球未開賽',
      lines: [
        'BET365 備援最後更新 ' + formatTw(s.lastAt) + '（BetExplorer ' + formatTw(s.betExplorerAt) + '／OddsPortal ' + formatTw(s.oddsPortalAt) + '）',
        '36 小時內還有 ' + s.upcomingCount + ' 場棒球未開賽' + (g ? '，最近一場 ' + g.league + ' ' + g.away + '@' + g.home + ' ' + formatTw(g.at) : ''),
      ],
    };
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 排盤板頂部紅條：停擺才出現、恢復自動消失。BetExplorer 摘要（4.8MB）直接借 oddsportal-integration
  // 已每 5 分抓好的那份，不重抓；這裡只抓小檔 oddsportal_bet365.json（6KB）與 pregame_data.json（50KB）。
  function install(global) {
    if (global.__failoverAlert) return global.__failoverAlert;
    let opBet365 = null;
    let pregame = null;
    let clock = function () { return Date.now(); };

    async function fetchJson(name) {
      const response = await global.fetch(RAW_DIR + name + '?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    function render(status) {
      const doc = global.document;
      let bar = doc.getElementById('failoverAlert');
      if (!status.stalled) {
        if (bar) bar.remove();
        return;
      }
      if (!bar) {
        bar = doc.createElement('div');
        bar.id = 'failoverAlert';
        bar.setAttribute('role', 'alert');
        bar.style.cssText = 'display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;padding:6px 18px;' +
          'padding-left:calc(18px + env(safe-area-inset-left, 0px));padding-right:calc(18px + env(safe-area-inset-right, 0px));' +
          'background:#3a0e16;border-bottom:1px solid var(--danger, #ff5b6e);color:#ffd5db;font-size:13px;line-height:1.4;';
        const header = doc.querySelector('header');
        if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
        else doc.body.insertBefore(bar, doc.body.firstChild);
      }
      const text = describe(status);
      const html = '<b>🛑 ' + escapeHtml(text.title) + '</b><span style="opacity:.8">' + escapeHtml(text.short) + '</span>';
      if (bar.innerHTML !== html) bar.innerHTML = html;
      bar.title = text.lines.concat(LOG_HINT).join('\n');
    }

    function evaluate() {
      const integration = global.__oddsPortalIntegration;
      const summary = integration && typeof integration._getFeed === 'function' ? integration._getFeed() : null;
      const status = failoverStatus({ summary: summary, opBet365: opBet365, pregame: pregame, now: clock() });
      try { render(status); } catch (error) { console.warn('[備援警示] 顯示失敗:', error); }
      return status;
    }

    // 抓失敗就清空（→ unknown 不警示），不拿舊資料硬判，避免手機斷網一陣子回來誤報停擺
    async function refresh() {
      const results = await Promise.allSettled([fetchJson('oddsportal_bet365.json'), fetchJson('pregame_data.json')]);
      opBet365 = results[0].status === 'fulfilled' ? results[0].value : null;
      pregame = results[1].status === 'fulfilled' ? results[1].value : null;
      return evaluate();
    }

    const api = {
      refresh: refresh,
      evaluate: evaluate,
      // 測試用：把時鐘撥快／撥回（null＝恢復真實時間），立刻重算
      _setClock: function (fn) { clock = typeof fn === 'function' ? fn : function () { return Date.now(); }; return evaluate(); },
    };
    global.__failoverAlert = api;
    const start = function () {
      refresh().catch(function (error) { console.warn('[備援警示] 載入失敗:', error); });
      global.setInterval(function () { refresh().catch(function () {}); }, REFRESH_MS);
      global.setInterval(evaluate, TICK_MS);
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible') refresh().catch(function () {});
      });
    };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start);
    else start();
    return api;
  }

  return {
    STALL_MIN: STALL_MIN,
    HORIZON_HOURS: HORIZON_HOURS,
    LOG_HINT: LOG_HINT,
    failoverStatus: failoverStatus,
    upcomingBaseball: upcomingBaseball,
    gameStartMs: gameStartMs,
    describe: describe,
    formatAge: formatAge,
    formatTw: formatTw,
    install: install,
  };
});
