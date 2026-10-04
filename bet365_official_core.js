'use strict';

const PRE_START_CUTOFF_MS = 30 * 1000;
const HISTORY_LIMIT = 240;
const EVENT_LIMIT = 120;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isPregameObservation(startTime, observedAt, cutoffMs = PRE_START_CUTOFF_MS) {
  const start = typeof startTime === 'number' ? startTime : Date.parse(startTime);
  const observed = typeof observedAt === 'number' ? observedAt : Date.parse(observedAt);
  return Number.isFinite(start) && Number.isFinite(observed) && observed < start - cutoffMs;
}

function normalizedPricePair(market, left, right) {
  const a = finite(market && market[left]);
  const b = finite(market && market[right]);
  if (a == null || b == null || a <= 1 || b <= 1) return null;
  return { [left]: a, [right]: b };
}

function normalizeMarketObservation(raw, context = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const provider = String(context.provider || source.provider || '').trim();
  const observedAt = String(context.observedAt || source.observedAt || '').trim();
  const scheduledStart = String(context.scheduledStart || source.scheduledStart || '').trim();
  const ml = normalizedPricePair(source.ml, 'away', 'home');
  const hdPrices = normalizedPricePair(source.hd, 'away', 'home');
  const totalPrices = normalizedPricePair(source.total, 'over', 'under');
  const favorite = source.hd && (source.hd.favorite === 'away' || source.hd.favorite === 'home')
    ? source.hd.favorite
    : null;
  const hdLine = finite(source.hd && source.hd.line);
  const totalLine = finite(source.total && source.total.line);
  const markets = {};
  if (ml) markets.ml = { ...ml, provider, observedAt };
  if (favorite && hdLine != null && hdLine > 0 && hdPrices) {
    markets.hd = { favorite, line: Math.abs(hdLine), ...hdPrices, provider, observedAt };
  }
  if (totalLine != null && totalLine > 0 && totalPrices) {
    markets.total = { line: Math.abs(totalLine), ...totalPrices, provider, observedAt };
  }
  return {
    ...clone(source),
    provider,
    observedAt,
    scheduledStart,
    favorite: markets.hd ? markets.hd.favorite : null,
    markets,
  };
}

function snapshotFor(observation) {
  return {
    provider: observation.provider,
    observedAt: observation.observedAt,
    favorite: observation.favorite || (observation.markets && observation.markets.hd && observation.markets.hd.favorite) || null,
    markets: clone(observation.markets || {}),
  };
}

function comparable(snapshot) {
  const value = clone(snapshot || {});
  delete value.observedAt;
  return JSON.stringify(value);
}

function mergeProviderObservation(previous, observation) {
  const prior = previous && typeof previous === 'object' ? clone(previous) : null;
  const next = observation && typeof observation === 'object' ? clone(observation) : null;
  if (!next) return prior;
  const evidenceEvents = Array.isArray(next.evidenceEvents) ? next.evidenceEvents.slice() : [];
  delete next.evidenceEvents;
  if (!isPregameObservation(next.scheduledStart, next.observedAt)) {
    if (!prior) return null;
    const cutoff = Date.parse(next.scheduledStart) - PRE_START_CUTOFF_MS;
    if (Number.isFinite(cutoff)) prior.frozenAt = prior.frozenAt || new Date(cutoff).toISOString();
    return prior;
  }

  next.favorite = next.favorite || (next.markets && next.markets.hd && next.markets.hd.favorite) || null;
  const history = prior && Array.isArray(prior.history) ? prior.history.slice() : [];
  const events = prior && Array.isArray(prior.events) ? prior.events.slice() : [];
  const providerHistories = prior && prior.providerHistories && typeof prior.providerHistories === 'object'
    ? clone(prior.providerHistories)
    : {};
  const snapshot = snapshotFor(next);
  const latest = history[history.length - 1] || null;

  if (!latest || comparable(latest) !== comparable(snapshot)) {
    if (latest) {
      if (latest.provider !== snapshot.provider) {
        events.push({ at: snapshot.observedAt, type: 'source-change', from: latest.provider, to: snapshot.provider });
      } else {
        const beforeHd = latest.markets && latest.markets.hd;
        const afterHd = snapshot.markets && snapshot.markets.hd;
        if (beforeHd && afterHd && beforeHd.favorite && afterHd.favorite && beforeHd.favorite !== afterHd.favorite) {
          events.push({
            at: snapshot.observedAt,
            type: 'favorite-flip',
            provider: snapshot.provider,
            from: beforeHd.favorite,
            to: afterHd.favorite,
            line: finite(afterHd.line),
          });
        } else if (beforeHd && afterHd && finite(beforeHd.line) !== finite(afterHd.line)) {
          events.push({
            at: snapshot.observedAt,
            type: 'handicap-line',
            provider: snapshot.provider,
            from: finite(beforeHd.line),
            to: finite(afterHd.line),
          });
        }
      }
    }
    history.push(snapshot);
    const sourceHistory = Array.isArray(providerHistories[snapshot.provider])
      ? providerHistories[snapshot.provider]
      : [];
    sourceHistory.push(snapshot);
    providerHistories[snapshot.provider] = sourceHistory.slice(-HISTORY_LIMIT);
  }

  for (const evidence of evidenceEvents) {
    if (!evidence || evidence.type !== 'favorite-flip') continue;
    if (!['away', 'home'].includes(evidence.from) || !['away', 'home'].includes(evidence.to) || evidence.from === evidence.to) continue;
    const duplicate = events.some((event) => event && (
      (evidence.evidenceId && event.evidenceId === evidence.evidenceId) ||
      (event.type === 'favorite-flip' && event.provider === evidence.provider && event.from === evidence.from && event.to === evidence.to)
    ));
    if (!duplicate) events.push(clone(evidence));
  }

  return {
    ...(prior || {}),
    ...next,
    frozenAt: null,
    history: history.slice(-HISTORY_LIMIT),
    providerHistories,
    events: events.slice(-EVENT_LIMIT),
    favoriteFlipCount: events.filter((event) => event && event.type === 'favorite-flip').length,
  };
}

function resolveMarket(officialMarket, fallbackMarket, frozenOfficialMarket) {
  if (officialMarket) return { ...clone(officialMarket), provider: 'bet365-official', stale: false };
  if (fallbackMarket) return { ...clone(fallbackMarket), provider: 'betexplorer', stale: false };
  if (frozenOfficialMarket) return { ...clone(frozenOfficialMarket), provider: 'bet365-official', stale: true };
  return null;
}

function resolveGameSources(officialGame, fallbackGame, frozenOfficialGame) {
  const official = officialGame && officialGame.markets || {};
  const fallback = fallbackGame && fallbackGame.markets || {};
  const frozen = frozenOfficialGame && frozenOfficialGame.markets || {};
  const markets = {};
  for (const market of ['ml', 'hd', 'total']) {
    const resolved = resolveMarket(official[market], fallback[market], frozen[market]);
    if (resolved) markets[market] = resolved;
  }
  return {
    markets,
    favorite: markets.hd && markets.hd.favorite || null,
    line: markets.hd && markets.hd.line != null ? Number(markets.hd.line) : null,
    mixedSources: new Set(Object.values(markets).map((market) => market.provider)).size > 1,
  };
}

module.exports = {
  PRE_START_CUTOFF_MS,
  isPregameObservation,
  normalizeMarketObservation,
  mergeProviderObservation,
  resolveMarket,
  resolveGameSources,
};
