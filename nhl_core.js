/* NHL 共用純函式：結算、推薦冷啟動、STAKE 盤口正規化。 */
'use strict';

const DAY_MS = 86400000;

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function settleNhl(model) {
  const away = numberOrNull(model && model.awayScore);
  const home = numberOrNull(model && model.homeScore);
  if (away == null || home == null) return null;
  const out = {
    awayScore: away,
    homeScore: home,
    decidedBy: (model && model.decidedBy) || null,
    ml: away > home ? 'away' : home > away ? 'home' : 'tie'
  };
  const hdVal = numberOrNull(model && model.hdVal);
  if (model && (model.hdFav === 'away' || model.hdFav === 'home') && hdVal != null) {
    const favMargin = model.hdFav === 'away' ? away - home : home - away;
    const delta = favMargin - Math.abs(hdVal);
    out.hd = delta > 0 ? 'cover' : delta < 0 ? 'nocover' : 'push';
  }
  const totalLine = numberOrNull(model && model.totLine);
  if (totalLine != null) {
    const total = away + home;
    out.tot = total > totalLine ? 'over' : total < totalLine ? 'under' : 'push';
  }
  return out;
}

function dateOnlyMs(value) {
  const text = String(value || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

function recommendationPolicy(input) {
  const start = dateOnlyMs(input && input.seasonStart);
  const now = dateOnlyMs(input && input.now);
  const week = Number.isFinite(start) && Number.isFinite(now) && now >= start
    ? Math.floor((now - start) / (7 * DAY_MS)) + 1
    : 0;
  if (week < 2) return { week, fetch: false, eligible: false, tier: 'blocked' };

  const winPercentage = numberOrNull(input && input.winPercentage);
  const totalBets = numberOrNull(input && input.totalBets);
  if (winPercentage == null || winPercentage <= 60 || totalBets == null || totalBets < 0) {
    return { week, fetch: true, eligible: false, tier: 'below-threshold' };
  }
  const tier = totalBets >= 30 ? 'formal' : totalBets >= 15 ? 'candidate' : 'observe';
  return { week, fetch: true, eligible: true, tier };
}

function parseStakeFixtureName(name) {
  const parts = String(name || '').split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
  return parts.length === 2 ? parts : [];
}

function marketLine(market) {
  const text = `${market && market.specifiers || ''}|${market && market.extendedSpecifiers || ''}|${market && market.name || ''}`;
  const tagged = /(?:hcp|handicap|total|line)=(-?\d+(?:\.\d+)?)/i.exec(text);
  if (tagged) return Number(tagged[1]);
  const loose = /(?:^|\s)([+-]?\d+(?:\.\d+)?)(?:\s|$)/.exec(String(market && market.name || ''));
  return loose ? Number(loose[1]) : null;
}

function cleanOutcomes(market) {
  return (Array.isArray(market && market.outcomes) ? market.outcomes : [])
    .filter(item => item && item.active !== false && Number.isFinite(Number(item.odds)))
    .map(item => ({ name: String(item.name || '').trim(), odds: Number(item.odds) }));
}

function wholeGame(name) {
  return !/(?:1st|2nd|3rd|first|second|third|period|player|team total|race to)/i.test(name);
}

function normalizedMarket(market, includeLine) {
  const out = { market: String(market.name || '').trim() };
  if (includeLine) out.line = marketLine(market);
  out.outcomes = cleanOutcomes(market);
  return out;
}

function normalizeStakeMarkets(groups) {
  const markets = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const market of Array.isArray(group && group.markets) ? group.markets : []) {
      if (!market || !wholeGame(String(market.name || ''))) continue;
      if (market.status && market.status !== 'active') continue;
      const outcomes = cleanOutcomes(market);
      if (outcomes.length !== 2) continue;
      markets.push(market);
    }
  }

  const preferOvertime = list => list.sort((a, b) => {
    const score = item => /(incl|include).*(overtime|penalt)|overtime|shootout/i.test(String(item.name || '')) ? 1 : 0;
    return score(b) - score(a);
  })[0];
  const ml = preferOvertime(markets.filter(m => /money\s*line|match winner|winner.*two/i.test(String(m.name || ''))));
  const hd = preferOvertime(markets.filter(m => /asian handicap|handicap|puck line|spread/i.test(String(m.name || ''))));
  const tot = preferOvertime(markets.filter(m => /(?:^|\s)(?:total|over\/?under)(?:\s|$|\()/i.test(String(m.name || ''))));
  const out = {};
  if (ml) out.ml = normalizedMarket(ml, false);
  if (hd) out.hd = normalizedMarket(hd, true);
  if (tot) out.tot = normalizedMarket(tot, true);
  return out;
}

function snapshotMarkets(game) {
  const out = {};
  for (const key of ['ml', 'hd', 'tot']) if (game && game[key]) out[key] = game[key];
  return out;
}

function stableMarketJson(value) {
  return JSON.stringify(value || {});
}

function favoriteName(hd) {
  if (!hd || !Array.isArray(hd.outcomes) || hd.outcomes.length !== 2) return null;
  if (hd.favSide === 'away' || hd.favSide === 'home') {
    const explicit = hd.outcomes.find((outcome) => outcome && outcome.side === hd.favSide);
    if (explicit && explicit.name) return explicit.name;
  }
  const signed = hd.outcomes.find((outcome) => Number(outcome && outcome.line) < 0);
  if (signed && signed.name) return signed.name;
  const sorted = hd.outcomes.slice().sort((a, b) => Number(a.odds) - Number(b.odds));
  return Number(sorted[0].odds) < Number(sorted[1].odds) ? sorted[0].name : null;
}

function mergeStakeGame(previous, current, observedAt) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const cur = current && typeof current === 'object' ? current : {};
  const merged = { ...prev, ...cur };
  const history = Array.isArray(prev.history) ? prev.history.slice() : [];
  const events = Array.isArray(prev.events) ? prev.events.slice() : [];
  const snapshot = { at: observedAt, ...snapshotMarkets(cur) };
  const latest = history[0] || null;
  if (!latest || stableMarketJson(snapshotMarkets(latest)) !== stableMarketJson(snapshotMarkets(snapshot))) {
    if (latest && latest.hd && snapshot.hd) {
      if (numberOrNull(latest.hd.line) !== numberOrNull(snapshot.hd.line)) {
        events.unshift({ at: observedAt, type: 'handicap-line', from: numberOrNull(latest.hd.line), to: numberOrNull(snapshot.hd.line) });
      }
      const beforeFavorite = favoriteName(latest.hd);
      const afterFavorite = favoriteName(snapshot.hd);
      if (beforeFavorite && afterFavorite && beforeFavorite !== afterFavorite) {
        events.unshift({ at: observedAt, type: 'favorite-flip', from: beforeFavorite, to: afterFavorite });
      }
    }
    history.unshift(snapshot);
  }
  merged.history = history.slice(0, 240);
  merged.events = events.slice(0, 120);
  return merged;
}

module.exports = {
  settleNhl,
  recommendationPolicy,
  parseStakeFixtureName,
  normalizeStakeMarkets,
  mergeStakeGame
};
