'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let utils = {};
try { utils = require('../game-record-utils.js'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('same-day same-team doubleheader games have distinct identities', () => {
  assert.equal(typeof utils.gameIdentityKey, 'function', '尚未提供雙重賽安全鍵');
  const early = { league: 'mlb', date: '2026-09-24', awayTeam: '藍鳥', homeTeam: '金鶯', gameTime: '01:35' };
  const late = { league: 'mlb', date: '2026-09-24', awayTeam: '藍鳥', homeTeam: '金鶯', gameTime: '06:35' };
  assert.notEqual(utils.gameIdentityKey(early), utils.gameIdentityKey(late));
});

test('official id is the strongest settled-game identity', () => {
  assert.equal(
    utils.gameIdentityKey({ officialId: 'MLB_20260924_TOR@BAL_0135', gameTime: '06:35' }),
    'official:MLB_20260924_TOR@BAL_0135',
  );
});

test('missing settled history is recovered from both doubleheader cards without duplicating existing rows', () => {
  assert.equal(typeof utils.missingSettledCards, 'function', '尚未提供結算卡修復掃描');
  const doc = {
    games: [{ sid: 'late', league: 'mlb', date: '2026-09-24', awayTeam: '藍鳥', homeTeam: '金鶯', gameTime: '06:35' }],
    boards: { '2026-09-24': { items: [
      { type: 'match', away: '藍鳥', home: '金鶯', gameTime: '01:35', settled: { _sid: 'early' } },
      { type: 'match', away: '藍鳥', home: '金鶯', gameTime: '06:35', settled: { _sid: 'late' } },
    ] } },
  };

  const missing = utils.missingSettledCards(doc);
  assert.deepEqual(missing.map((row) => [row.date, row.item.gameTime, row.picks._sid]), [
    ['2026-09-24', '01:35', 'early'],
  ]);
});

test('different official ids remain different games even when fallback fields happen to match', () => {
  const doc = {
    games: [{ sid: 'one', officialId: 'MLB_GAME_ONE', league: 'mlb', date: '2026-09-24', awayTeam: 'A', homeTeam: 'B', gameTime: '01:00' }],
    boards: { '2026-09-24': { items: [
      { type: 'match', league: 'mlb', away: 'A', home: 'B', gameTime: '01:00', settled: { _sid: 'two', officialId: 'MLB_GAME_TWO' } },
    ] } },
  };
  assert.equal(utils.missingSettledCards(doc).length, 1);
});
