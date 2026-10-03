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
      if (favorite === 'away' || favorite === 'home') item.hdFavOverride = favorite;
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
    if (!data) return `${label}：未開盤`;
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
    return parts.length ? `${label}：${parts.join('｜')}` : `${label}：未開盤`;
  }

  function timeText(value) {
    const stamp = Date.parse(value || '');
    return Number.isFinite(stamp) ? new Date(stamp + 8 * 3600000).toISOString().slice(11, 16) : '—';
  }

  function renderMonitor(model, item, sources, now, documentRef) {
    if (!model || !documentRef) return null;
    const box = documentRef.createElement('div');
    box.className = 'nba-odds-monitor';
    const values = [
      ['STAKE', sources && sources.stake],
      ['BET365', sources && sources.bet365],
      ['台彩', model.taiwan || null],
    ];
    for (const [label, source] of values) {
      const row = documentRef.createElement('div');
      row.className = `nba-odds-row nba-odds-${label.toLowerCase()}`;
      row.textContent = sourceText(label, source, model);
      box.appendChild(row);
    }
    const stake = sources && sources.stake;
    if (item && item.stakeAutoHandicap === false) {
      const button = documentRef.createElement('button');
      button.type = 'button'; button.className = 'nba-odds-auto'; button.textContent = '↻ 讓分自動';
      button.onclick = function (event) {
        event.stopPropagation(); restoreAuto(item, 'handicap', stake, model, Date.now());
        const view = documentRef.defaultView;
        try { if (view && typeof view.save === 'function') view.save(); } catch (_) {}
        try { if (view && typeof view.render === 'function') view.render(); } catch (_) {}
      };
      box.appendChild(button);
    }
    if (item && item.stakeAutoTotal === false) {
      const button = documentRef.createElement('button');
      button.type = 'button'; button.className = 'nba-odds-auto'; button.textContent = '↻ 大小自動';
      button.onclick = function (event) {
        event.stopPropagation(); restoreAuto(item, 'total', stake, model, Date.now());
        const view = documentRef.defaultView;
        try { if (view && typeof view.save === 'function') view.save(); } catch (_) {}
        try { if (view && typeof view.render === 'function') view.render(); } catch (_) {}
      };
      box.appendChild(button);
    }
    const history = stake && Array.isArray(stake.history) ? stake.history : [];
    if (history.length) {
      const toggle = documentRef.createElement('button');
      toggle.type = 'button'; toggle.className = 'nba-odds-history-toggle'; toggle.textContent = '▾ STAKE 歷史';
      const detail = documentRef.createElement('div');
      detail.className = 'nba-odds-history'; detail.hidden = true;
      for (const snap of history) {
        const line = documentRef.createElement('div');
        line.textContent = `${timeText(snap.observedAt)} ${sourceText('STAKE', snap, model).replace(/^STAKE：/, '')}`;
        detail.appendChild(line);
      }
      toggle.onclick = function (event) { event.stopPropagation(); detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? '▾ STAKE 歷史' : '▴ STAKE 歷史'; };
      box.append(toggle, detail);
    }
    return box;
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
      renderMonitor(model, item) {
        return renderMonitor(model, item, { stake: findMatch(feeds.stake, model), bet365: findMatch(feeds.bet365, model) }, Date.now(), global.document);
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
