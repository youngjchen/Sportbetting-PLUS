'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPregameObservation,
  mergeProviderObservation,
  resolveMarket,
  resolveGameSources,
} = require('../bet365_official_core.js');

const START = Date.parse('2026-10-04T10:00:00.000Z');

function observation(provider, favorite, line, observedAt) {
  return {
    provider,
    scheduledStart: new Date(START).toISOString(),
    observedAt,
    favorite,
    markets: {
      ml: { away: 2.15, home: 1.68 },
      hd: { favorite, line, away: 1.91, home: 1.91 },
      total: { line: 7.5, over: 1.95, under: 1.87 },
    },
  };
}

test('rejects observations at the final thirty seconds and after start', () => {
  assert.equal(isPregameObservation(START, START - 30001), true);
  assert.equal(isPregameObservation(START, START - 30000), false);
  assert.equal(isPregameObservation(START, START - 1), false);
  assert.equal(isPregameObservation(START, START + 1), false);
});

test('provider change is recorded without inventing a favorite flip', () => {
  const first = mergeProviderObservation(
    null,
    observation('bet365-official', 'home', 1.5, '2026-10-04T08:00:00.000Z')
  );
  const second = mergeProviderObservation(
    first,
    observation('betexplorer', 'away', 1.5, '2026-10-04T08:05:00.000Z')
  );

  assert.equal(second.favoriteFlipCount, 0);
  assert.deepEqual(second.events, [{
    at: '2026-10-04T08:05:00.000Z',
    type: 'source-change',
    from: 'bet365-official',
    to: 'betexplorer',
  }]);
});

test('same provider line movement does not count as a favorite flip', () => {
  const first = mergeProviderObservation(
    null,
    observation('bet365-official', 'away', 4.5, '2026-10-04T08:00:00.000Z')
  );
  const second = mergeProviderObservation(
    first,
    observation('bet365-official', 'away', 1.5, '2026-10-04T08:05:00.000Z')
  );

  assert.equal(second.favoriteFlipCount, 0);
  assert.equal(second.events[0].type, 'handicap-line');
  assert.equal(second.events[0].provider, 'bet365-official');
  assert.equal(second.events[0].from, 4.5);
  assert.equal(second.events[0].to, 1.5);
});

test('same provider favorite change counts as one real flip', () => {
  const first = mergeProviderObservation(
    null,
    observation('bet365-official', 'away', 1.5, '2026-10-04T08:00:00.000Z')
  );
  const second = mergeProviderObservation(
    first,
    observation('bet365-official', 'home', 1.5, '2026-10-04T08:05:00.000Z')
  );

  assert.equal(second.favoriteFlipCount, 1);
  assert.equal(second.events[0].type, 'favorite-flip');
  assert.equal(second.events[0].provider, 'bet365-official');
  assert.equal(second.events[0].line, 1.5);
  assert.equal(second.events[0].from, 'away');
  assert.equal(second.events[0].to, 'home');
});

test('official market wins and fallback only fills missing markets', () => {
  const officialMl = {
    provider: 'bet365-official',
    observedAt: '2026-10-04T08:00:00.000Z',
    away: 2.1,
    home: 1.72,
  };
  const fallbackMl = {
    provider: 'betexplorer',
    observedAt: '2026-10-04T08:01:00.000Z',
    away: 2.2,
    home: 1.66,
  };
  const fallbackHd = {
    provider: 'betexplorer',
    observedAt: '2026-10-04T08:01:00.000Z',
    favorite: 'home',
    line: 1.5,
    away: 1.8,
    home: 2.02,
  };

  assert.deepEqual(resolveMarket(officialMl, fallbackMl, null), {
    ...officialMl,
    provider: 'bet365-official',
    stale: false,
  });

  const resolved = resolveGameSources(
    { markets: { ml: officialMl } },
    { markets: { ml: fallbackMl, hd: fallbackHd } },
    null
  );
  assert.equal(resolved.markets.ml.provider, 'bet365-official');
  assert.equal(resolved.markets.hd.provider, 'betexplorer');
  assert.equal(resolved.favorite, 'home');
});

test('frozen official snapshot is stale and ranks below fresh fallback', () => {
  const frozen = { away: 1.9, home: 1.9, observedAt: '2026-10-04T07:00:00.000Z' };
  const fallback = { away: 1.84, home: 1.98, observedAt: '2026-10-04T08:00:00.000Z' };

  assert.deepEqual(resolveMarket(null, fallback, frozen), {
    ...fallback,
    provider: 'betexplorer',
    stale: false,
  });
  assert.deepEqual(resolveMarket(null, null, frozen), {
    ...frozen,
    provider: 'bet365-official',
    stale: true,
  });
});
