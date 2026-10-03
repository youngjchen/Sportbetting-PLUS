'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildOfficialGames,
  matchOfficialGame,
  normalizeBaseballMarkets,
  mergeBaseballObservation,
  buildBaseballFeed,
} = require('../baseball_stake_core.js');

const START = '2026-10-04T05:00:00.000Z'; // 台灣 13:00

function scheduleRows() {
  return [
    {
      league: 'KBO', officialId: 'KBO_20261004_DOOSAN@SAMSUNG_1300',
      date: '2026-10-04', time: '13:00', awayTeam: '斗山熊', homeTeam: '三星獅', status: 'upcoming',
    },
    {
      league: 'MLB', officialId: 'MLB_20261004_CWS@CLE_0100',
      date: '2026-10-04', time: '01:00', awayTeam: '白襪', homeTeam: '守護者', status: 'upcoming',
    },
    {
      league: 'NPB', officialId: 'NPB_20261004_Tigers@DeNA_1700_G1',
      date: '2026-10-04', time: '17:00', awayTeam: '阪神', homeTeam: '橫濱', status: 'upcoming',
    },
    {
      league: 'NPB', officialId: 'NPB_20261004_Tigers@DeNA_2000_G2',
      date: '2026-10-04', time: '20:00', awayTeam: '阪神', homeTeam: '橫濱', status: 'upcoming',
    },
  ];
}

function marketInput(overrides = {}) {
  return {
    ml: { away: 2.05, home: 1.78 },
    hd: { favorite: 'away', line: 1.5, away: 1.92, home: 1.88 },
    total: { line: 7.5, over: 1.9, under: 1.9 },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    league: 'KBO', officialId: 'KBO_20261004_DOOSAN@SAMSUNG_1300',
    scheduledStart: START, away: '斗山熊', home: '三星獅',
    favorite: 'away', rawLine: 1.5, canonicalLine: 1.5,
    handicapOdds: { away: 1.92, home: 1.88 },
    moneyline: { away: 2.05, home: 1.78 },
    total: { line: 7.5, over: 1.9, under: 1.9 },
    sources: { direction: 'stake-official', handicapOdds: 'stake-official', total: 'stake-official' },
    observedAt: '2026-10-04T04:30:00.000Z', partial: false,
    ...overrides,
  };
}

test('official schedule whitelist matches Stake home-away title and rejects MLB futures', () => {
  const games = buildOfficialGames(scheduleRows());
  const kbo = matchOfficialGame({
    league: 'KBO', name: 'Samsung Lions - Doosan Bears', startTime: Date.parse(START),
  }, games);
  const future = matchOfficialGame({
    league: 'MLB', name: 'Cleveland Guardians - AL 3/6', startTime: Date.parse('2026-10-03T17:00:00Z'),
  }, games);

  assert.equal(kbo.officialId, 'KBO_20261004_DOOSAN@SAMSUNG_1300');
  assert.equal(future, null);
});

test('same-team doubleheaders are matched by the nearest official start time', () => {
  const games = buildOfficialGames(scheduleRows());
  const game = matchOfficialGame({
    league: 'NPB', name: 'Yokohama Dena Baystars - Hanshin Tigers',
    startTime: Date.parse('2026-10-04T12:00:00Z'),
  }, games);

  assert.equal(game.officialId, 'NPB_20261004_Tigers@DeNA_2000_G2');
});

test('MLB raw one-run line keeps Stake direction but takes only BetExplorer Stake.com 1.5 prices', () => {
  const fallback = {
    bookmaker: 'Stake.com',
    markets: { hd: { active: { line: 1.5, favorite: 'home', away: 1.66, home: 2.22 } } },
  };
  const normalized = normalizeBaseballMarkets('MLB', marketInput({
    hd: { favorite: 'away', line: 1, away: 1.5, home: 2.4 },
  }), fallback);

  assert.equal(normalized.favorite, 'away');
  assert.equal(normalized.rawLine, 1);
  assert.equal(normalized.canonicalLine, 1.5);
  assert.deepEqual(normalized.handicapOdds, { away: 1.66, home: 2.22 });
  assert.equal(normalized.sources.handicapOdds, 'betexplorer-stake-row');
});

test('MLB one-run line never substitutes Bet365 or a non-Stake fallback row', () => {
  const normalized = normalizeBaseballMarkets('MLB', marketInput({
    hd: { favorite: 'home', line: 1, away: 2.4, home: 1.5 },
  }), {
    bookmaker: 'Bet365',
    markets: { hd: { active: { line: 1.5, away: 1.8, home: 2.0 } } },
  });

  assert.equal(normalized.favorite, 'home');
  assert.equal(normalized.canonicalLine, 1.5);
  assert.equal(normalized.handicapOdds, null);
  assert.equal(normalized.partial, true);
});

test('missing Stake handicap and total lines stay null instead of becoming zero', () => {
  const normalized = normalizeBaseballMarkets('NPB', {
    ml: { away: 2.05, home: 1.78 },
  }, null);

  assert.equal(normalized.rawLine, null);
  assert.equal(normalized.canonicalLine, null);
  assert.equal(normalized.total, null);
  assert.equal(normalized.partial, true);
});

test('observation completed inside final thirty seconds is rejected and freezes previous data', () => {
  const first = mergeBaseballObservation(null, observation());
  const late = mergeBaseballObservation(first, observation({
    favorite: 'home', observedAt: '2026-10-04T04:59:31.000Z',
  }));

  assert.equal(late.favorite, 'away');
  assert.equal(late.favoriteFlipCount, 0);
  assert.equal(late.history.length, 1);
  assert.equal(late.frozenAt, '2026-10-04T04:59:30.000Z');
});

test('unchanged observations dedupe while real favorite changes append a transition', () => {
  const first = mergeBaseballObservation(null, observation());
  const same = mergeBaseballObservation(first, observation({ observedAt: '2026-10-04T04:35:00.000Z' }));
  const flipped = mergeBaseballObservation(same, observation({
    favorite: 'home', handicapOdds: { away: 1.8, home: 2.02 }, observedAt: '2026-10-04T04:40:00.000Z',
  }));

  assert.equal(same.history.length, 1);
  assert.equal(flipped.history.length, 2);
  assert.equal(flipped.favoriteFlipCount, 1);
  assert.deepEqual(flipped.favoriteTransitions[0], {
    at: '2026-10-04T04:40:00.000Z', from: 'away', to: 'home',
  });
});

test('partial MLB update preserves the last valid Stake.com 1.5 prices', () => {
  const first = mergeBaseballObservation(null, observation({
    league: 'MLB', officialId: 'MLB_20261004_CWS@CLE_0100',
    handicapOdds: { away: 1.77, home: 2.08 },
    sources: { direction: 'stake-official', handicapOdds: 'betexplorer-stake-row', total: 'stake-official' },
  }));
  const partial = mergeBaseballObservation(first, observation({
    league: 'MLB', officialId: 'MLB_20261004_CWS@CLE_0100',
    favorite: 'home', rawLine: 1, canonicalLine: 1.5,
    handicapOdds: null, partial: true, observedAt: '2026-10-04T04:40:00.000Z',
    sources: { direction: 'stake-official', handicapOdds: null, total: 'stake-official' },
  }));

  assert.deepEqual(partial.handicapOdds, { away: 1.77, home: 2.08 });
  assert.equal(partial.sources.handicapOdds, 'betexplorer-stake-row');
  assert.equal(partial.partial, true);
  assert.equal(partial.favorite, 'home');
});

test('partial market response preserves last valid favorite and line while updating total', () => {
  const first = mergeBaseballObservation(null, observation());
  const partial = mergeBaseballObservation(first, observation({
    favorite: null,
    rawLine: null,
    canonicalLine: null,
    handicapOdds: null,
    total: { line: 8.5, over: 1.88, under: 1.92 },
    partial: true,
    observedAt: '2026-10-04T04:40:00.000Z',
    sources: { direction: null, handicapOdds: null, total: 'stake-official' },
  }));

  assert.equal(partial.favorite, 'away');
  assert.equal(partial.rawLine, 1.5);
  assert.equal(partial.canonicalLine, 1.5);
  assert.deepEqual(partial.handicapOdds, { away: 1.92, home: 1.88 });
  assert.equal(partial.sources.direction, 'stake-official');
  assert.equal(partial.total.line, 8.5);
});

test('one failed league keeps prior matches while successful leagues continue updating', () => {
  const previous = {
    schemaVersion: 1,
    leagues: { CPBL: { status: 'ok', lastSuccessAt: '2026-10-03T00:00:00.000Z' } },
    matches: { old: observation({ league: 'CPBL', officialId: 'old' }) },
  };
  const feed = buildBaseballFeed(previous, scheduleRows(), {
    KBO: { observations: [observation()], error: null },
    CPBL: { observations: [], error: 'Stake HTTP 403' },
  }, '2026-10-04T04:30:00.000Z');

  assert.equal(feed.leagues.KBO.status, 'ok');
  assert.equal(feed.leagues.CPBL.status, 'partial');
  assert.ok(feed.matches.old);
  assert.ok(feed.matches['KBO_20261004_DOOSAN@SAMSUNG_1300']);
});

test('feed prunes matches more than seven days after start to keep the live file bounded', () => {
  const previous = {
    schemaVersion: 1,
    matches: {
      old: observation({ officialId: 'old', scheduledStart: '2026-09-20T05:00:00.000Z' }),
      recent: observation({ officialId: 'recent', scheduledStart: '2026-10-01T05:00:00.000Z' }),
    },
  };
  const feed = buildBaseballFeed(previous, [], {}, '2026-10-04T06:00:00.000Z');
  assert.equal(feed.matches.old, undefined);
  assert.ok(feed.matches.recent);
});
