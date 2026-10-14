'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const S = require('../analyst_settle.js');
const Core = require('../analyst-core.js');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'analyst_settle_20261013.json'), 'utf8'));
const NOW = Date.parse('2026-10-14T08:00:00Z');
const schedule = () => Object.fromEntries(['NHL', 'MLB', 'NBA'].map((lg) => [lg, S.normalizeGames(lg, fx.pregame[lg])]));
const official = (overrides = {}) => async (league, g) => {
  if (league === 'NBA') return null;
  const hit = league === 'NHL' ? S.nhlOfficialFrom([fx.official.NHL], g) : S.mlbOfficialFrom([fx.official.MLB], g);
  return hit && overrides[g.officialId] ? { ...hit, ...overrides[g.officialId] } : hit;
};
const pick = (officialId, league, side, market = 'ML', line = 0, analyst = 'APE', layer = 'card') => ({
  analyst, officialId, league, layer, side, market, line, date: '2026-10-14', time: '06:00', away: 'x', home: 'y', updatedAt: '2026-10-13T20:00:00Z',
});
const PICKS = [
  pick('NHL_20261014_魔鬼@紅翼_0600', 'NHL', 'home', 'SPREAD', 1.5),
  pick('NHL_20261014_佛羅里@藍衣_0615', 'NHL', 'away'),
  pick('MLB_20261014_CLE@TB_0800', 'MLB', 'home'),
  pick('NBA_20261014_CLE@ORL', 'NBA', 'home', 'SPREAD', 6.5),
];

test('settles real 10/13 games: official check, phase and Stake closing odds', async () => {
  const { results, changed } = await S.settle({ picks: PICKS, results: { games: {} }, schedule: schedule(), stake: fx.stake, now: NOW, official: official() });
  assert.equal(changed, 4);
  const det = results.games['NHL_20261014_魔鬼@紅翼_0600'];
  assert.deepEqual([det.final, det.officialCheck, det.phase, det.awayScore, det.homeScore], [true, 'ok', 'regular', 5, 4]);
  assert.deepEqual(det.closing.spread, { line: 1.5, favorite: 'away', away: 3.05, home: 1.36 });
  const mlb = results.games['MLB_20261014_CLE@TB_0800'];
  assert.deepEqual([mlb.final, mlb.officialCheck, mlb.phase], [true, 'ok', 'postseason']);
  assert.deepEqual(mlb.closing.ml, { away: 2.13, home: 1.75 });
  const nba = results.games['NBA_20261014_CLE@ORL'];
  assert.deepEqual([nba.final, nba.officialCheck, nba.phase], [true, 'unavailable', 'preseason']);
  assert.ok(nba.closing && nba.closing.ml, 'NBA closing captured');

  const rows = Core.buildLedger(PICKS, results.games);
  const byId = Object.fromEntries(rows.map((r) => [r.officialId, r]));
  assert.deepEqual([byId['NHL_20261014_魔鬼@紅翼_0600'].result, byId['NHL_20261014_魔鬼@紅翼_0600'].odds], ['win', 1.36]);
  assert.deepEqual([byId['MLB_20261014_CLE@TB_0800'].result, byId['MLB_20261014_CLE@TB_0800'].profit], ['win', 0.75]);
  assert.equal(byId['NBA_20261014_CLE@ORL'].result, 'win');
  assert.equal(Core.filterRows(rows, {}).length, 3, 'preseason excluded by default');

  const again = await S.settle({ picks: PICKS, results, schedule: schedule(), stake: fx.stake, now: NOW, official: official() });
  assert.equal(again.changed, 0, 'idempotent');
});

test('official score mismatch blocks settlement and flags review', async () => {
  const { results } = await S.settle({ picks: PICKS.slice(0, 1), results: { games: {} }, schedule: schedule(), stake: fx.stake, now: NOW,
    official: official({ 'NHL_20261014_魔鬼@紅翼_0600': { homeScore: 5 } }) });
  const g = results.games['NHL_20261014_魔鬼@紅翼_0600'];
  assert.equal(g.final, false);
  assert.match(g.review, /official 5-5 vs feed 5-4/);
  assert.equal(Core.buildLedger(PICKS.slice(0, 1), results.games)[0].result, 'pending');
});

test('closing odds are only taken from prices observed before the start', async () => {
  const stake = JSON.parse(JSON.stringify(fx.stake));
  stake.MLB.matches['MLB_20261014_CLE@TB_0800'].observedAt = '2026-10-14T01:00:00Z';
  const { results } = await S.settle({ picks: [PICKS[2]], results: { games: {} }, schedule: schedule(), stake, now: NOW, official: official() });
  assert.equal(results.games['MLB_20261014_CLE@TB_0800'].closing, null);
});

test('game gone from the rolling feed is flagged after 3 days, not invented', async () => {
  const old = { ...pick('NHL_20261001_x@y_0700', 'NHL', 'away'), date: '2026-10-01', time: '07:00' };
  const { results } = await S.settle({ picks: [old], results: { games: {} }, schedule: schedule(), stake: fx.stake, now: NOW, official: official() });
  const g = results.games['NHL_20261001_x@y_0700'];
  assert.equal(g.final, undefined);
  assert.match(g.review, /賽程檔已無此場/);
});

test('serialize keeps one game per line and round-trips', () => {
  const text = S.serialize({ games: { b: { date: '2026-10-14', time: '08:00', final: true }, a: { date: '2026-10-14', time: '06:00' } } });
  assert.equal(text.split('\n').filter((l) => l.startsWith('"')).length, 2);
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc.games), ['a', 'b']);
});
