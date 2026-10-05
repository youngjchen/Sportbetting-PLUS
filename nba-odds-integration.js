'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_MS = 30 * 60 * 1000;
  const URLS = {
    stake: [
      'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/nba_stake_odds.json',
      './data/nba_stake_odds.json',
    ],
    bet365: [
      'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/nba_bet365_odds.json',
      './data/nba_bet365_odds.json',
    ],
  };

  function findMatch(feed, model) {
    if (!feed || !feed.matches || !model) return null;
    if (model.officialId && feed.matches[model.officialId]) return feed.matches[model.officialId];
    return Object.values(feed.matches).find((game) => game && game.away === model.away && game.home === model.home &&
      taiwanDate(game.scheduledStart) === String(model.date || '')) || null;
  }

  function taiwanDate(value) {
    const stamp = Date.parse(value || '');
    return Number.isFinite(stamp) ? new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) : '';
  }

  function isUsable(game, now) {
    if (!game) return false;
    if (game.frozenAt) return true;
    const observed = Date.parse(game.observedAt || '');
    return Number.isFinite(observed) && Number(now) - observed <= STALE_MS;
  }

  function applyStakeToItem(item, model, game, now) {
    if (!item || !model || !isUsable(game, now == null ? Date.now() : now)) return false;
    if (item.stakeAutoHandicap === undefined) {
      item.stakeAutoHandicap = item.hdVal == null || item.hdVal === '';
    }
    if (item.stakeAutoTotal === undefined) {
      item.stakeAutoTotal = item.totVal == null || item.totVal === '';
    }
    let changed = false;
    if (item.stakeAutoHandicap && (game.favorite === 'away' || game.favorite === 'home') && game.line != null) {
      if (item.hdFav !== game.favorite) { item.hdFav = game.favorite; changed = true; }
      if (Number(item.hdVal) !== Number(game.line) || item.hdVal === '') { item.hdVal = Number(game.line); changed = true; }
      if (item.hdFavOverride !== undefined) { delete item.hdFavOverride; changed = true; }
    }
    if (item.stakeAutoTotal && game.total && game.total.line != null &&
        (Number(item.totVal) !== Number(game.total.line) || item.totVal === '')) {
      item.totVal = Number(game.total.line);
      changed = true;
    }
    item.stakeMonitorOfficialId = game.officialId || model.officialId || null;
    item.stakeMonitorObservedAt = game.observedAt || null;
    return changed;
  }

  function markManual(item, field, favorite) {
    if (!item) return;
    if (field === 'handicap') {
      item.stakeAutoHandicap = false;
      if (favorite === 'away' || favorite === 'home') {
        item.hdFavOverride = favorite;
        delete item.hdSwap;
      }
    }
    if (field === 'total') item.stakeAutoTotal = false;
  }

  function restoreAuto(item, field, game, model, now) {
    if (!item) return false;
    if (field === 'handicap') {
      item.stakeAutoHandicap = true;
      delete item.hdFavOverride;
      delete item.hdSwap;
    }
    if (field === 'total') item.stakeAutoTotal = true;
    return applyStakeToItem(item, model || {}, game, now == null ? Date.now() : now);
  }

  function odds(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? String(Math.round(number * 100) / 100) : '—';
  }

  function marketShape(source, model) {
    if (!source) return null;
    if (source.ml || source.hd || source.ou) {
      return { moneyline: source.ml || null, favorite: source.hd && source.hd.favorite,
        line: source.hd && source.hd.line, handicapOdds: source.hd ? { away: source.hd.away, home: source.hd.home } : null,
        total: source.ou || null };
    }
    return source;
  }

  function sourceText(label, source, model) {
    const data = marketShape(source, model);
    let displayLabel = label;
    if (label === 'BET365' && source) {
      const providers = new Set();
      if (source.provider) providers.add(source.provider);
      if (source.markets) Object.values(source.markets).forEach((market) => {
        if (market && market.provider) providers.add(market.provider);
      });
      const official = providers.has('bet365-official');
      const fallback = providers.has('betexplorer');
      if (official && fallback) displayLabel = 'BET365 官網＋BetExplorer 備援';
      else if (official) displayLabel = 'BET365 官網';
      else if (fallback) displayLabel = 'BetExplorer 備援';
    }
    if (!data) return `${displayLabel}：未開盤`;
    const away = model && model.away || data.away || '客隊';
    const home = model && model.home || data.home || '主隊';
    const parts = [];
    if (data.moneyline) parts.push(`獨贏 客 ${away} ${odds(data.moneyline.away)}／主 ${home} ${odds(data.moneyline.home)}`);
    if ((data.favorite === 'away' || data.favorite === 'home') && data.line != null) {
      const favorite = data.favorite === 'away' ? away : home;
      const underdog = data.favorite === 'away' ? home : away;
      const favOdds = data.handicapOdds && data.handicapOdds[data.favorite];
      const dogSide = data.favorite === 'away' ? 'home' : 'away';
      const dogOdds = data.handicapOdds && data.handicapOdds[dogSide];
      parts.push(`讓 ${favorite} -${Math.abs(Number(data.line))} ${odds(favOdds)}／受讓 ${underdog} +${Math.abs(Number(data.line))} ${odds(dogOdds)}`);
    }
    if (data.total && data.total.line != null) {
      parts.push(`大 ${data.total.line} ${odds(data.total.over)}／小 ${data.total.line} ${odds(data.total.under)}`);
    }
    return parts.length ? `${displayLabel}：${parts.join('｜')}` : `${displayLabel}：未開盤`;
  }

  function timeText(value) {
    const stamp = Date.parse(value || '');
    return Number.isFinite(stamp) ? new Date(stamp + 8 * 3600000).toISOString().slice(11, 16) : '—';
  }

  function monitorApi(documentRef) {
    const view = documentRef && documentRef.defaultView;
    if (view && view.__sportsMarketMonitor) return view.__sportsMarketMonitor;
    if (typeof require === 'function') {
      try { return require('./sports-market-monitor.js'); } catch (_) {}
    }
    return null;
  }

  function sideName(model, side) {
    return side === 'away' ? model.away : side === 'home' ? model.home : '—';
  }

  function numberText(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : String(value);
  }

  function sourceLabel(label, source) {
    if (label !== 'BET365' || !source) return label === 'STAKE' ? 'Stake 官網' : label;
    const providers = new Set();
    if (source.provider) providers.add(source.provider);
    if (source.markets) Object.values(source.markets).forEach((market) => {
      if (market && market.provider) providers.add(market.provider);
    });
    if (providers.has('bet365-official') && providers.has('betexplorer')) return 'BET365 官網；缺項由 BetExplorer 備援';
    if (providers.has('bet365-official')) return 'BET365 官網';
    if (providers.has('betexplorer')) return 'BetExplorer 備援';
    return 'BET365';
  }

  function currentLabel(model, source) {
    const data = marketShape(source, model);
    if (!data || (data.favorite !== 'away' && data.favorite !== 'home') || data.line == null) return '未取得方向';
    return `${sideName(model, data.favorite)}讓${numberText(Math.abs(Number(data.line)))}`;
  }

  function marketDetails(source, model) {
    const data = marketShape(source, model);
    if (!data) return [];
    const rows = [];
    const away = model.away || data.away || '客隊';
    const home = model.home || data.home || '主隊';
    if (data.moneyline) rows.push(['獨贏', `客 ${away} ${odds(data.moneyline.away)}／主 ${home} ${odds(data.moneyline.home)}`]);
    if ((data.favorite === 'away' || data.favorite === 'home') && data.line != null) {
      const dog = data.favorite === 'away' ? 'home' : 'away';
      rows.push(['讓分', `${sideName(model, data.favorite)} -${numberText(Math.abs(Number(data.line)))} ${odds(data.handicapOdds && data.handicapOdds[data.favorite])}／${sideName(model, dog)} +${numberText(Math.abs(Number(data.line)))} ${odds(data.handicapOdds && data.handicapOdds[dog])}`]);
    }
    if (data.total && data.total.line != null) rows.push(['大小', `大 ${numberText(data.total.line)} ${odds(data.total.over)}／小 ${numberText(data.total.line)} ${odds(data.total.under)}`]);
    return rows;
  }

  function sameNumber(left, right) {
    if (left == null && right == null) return true;
    return Number(left) === Number(right);
  }

  function meaningfulEvents(source, model) {
    if (!source) return [];
    const events = [];
    const seen = new Set();
    const push = (event) => {
      const key = `${event.at || ''}|${event.kind || ''}|${event.text}`;
      if (!seen.has(key)) { seen.add(key); events.push(event); }
    };
    for (const event of Array.isArray(source.events) ? source.events : []) {
      if (!event) continue;
      if (event.type === 'favorite-flip' && event.from !== event.to) push({ at: event.at, kind: 'favorite', text: `${sideName(model, event.from)} → ${sideName(model, event.to)}` });
      else if (event.type === 'handicap-line' || event.type === 'line-change') push({ at: event.at, kind: 'handicap-line', text: `讓分線 ${numberText(event.from)} → ${numberText(event.to)}` });
      else if (event.type === 'total-line' || event.type === 'total-change') push({ at: event.at, kind: 'total-line', text: `大小 ${numberText(event.from)} → ${numberText(event.to)}` });
    }
    const snapshots = (Array.isArray(source.history) ? source.history : []).filter(Boolean).slice()
      .sort((left, right) => Date.parse(left.observedAt || left.at || '') - Date.parse(right.observedAt || right.at || ''));
    if (snapshots.length) {
      const rows = snapshots.concat([{ ...source, observedAt: source.observedAt || source.frozenAt }]);
      for (let index = 1; index < rows.length; index++) {
        const before = marketShape(rows[index - 1], model) || {};
        const after = marketShape(rows[index], model) || {};
        const at = rows[index].observedAt || rows[index].at || null;
        if ((before.favorite === 'away' || before.favorite === 'home') && (after.favorite === 'away' || after.favorite === 'home') && before.favorite !== after.favorite) {
          push({ at, kind: 'favorite', text: `${sideName(model, before.favorite)} → ${sideName(model, after.favorite)}` });
        }
        if (!sameNumber(before.line, after.line)) push({ at, kind: 'handicap-line', text: `讓分線 ${numberText(before.line)} → ${numberText(after.line)}` });
        const beforeTotal = before.total && before.total.line;
        const afterTotal = after.total && after.total.line;
        if (!sameNumber(beforeTotal, afterTotal)) push({ at, kind: 'total-line', text: `大小 ${numberText(beforeTotal)} → ${numberText(afterTotal)}` });
      }
    }
    return events.sort((left, right) => Date.parse(left.at || '') - Date.parse(right.at || ''));
  }

  function renderMonitor(model, item, sources, now, documentRef, evidence) {
    if (!model || !documentRef) return null;
    const api = monitorApi(documentRef);
    if (!api || typeof api.renderPlatformMonitor !== 'function') return null;
    const stake = sources && sources.stake;
    const bet365 = sources && sources.bet365 || evidence && evidence.bet365Fallback || null;
    const taiwanFavorite = evidence && evidence.taiwanFavorite || model.hdFav;
    const taiwan = model.taiwan || ((taiwanFavorite === 'away' || taiwanFavorite === 'home') ? {
      favorite: taiwanFavorite, line: model.hdVal,
      total: model.totLine == null ? null : { line: model.totLine },
    } : null);
    const stakeEvents = meaningfulEvents(stake, model);
    const bet365Events = meaningfulEvents(bet365, model);
    const stakeMarket = marketShape(stake, model);
    const bet365Market = marketShape(bet365, model);
    const taiwanMarket = marketShape(taiwan, model);
    const taiwanEvents = evidence && Array.isArray(evidence.taiwanEvents) ? evidence.taiwanEvents : [];
    const controls = [];
    if (item && item.stakeAutoHandicap === false) {
      controls.push({ label: '↻ 恢復自動讓分', onClick() {
        restoreAuto(item, 'handicap', stake, model, Date.now());
        const view = documentRef.defaultView;
        try { if (view && typeof view.save === 'function') view.save(); } catch (_) {}
        try { if (view && typeof view.render === 'function') view.render(); } catch (_) {}
      } });
    }
    if (item && item.stakeAutoTotal === false) {
      controls.push({ label: '↻ 恢復自動大小', onClick() {
        restoreAuto(item, 'total', stake, model, Date.now());
        const view = documentRef.defaultView;
        try { if (view && typeof view.save === 'function') view.save(); } catch (_) {}
        try { if (view && typeof view.render === 'function') view.render(); } catch (_) {}
      } });
    }
    const taiwanChanged = !!((evidence && Number(evidence.taiwanFlipCount)) || taiwanEvents.some((event) => event && event.kind === 'favorite'));
    return api.renderPlatformMonitor({
      documentRef,
      sources: [
        {
          key: 'stake', label: 'STAKE', side: stakeMarket && stakeMarket.favorite,
          current: currentLabel(model, stake), available: !!stake,
          changed: stakeEvents.some((event) => event.kind === 'favorite'),
          details: marketDetails(stake, model), events: stakeEvents,
          sourceLabel: stake ? 'Stake 官網' : null, controls,
        },
        {
          key: 'bet365', label: 'BET365', side: bet365Market && bet365Market.favorite,
          current: currentLabel(model, bet365), available: !!bet365,
          changed: bet365Events.some((event) => event.kind === 'favorite') || !!(evidence && Number(evidence.bet365FlipCount)),
          details: marketDetails(bet365, model), events: bet365Events,
          sourceLabel: bet365 ? sourceLabel('BET365', bet365) : null,
        },
        {
          key: 'taiwan', label: '台彩', side: taiwanMarket && taiwanMarket.favorite,
          current: currentLabel(model, taiwan), available: !!taiwan,
          changed: taiwanChanged, details: marketDetails(taiwan, model), events: taiwanEvents,
          sourceLabel: taiwan ? '玩運彩開盤' : null,
        },
      ],
    });
  }

  function install(global) {
    if (global.__nbaOddsIntegration) return global.__nbaOddsIntegration;
    const feeds = { stake: { matches: {} }, bet365: { matches: {} } };

    async function fetchOne(urls) {
      let last;
      for (const url of urls) {
        try {
          const response = await global.fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const value = await response.json();
          if (!value || !value.matches || typeof value.matches !== 'object') throw new Error('資料格式錯誤');
          return value;
        } catch (error) { last = error; }
      }
      throw last || new Error('資料載入失敗');
    }

    async function refresh() {
      const results = await Promise.allSettled([fetchOne(URLS.stake), fetchOne(URLS.bet365)]);
      if (results[0].status === 'fulfilled') feeds.stake = results[0].value;
      if (results[1].status === 'fulfilled') feeds.bet365 = results[1].value;
      try { if (typeof global.render === 'function') global.render(); } catch (_) {}
      return feeds;
    }

    const api = {
      refresh,
      gameFor(model, source) { return findMatch(feeds[source || 'stake'], model); },
      composeModel(model, item) {
        const stake = findMatch(feeds.stake, model);
        applyStakeToItem(item, model, stake, Date.now());
        const favorite = item && item.hdFavOverride || item && item.hdFav || model.hdFav;
        const line = item && item.hdVal != null && item.hdVal !== '' ? Number(item.hdVal) : model.hdVal;
        const total = item && item.totVal != null && item.totVal !== '' ? Number(item.totVal) : model.totLine;
        return { ...model, hdFav: favorite, hdVal: line, hdSrc: stake ? 'STAKE' : model.hdSrc, totLine: total };
      },
      markManual,
      restoreAuto(item, field, model) { return restoreAuto(item, field, findMatch(feeds.stake, model), model, Date.now()); },
      renderMonitor(model, item, evidence) {
        return renderMonitor(model, item, { stake: findMatch(feeds.stake, model), bet365: findMatch(feeds.bet365, model) }, Date.now(), global.document, evidence);
      },
      _setFeeds(value) { if (value && value.stake) feeds.stake = value.stake; if (value && value.bet365) feeds.bet365 = value.bet365; },
      _getFeeds() { return feeds; },
    };
    global.__nbaOddsIntegration = api;
    const start = function () {
      refresh().catch((error) => console.warn('[NBA 三方盤口] 載入失敗:', error));
      global.setInterval(() => refresh().catch((error) => console.warn('[NBA 三方盤口] 更新失敗:', error)), REFRESH_MS);
    };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    return api;
  }

  return { install, findMatch, applyStakeToItem, markManual, restoreAuto, sourceText, renderMonitor };
});
