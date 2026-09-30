'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findStakeGame,
  marketSnapshot,
  marketOutcome,
  applyOddsToPregame,
} = require('../nhl_stake_core.js');

function stakeGame(overrides = {}) {
  return {
    eventId: 'stake-1', league: 'nhl', date: '2026-10-01', startTime: '07:30',
    startISO: '2026-10-01T07:30:00+08:00', awayTeam: '企鵝', homeTeam: '飛人',
    sourceUrl: 'https://www.oddsportal.com/hockey/h2h/example/#stake-1',
    markets: {
      ml: {
        open: { at: '2026-09-30T08:00:00+08:00', away: 2.15, home: 1.75 },
        active: { at: '2026-10-01T00:30:00+08:00', away: 2.05, home: 1.82 },
      },
      hd: {
        open: { at: '2026-09-30T08:00:00+08:00', line: 1.5, favorite: 'away', away: 2.7, home: 1.45 },
        active: { at: '2026-10-01T00:30:00+08:00', line: 1.5, favorite: 'away', away: 2.55, home: 1.5 },
      },
      ou: {
        open: { at: '2026-09-30T08:00:00+08:00', line: 6.0, over: 1.95, under: 1.85 },
        active: { at: '2026-10-01T00:30:00+08:00', line: 6.5, over: 2.02, under: 1.8 },
      },
    },
    ...overrides,
  };
}

function bet365Match() {
  return {
    hd: {
      line: 2.5, favSide: 'home',
      outcomes: [
        { side: 'away', line: 2.5, odds: 1.5 },
        { side: 'home', line: -2.5, odds: 2.5 },
      ],
    },
    ml: { outcomes: [{ side: 'away', odds: 2.25 }, { side: 'home', odds: 1.65 }] },
  };
}

test('matches the exact NHL teams and nearest Taiwan start time', () => {
  const near = stakeGame();
  const far = stakeGame({ eventId: 'stake-2', date: '2026-10-02', startTime: '07:30', startISO: '2026-10-02T07:30:00+08:00' });
  const match = findStakeGame({ games: { near, far } }, {
    away: '企鵝', home: '飛人', date: '2026-10-01', time: '07:30',
  });

  assert.equal(match.game.eventId, 'stake-1');
  assert.equal(match.hd.favorite, 'away');
  assert.equal(match.ou.line, 6.5);
});

test('rejects a same-team Stake event outside the twelve-hour safety window', () => {
  const only = stakeGame({ date: '2026-10-03', startTime: '07:30', startISO: '2026-10-03T07:30:00+08:00' });
  assert.equal(findStakeGame({ games: { only } }, {
    away: '企鵝', home: '飛人', date: '2026-10-01', time: '07:30',
  }), null);
});

test('normalizes Stake active/open snapshots and decimal outcomes', () => {
  const game = stakeGame();
  const activeHd = marketSnapshot(game, 'hd');
  const openOu = marketSnapshot(game, 'ou', 'open');

  assert.equal(activeHd.line, 1.5);
  assert.equal(openOu.line, 6.0);
  assert.deepEqual(marketOutcome(activeHd, 'away'), { side: 'away', odds: 2.55, line: -1.5 });
  assert.deepEqual(marketOutcome(activeHd, 'home'), { side: 'home', odds: 1.5, line: 1.5 });
  assert.deepEqual(marketOutcome(marketSnapshot(game, 'ou'), 'over'), { side: 'over', odds: 2.02, line: 6.5 });
});

test('Stake handicap and total beat conflicting Bet365 values', () => {
  const stake = findStakeGame({ games: { one: stakeGame() } }, {
    away: '企鵝', home: '飛人', date: '2026-10-01', time: '07:30',
  });
  const applied = applyOddsToPregame(
    { hdFav: null, hdVal: null, hdSrc: '運彩' }, {}, stake, bet365Match(), 'home',
  );

  assert.equal(applied.hdFav, 'away');
  assert.equal(applied.hdVal, 1.5);
  assert.equal(applied.totLine, 6.5);
  assert.equal(applied.hdSrc, 'STAKE');
  assert.equal(applied.stake, stake);
  assert.equal(applied.bet365.hd.line, 2.5);
});

test('manual favorite remains above Stake while Stake keeps the automatic line', () => {
  const stake = findStakeGame({ games: { one: stakeGame() } }, {
    away: '企鵝', home: '飛人', date: '2026-10-01', time: '07:30',
  });
  const applied = applyOddsToPregame(
    { hdFav: null, hdVal: null, hdSrc: '運彩' }, { hdFavOverride: 'home' }, stake, bet365Match(), 'away',
  );

  assert.equal(applied.hdFav, 'home');
  assert.equal(applied.hdVal, 1.5);
  assert.equal(applied.hdSrc, 'STAKE');
});

test('Bet365 supplies only the missing Stake handicap market', () => {
  const noHandicap = stakeGame({ markets: {
    ml: stakeGame().markets.ml,
    ou: stakeGame().markets.ou,
  }});
  const stake = findStakeGame({ games: { one: noHandicap } }, {
    away: '企鵝', home: '飛人', date: '2026-10-01', time: '07:30',
  });
  const applied = applyOddsToPregame(
    { hdFav: null, hdVal: null, hdSrc: '運彩' }, {}, stake, bet365Match(), 'away',
  );

  assert.equal(applied.hdFav, 'home');
  assert.equal(applied.hdVal, 2.5);
  assert.equal(applied.hdSrc, 'BET365');
  assert.equal(applied.totLine, 6.5);
});

test('keeps the 6.5 default path available when neither feed has a total', () => {
  const applied = applyOddsToPregame(
    { hdFav: null, hdVal: null, hdSrc: '運彩' }, {}, null, null, 'home',
  );

  assert.equal(applied.hdVal, null);
  assert.equal(applied.totLine, null);
  assert.equal(applied.hdSrc, '運彩');
});
