'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  const RAW_URL = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/oddsportal_summary.json';
  const FALLBACK_URL = './data/oddsportal_summary.json';
  // 歷史月檔（oddsportal_harvest.py 收割 4/1 至今）：結算畫面看舊日期時按月懶載入
  const ARCHIVE_RAW_DIR = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/oddsportal_archive/';
  const ARCHIVE_LOCAL_DIR = './data/oddsportal_archive/';
  const REFRESH_MS = 5 * 60 * 1000;
  const TIME_TOLERANCE_MIN = 120;

  function hhmmToMin(value) {
    const match = String(value == null ? '' : value).match(/(\d{1,2}):(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function normalizeLeague(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('mlb') || text === '1') return 'mlb';
    if (text.includes('npb') || text.includes('日職') || text === '2') return 'npb';
    if (text.includes('kbo') || text.includes('韓職') || text === '9') return 'kbo';
    if (text.includes('cpbl') || text.includes('中職') || text === '6') return 'cpbl';
    if (text.includes('wnba') || text.includes('女籃')) return 'wnba';
    // 'zz'＝板子 leagueOf 找不到聯盟時的兜底值（WNBA 隊名不在 LEAGUES 表裡就會落到這）。
    // 當成「未知」而非一個真聯盟，否則永遠配不到 wnba 場次。
    if (text === 'zz') return '';
    return text;
  }

  function cardLeague(card) {
    if (card && card.league) return normalizeLeague(card.league);
    try {
      if (typeof leagueOf === 'function') return normalizeLeague(leagueOf(card));
    } catch (_) {}
    return '';
  }

  // 2026-08-05 阪神虎@橫濱DeNA 案：板卡用全名、OddsPortal 摘要用短名 → 嚴格相等
  // 讓亞洲場全部配不上（美職兩邊同名倖免）。改「相等或互為包含」（聯盟已先過濾，
  // 樂天金鷲/樂天桃猿等歧義由 league 隔開）。
  // 同隊異名橋（2026-08-13 斗山熊@韓華鷹案）：板上「韓華鷹」、feed「華老鷹」
  // 互不為子字串 → 包含式比對斷裂 → 該卡永遠配不到、初收盤都要手動填。
  // 這裡只放「確定同隊」的異名，寧缺勿濫（樂天/巨人歧義靠 league 隔離，不進表）。
  const TEAM_SYNONYM = { '韓華鷹': '華老鷹', '華老鷹': '韓華鷹', '韓華': '華老鷹' };
  function teamMatch(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (!x || !y) return false;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    const xs = TEAM_SYNONYM[x], ys = TEAM_SYNONYM[y];
    return !!((xs && (xs === y || y.includes(xs) || xs.includes(y))) ||
              (ys && (ys === x || x.includes(ys) || ys.includes(x))));
  }

  function findOddsPortalGame(feed, card, activeDate) {
    if (!feed || !feed.games || !card) return null;
    const league = cardLeague(card);
    const candidates = Object.values(feed.games).filter(function (game) {
      return game && String(game.date || '').slice(0, 10) === String(activeDate || '').slice(0, 10) &&
        teamMatch(game.awayTeam, card.away) && teamMatch(game.homeTeam, card.home) &&
        (!league || normalizeLeague(game.league) === league);
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const wanted = hhmmToMin(card.gameTime || card.time);   // 籃球板的賽程欄位叫 time
    if (wanted == null) return null;
    let best = null;
    let bestDiff = Infinity;
    candidates.forEach(function (game) {
      const minute = hhmmToMin(game.startTime);
      if (minute == null) return;
      const diff = Math.abs(minute - wanted);
      const seen = Date.parse((game.bet365 && game.bet365.observedAt) || game.observedAt || '');
      const bestSeen = best ? Date.parse((best.bet365 && best.bet365.observedAt) || best.observedAt || '') : NaN;
      // 同隊、同日、同開球時間可能殘留兩個 BetExplorer eventId；時間打平時必取最新觀測，
      // 否則會固定吃到前一天的舊列，讓今天已發生的 Bet365 對調在警示與結算快照中消失。
      if (diff < bestDiff || (diff === bestDiff && Number.isFinite(seen) && (!Number.isFinite(bestSeen) || seen > bestSeen))) {
        best = game; bestDiff = diff;
      }
    });
    return best && bestDiff <= TIME_TOLERANCE_MIN ? best : null;
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function applySettlementDefaults(card, game) {
    if (!card || !game) return card;
    // 2026-08-05 拆除：不准寫 card.preGameSwap（對調=台彩軸；此行曾汙染 12 場結算紀錄）
    card.oddsPortal = {
      eventId: game.eventId,
      handicapSwitch: clone(game.handicapSwitch || null),
      markets: clone(game.markets || {}),
    };
    return card;
  }

  function install(global) {
    if (global.__oddsPortalIntegration) return global.__oddsPortalIntegration;
    let feed = { games: {}, updatedAt: null };

    function validFeed(value) {
      return value && typeof value === 'object' && value.source === 'OddsPortal' &&
        value.bookmaker === 'Stake.com' && value.games && typeof value.games === 'object';
    }

    async function fetchFeed(url) {
      const response = await global.fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), {
        cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const value = await response.json();
      if (!validFeed(value)) throw new Error('OddsPortal 摘要格式不合法');
      return value;
    }

    async function refresh() {
      let value;
      try { value = await fetchFeed(RAW_URL); }
      catch (_) { value = await fetchFeed(FALLBACK_URL); }
      feed = value;
      try { autoApplyOdds(); } catch (_) {}
      try { if (typeof global.__backfillBet365TaiwanSnapshots === 'function') global.__backfillBet365TaiwanSnapshots(); } catch (_) {}
      try { if (typeof global.render === 'function') global.render(); } catch (_) {}
      return feed;
    }

    // 2026-08-05 使用者拍板：初盤/定案收盤自動寫進卡片欄位（openOdds/closeOdds），
    // 標籤列表照舊規則隨填寫變黃（navMatchState 數的就是這些欄位）。
    // 鐵則：只填空白、絕不覆蓋手填值；下注賠率(flipOdds)＝使用者自己的注，永不代填。
    // 板子的 doc 是 `let doc` 宣告的全域語彙變數——不掛在 window 上（global.doc 永遠 undefined）。
    // 2026-08-05 事故：autoApplyOdds 讀 global.doc 直接 return 0，賠率一格都沒寫進卡片，
    // 標籤自然不會變黃。必須先讀裸 doc（跟 pregame-integration 同一個坑）。
    function boardDoc() {
      try { if (typeof doc !== 'undefined' && doc && doc.boards) return doc; } catch (_) {}
      if (global.doc && global.doc.boards) return global.doc;
      return null;
    }

    function autoApplyOdds() {
      const doc = boardDoc();
      if (!doc || !doc.boards) return 0;
      let changed = 0;
      function fill(target, card, date) {
        const game = gameFor(card, date, null);
        if (!game) return;
        const ml = (game.markets || {}).ml || {};
        if (target.openOddsAway == null && target.openOddsHome == null &&
            ml.open && ml.open.away != null && ml.open.home != null) {
          target.openOddsAway = ml.open.away;
          target.openOddsHome = ml.open.home;
          changed++;
        }
        const close = (ml.close && ml.close.final) ? ml.close : null;
        if (close && target.closeOddsAway == null && target.closeOddsHome == null &&
            close.away != null && close.home != null) {
          target.closeOddsAway = close.away;
          target.closeOddsHome = close.home;
          changed++;
        }
      }
      for (const dk of Object.keys(doc.boards)) {
        const board = doc.boards[dk];
        for (const it of (board && board.items) || []) {
          if (!it || it.type !== 'match') continue;
          fill(it, it, dk);
        }
      }
      // 已結算的卡片已從 board.items 移到 doc.games；收盤晚到時也必須回填歷史紀錄，
      // 否則燈號回顧仍會永久缺賠率。只補空白，手填值一樣不覆蓋。
      for (const settled of doc.games || []) {
        if (!settled || !settled.date) continue;
        fill(settled, {
          league: settled.league,
          away: settled.awayTeam || settled.away,
          home: settled.homeTeam || settled.home,
          gameTime: settled.gameTime || settled.time,
        }, settled.date);
      }
      if (changed) {
        try { if (typeof global.save === 'function') global.save(); } catch (_) {}
      }
      return changed;
    }

    // 歷史月檔快取：month → feed 物件｜'loading'｜'missing'
    const archives = {};

    function archiveFeedFor(month, onReady) {
      const cached = archives[month];
      if (cached && cached !== 'loading' && cached !== 'missing') return cached;
      if (cached === 'loading' || cached === 'missing') return null;
      archives[month] = 'loading';
      (async function () {
        let value = null;
        try { value = await fetchFeed(ARCHIVE_RAW_DIR + month + '.json'); }
        catch (_) { try { value = await fetchFeed(ARCHIVE_LOCAL_DIR + month + '.json'); } catch (_) {} }
        archives[month] = value || 'missing';
        if (value) {
          try { autoApplyOdds(); } catch (_) {}
          if (typeof onReady === 'function') { try { onReady(); } catch (_) {} }
        }
      })();
      return null;
    }

    function gameFor(card, activeDate, onReady) {
      let date = activeDate;
      try { if (!date && global.doc) date = global.doc.activeDate; } catch (_) {}
      try { if (!date && typeof doc !== 'undefined') date = doc.activeDate; } catch (_) {}
      const live = findOddsPortalGame(feed, card, date);
      if (live) return live;
      // 近況檔沒有 → 按月讀歷史檔（4/1 起的收割資料）；首次載入完成後回呼重填
      const month = String(date || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return null;
      const arch = archiveFeedFor(month, onReady);
      return arch ? findOddsPortalGame(arch, card, date) : null;
    }

    function snapshotFor(card, activeDate) {
      const game = gameFor(card, activeDate);
      if (!game) return null;
      return {
        eventId: game.eventId,
        handicapSwitch: clone(game.handicapSwitch || null),
        markets: clone(game.markets || {}),
      };
    }

    function emit(element, type) {
      const view = element && element.ownerDocument && element.ownerDocument.defaultView;
      if (view && typeof view.Event === 'function') {
        element.dispatchEvent(new view.Event(type, { bubbles: true }));
      }
    }

    function setIfBlank(id, value) {
      const input = global.document.getElementById(id);
      if (input && (input.value == null || input.value === '') && value != null) {
        input.value = String(value);
        emit(input, 'input');
      }
    }

    function marketText(label, market) {
      if (!market) return label + '：無資料';
      const opening = market.open || {};
      // 2026-08-05 使用者糾正：沒開打就沒有收盤——收盤只認定案（final），
      // 絕不拿當前盤（active）冒充；未定案一律顯示 —。
      const closing = (market.close && market.close.final) ? market.close : {};
      if (label === '獨贏') {
        return label + '：' + (opening.away ?? '—') + ' / ' + (opening.home ?? '—') +
          ' → ' + (closing.away ?? '—') + ' / ' + (closing.home ?? '—');
      }
      if (label === '讓分') {
        return label + '：' + (opening.line ?? '—') + '（' + (opening.away ?? '—') + ' / ' + (opening.home ?? '—') +
          '）→ ' + (closing.line ?? '—') + '（' + (closing.away ?? '—') + ' / ' + (closing.home ?? '—') + '）';
      }
      return label + '：' + (opening.line ?? '—') + '（' + (opening.over ?? '—') + ' / ' + (opening.under ?? '—') +
        '）→ ' + (closing.line ?? '—') + '（' + (closing.over ?? '—') + ' / ' + (closing.under ?? '—') + '）';
    }

    function renderEvidence(game) {
      const old = global.document.getElementById('oddsPortalEvidence');
      if (old) old.remove();
      const body = global.document.getElementById('settleBody');
      if (!body || !game) return;
      const box = global.document.createElement('section');
      box.id = 'oddsPortalEvidence';
      box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid rgba(79,193,255,.35);border-radius:8px;background:rgba(79,193,255,.05);font-size:12px;line-height:1.7;color:var(--ink-dim);';
      const title = global.document.createElement('div');
      title.style.cssText = 'color:#7fc9ff;font-weight:700;margin-bottom:4px;';
      title.textContent = 'OddsPortal · Stake 初盤／收盤';
      box.appendChild(title);
      const markets = game.markets || {};
      [['獨贏', markets.ml], ['讓分', markets.hd], ['大小', markets.ou]].forEach(function (entry) {
        const line = global.document.createElement('div');
        line.textContent = marketText(entry[0], entry[1]);
        box.appendChild(line);
      });
      // 2026-08-05 使用者核准 SOP：對調只「列出警示」（stakeSwap 證據），永不勾選任何狀態
      const swap = game.stakeSwap || null;
      if (swap && swap.ever && Array.isArray(swap.transitions) && swap.transitions.length) {
        const line = global.document.createElement('div');
        line.style.cssText = 'color:#e0a020;font-weight:700;margin-top:4px;';
        const seg = swap.transitions.map(function (t) {
          return (t.at || '').replace('T', ' ').slice(5, 16) + ' ' +
            (t.from === 'home' ? '主讓' : '客讓') + '→' + (t.to === 'home' ? '主讓' : '客讓');
        }).join('；');
        line.textContent = '⚠ Stake 曾換讓分方：' + seg +
          (swap.scanFavorite ? '（掃描時 ' + (swap.scanFavorite === 'home' ? '主讓' : '客讓') + '）' : '');
        box.appendChild(line);
      }
      const anchor = global.document.getElementById('settleOddsCalc');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
      else body.appendChild(box);
    }

    function injectSettlement(card) {
      // 歷史月檔首次載入完成後自動重填一次（結算視窗還開著時舊日期也吃得到資料）
      const game = gameFor(card, null, function () { injectSettlement(card); });
      if (!game) return;
      // 2026-08-05 使用者拍板拆除：「賽前讓分方曾對調」是台彩軸的勾，OddsPortal/Stake
      // 軌無權碰它（替代盤口曾偽造換邊、8/1 三場被亂勾）。證據卡照常顯示，勾由人手。
      const ml = (game.markets || {}).ml || {};
      const mlClose = (ml.close && ml.close.final) ? ml.close : null;   // 未定案不准填收盤欄
      setIfBlank('openOddsAway', ml.open && ml.open.away);
      setIfBlank('openOddsHome', ml.open && ml.open.home);
      setIfBlank('closeOddsAway', mlClose && mlClose.away);
      setIfBlank('closeOddsHome', mlClose && mlClose.home);
      renderEvidence(game);
    }

    function hookSettlement() {
      if (typeof global.openSettleModal !== 'function') return false;
      if (global.openSettleModal.__oddsPortalHooked) return true;
      const original = global.openSettleModal;
      const wrapped = function (card) {
        const result = original.apply(this, arguments);
        try { injectSettlement(card); }
        catch (error) { console.warn('[OddsPortal] 結算帶入失敗:', error); }
        return result;
      };
      wrapped.__oddsPortalHooked = true;
      global.openSettleModal = wrapped;
      return true;
    }

    const api = {
      refresh, gameFor, snapshotFor, injectSettlement, autoApplyOdds,
      _setFeed: function (value) { if (validFeed(value)) feed = value; },
      _getFeed: function () { return feed; },
    };
    global.__oddsPortalIntegration = api;
    const start = function () {
      hookSettlement();
      refresh().catch(function (error) { console.warn('[OddsPortal] 摘要載入失敗:', error); });
      global.setInterval(function () {
        hookSettlement();
        refresh().catch(function (error) { console.warn('[OddsPortal] 更新失敗:', error); });
      }, REFRESH_MS);
    };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start);
    else start();
    return api;
  }

  return {
    install,
    findOddsPortalGame,
    applySettlementDefaults,
    hhmmToMin,
    normalizeLeague,
    TIME_TOLERANCE_MIN,
  };
});
