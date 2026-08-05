'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  const RAW_URL = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/oddsportal_summary.json';
  const FALLBACK_URL = './data/oddsportal_summary.json';
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
    return text;
  }

  function cardLeague(card) {
    if (card && card.league) return normalizeLeague(card.league);
    try {
      if (typeof leagueOf === 'function') return normalizeLeague(leagueOf(card));
    } catch (_) {}
    return '';
  }

  function findOddsPortalGame(feed, card, activeDate) {
    if (!feed || !feed.games || !card) return null;
    const league = cardLeague(card);
    const candidates = Object.values(feed.games).filter(function (game) {
      return game && String(game.date || '').slice(0, 10) === String(activeDate || '').slice(0, 10) &&
        game.awayTeam === card.away && game.homeTeam === card.home &&
        (!league || normalizeLeague(game.league) === league);
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const wanted = hhmmToMin(card.gameTime);
    if (wanted == null) return null;
    let best = null;
    let bestDiff = Infinity;
    candidates.forEach(function (game) {
      const minute = hhmmToMin(game.startTime);
      if (minute == null) return;
      const diff = Math.abs(minute - wanted);
      if (diff < bestDiff) { best = game; bestDiff = diff; }
    });
    return best && bestDiff <= TIME_TOLERANCE_MIN ? best : null;
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function applySettlementDefaults(card, game) {
    if (!card || !game) return card;
    if (game.handicapSwitch && game.handicapSwitch.ever) card.preGameSwap = true;
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
      try { if (typeof global.render === 'function') global.render(); } catch (_) {}
      return feed;
    }

    function gameFor(card, activeDate) {
      let date = activeDate;
      try { if (!date && global.doc) date = global.doc.activeDate; } catch (_) {}
      try { if (!date && typeof doc !== 'undefined') date = doc.activeDate; } catch (_) {}
      return findOddsPortalGame(feed, card, date);
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
      const state = game.handicapSwitch || {};
      const swap = global.document.createElement('div');
      swap.style.cssText = state.ever ? 'color:#40d9b1;font-weight:700;margin-top:4px;' : 'margin-top:4px;';
      if (state.ever) {
        const first = state.first && (state.first.detectedAt || state.first.estimatedAt);
        const last = state.last && (state.last.detectedAt || state.last.estimatedAt);
        swap.textContent = '⇆ 曾換邊 ' + (state.count || 1) + ' 次' +
          (first ? '；首次 ' + first.replace('T', ' ').slice(0, 16) : '') +
          (last && last !== first ? '；最後 ' + last.replace('T', ' ').slice(0, 16) : '');
      } else {
        swap.textContent = '本紀錄未偵測到讓分方換邊';
      }
      box.appendChild(swap);
      const anchor = global.document.getElementById('settleOddsCalc');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
      else body.appendChild(box);
    }

    function injectSettlement(card) {
      const game = gameFor(card);
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
      refresh, gameFor, snapshotFor, injectSettlement,
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
