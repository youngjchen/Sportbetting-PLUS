'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  const RAW_URL = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/baseball_bet365_odds.json';
  const LOCAL_URL = './data/baseball_bet365_odds.json';
  const REFRESH_MS = 5 * 60 * 1000;

  const TEAM_SYNONYM = Object.freeze({
    '韓華鷹': '華老鷹', '韓華': '華老鷹',
    '讀賣巨人': '巨人', '阪神虎': '阪神', '橫濱DeNA': '橫濱',
    '廣島鯉魚': '廣島', '養樂多燕子': '養樂多', '中日龍': '中日',
    '軟銀鷹': '軟銀', '日本火腿': '火腿', '樂天金鷲': '樂天', '西武獅': '西武',
    'LG雙子': '雙子', 'KT巫師': '巫師', 'SSG登陸者': '登陸者', 'NC恐龍': '恐龍',
    '樂天巨人': '樂天', '培證英雄': '培證',
    '中信兄弟': '兄弟', '統一獅': '統一', '樂天桃猿': '樂天',
    '富邦悍將': '富邦', '味全龍': '味全', '台鋼雄鷹': '台鋼',
  });

  function normalizeLeague(value) {
    const text = String(value || '').toUpperCase();
    return ['MLB', 'NPB', 'KBO', 'CPBL'].includes(text) ? text : '';
  }

  function normalizeTeam(value) {
    const text = String(value || '').trim();
    return TEAM_SYNONYM[text] || text;
  }

  function cardLeague(card) {
    if (card && card.league) return normalizeLeague(card.league);
    try { if (typeof leagueOf === 'function') return normalizeLeague(leagueOf(card)); } catch (_) {}
    return '';
  }

  function hhmm(value) {
    const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function taiwanDateTime(game) {
    const stamp = Date.parse(game && game.scheduledStart || '');
    if (!Number.isFinite(stamp)) return { date: '', minute: null };
    const text = new Date(stamp + 8 * 3600000).toISOString();
    return {
      date: text.slice(0, 10),
      minute: Number(text.slice(11, 13)) * 60 + Number(text.slice(14, 16)),
    };
  }

  function findGame(feed, card, activeDate) {
    if (!feed || !feed.matches || !card) return null;
    if (card.officialId && feed.matches[card.officialId]) return feed.matches[card.officialId];
    const wantedLeague = cardLeague(card);
    const wantedDate = String(activeDate || '').slice(0, 10);
    const wantedMinute = hhmm(card.gameTime || card.time);
    let best = null;
    let bestDiff = Infinity;
    for (const game of Object.values(feed.matches)) {
      if (!game || (wantedLeague && normalizeLeague(game.league) !== wantedLeague)) continue;
      if (normalizeTeam(game.away) !== normalizeTeam(card.away) || normalizeTeam(game.home) !== normalizeTeam(card.home)) continue;
      const when = taiwanDateTime(game);
      if (wantedDate && when.date !== wantedDate) continue;
      const diff = wantedMinute == null || when.minute == null ? 0 : Math.abs(wantedMinute - when.minute);
      if (diff <= 120 && diff < bestDiff) { best = game; bestDiff = diff; }
    }
    return best;
  }

  function sourceLabel(provider) {
    if (provider === 'bet365-official') return 'BET365 官網';
    if (provider === 'betexplorer') return 'BetExplorer 備援';
    return provider ? String(provider) : '來源不明';
  }

  function verdictFor(game) {
    if (!game || !game.markets || !game.markets.hd) return null;
    const handicap = game.markets.hd;
    if (handicap.favorite !== 'away' && handicap.favorite !== 'home') return null;
    const provider = handicap.provider || game.provider || '';
    const flips = (Array.isArray(game.events) ? game.events : []).filter(function (event) {
      return event && event.type === 'favorite-flip';
    });
    return {
      side: handicap.favorite,
      line: handicap.line == null ? null : Number(handicap.line),
      observedAt: handicap.observedAt || game.observedAt || null,
      provider,
      flipEver: flips.length > 0,
      struck: flips.map(function (event) {
        return { side: event.from, line: handicap.line == null ? null : Number(handicap.line), at: event.at || null };
      }),
      game,
    };
  }

  function install(global) {
    if (global.__baseballBet365Integration) return global.__baseballBet365Integration;
    let feed = { schemaVersion: 1, provider: 'bet365-official-first', matches: {}, leagues: {} };

    function validFeed(value) {
      return value && value.schemaVersion === 1 && value.provider === 'bet365-official-first' &&
        value.matches && typeof value.matches === 'object';
    }

    async function fetchOne(url) {
      const response = await global.fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
        cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (!validFeed(value)) throw new Error('BET365 棒球資料格式不合法');
      return value;
    }

    async function refresh() {
      try { feed = await fetchOne(RAW_URL); }
      catch (_) { feed = await fetchOne(LOCAL_URL); }
      try { if (typeof global.__backfillBet365TaiwanSnapshots === 'function') global.__backfillBet365TaiwanSnapshots(); } catch (_) {}
      try { if (typeof global.render === 'function') global.render(); } catch (_) {}
      return feed;
    }

    function gameFor(card, date) {
      let activeDate = date;
      if (!activeDate) {
        try { activeDate = typeof doc !== 'undefined' && doc && doc.activeDate; } catch (_) {}
      }
      return findGame(feed, card, activeDate || '');
    }

    const api = {
      refresh,
      gameFor,
      verdictFor,
      sourceLabel,
      _setFeed(value) { if (validFeed(value)) feed = value; },
      _getFeed() { return feed; },
    };
    global.__baseballBet365Integration = api;
    const start = function () {
      refresh().catch((error) => console.warn('[BET365 棒球官方盤口] 載入失敗:', error));
      global.setInterval(() => refresh().catch((error) => console.warn('[BET365 棒球官方盤口] 更新失敗:', error)), REFRESH_MS);
    };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    return api;
  }

  return { install, findGame, verdictFor, sourceLabel };
});
