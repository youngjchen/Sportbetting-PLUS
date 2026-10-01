'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  parseStakeOfficialPage,
  selectFixtures,
  collectStakeOdds,
} = require('../stake_api_odds.js');
const { mergeStakeGame } = require('../nhl_core.js');
const { findStakeGame } = require('../nhl_stake_core.js');

const EVENT_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'stake-nhl-event.html'),
  'utf8',
);

const FUTURE = Date.parse('2026-10-02T00:00:00Z');
const NOW = Date.parse('2026-10-01T00:00:00Z');

test('pregame selector rejects fixtures exactly at or before the observation time', () => {
  const selected = selectFixtures([
    { slug: 'past', date: NOW - 1, status: 'active', preMatchEnabled: true },
    { slug: 'live', date: NOW, status: 'active', preMatchEnabled: true },
    { slug: 'future', date: NOW + 1, status: 'active', preMatchEnabled: true },
  ], NOW, 0, 96, 60);

  assert.deepEqual(selected.map((fixture) => fixture.slug), ['future']);
});

test('Stake official page treats its fixture title as home-away and selects the main lines', () => {
  const markets = parseStakeOfficialPage(EVENT_HTML, {
    name: 'New York Rangers - Tampa Bay Lightning',
  });

  assert.deepEqual(markets.ml.outcomes, [
    { name: 'Tampa Bay Lightning', side: 'away', odds: 1.68 },
    { name: 'New York Rangers', side: 'home', odds: 2.11 },
  ]);
  assert.equal(markets.hd.line, 1.5);
  assert.equal(markets.hd.favSide, 'away');
  assert.deepEqual(markets.hd.outcomes.map((outcome) => [outcome.side, outcome.line, outcome.odds]), [
    ['away', -1.5, 2.6],
    ['home', 1.5, 1.45],
  ]);
  assert.equal(markets.tot.line, 6);
  assert.deepEqual(markets.tot.outcomes, [
    { name: 'Over', side: 'over', line: 6, odds: 1.93 },
    { name: 'Under', side: 'under', line: 6, odds: 1.81 },
  ]);
});

test('collector uses the official event page without an API key and preserves started games', async () => {
  const previousStarted = {
    slug: 'started-game',
    startTime: NOW - 3600000,
    markets: { ml: { active: { away: 2.2, home: 1.62 } } },
    history: [{ at: '2026-09-30T22:00:00.000Z' }],
  };
  const schedule = {
    schedule: [{ fixtures: [
      { slug: 'started-game', name: 'Pittsburgh Penguins - Philadelphia Flyers', date: NOW - 3600000, status: 'active', preMatchEnabled: true },
      { slug: 'future-game', name: 'New York Rangers - Tampa Bay Lightning', date: FUTURE, status: 'active', preMatchEnabled: true },
    ] }],
  };
  const output = await collectStakeOdds({
    apiKey: '',
    now: NOW,
    previous: { games: { 'started-game': previousStarted } },
    request: async (endpoint) => {
      if (endpoint.includes('/schedule/')) return schedule;
      throw new Error(`odds API should not be required without a key: ${endpoint}`);
    },
    fetchPage: async () => EVENT_HTML,
  });

  assert.deepEqual(output.games['started-game'], previousStarted);
  const future = output.games['future-game'];
  assert.equal(output.provider, 'stake-official');
  assert.equal(output.mode, 'official-page');
  assert.equal(future.awayTeam, '閃電');
  assert.equal(future.homeTeam, '遊騎兵');
  assert.equal(future.markets.ml.active.away, 1.68);
  assert.equal(future.markets.hd.active.favorite, 'away');
  assert.equal(future.markets.ou.active.line, 6);
  assert.ok(Date.parse(future.lastPregameAt) < future.startTime);
  assert.ok(findStakeGame(output, {
    date: '2026-10-02', time: '08:00', away: '閃電', home: '遊騎兵',
  }));
});

test('collector supplements an incomplete official API response from the official event page', async () => {
  const schedule = {
    schedule: [{ fixtures: [
      { slug: 'future-game', name: 'New York Rangers - Tampa Bay Lightning', date: FUTURE, status: 'active', preMatchEnabled: true },
    ] }],
  };
  const output = await collectStakeOdds({
    apiKey: 'test-key',
    now: NOW,
    previous: { games: {} },
    request: async (endpoint) => {
      if (endpoint.includes('/schedule/')) return schedule;
      return {
        fixture: {
          slug: 'future-game',
          name: 'New York Rangers - Tampa Bay Lightning',
          date: FUTURE,
          groups: [{ markets: [{
            name: 'Match Winner Two Way (Incl. Overtime and Penalties)',
            status: 'active',
            outcomes: [
              { name: 'New York Rangers', odds: 2.2, active: true },
              { name: 'Tampa Bay Lightning', odds: 1.64, active: true },
            ],
          }] }],
        },
      };
    },
    fetchPage: async () => EVENT_HTML,
  });

  assert.equal(output.mode, 'hybrid');
  assert.equal(output.health.apiSucceeded, 1);
  assert.equal(output.health.pageSucceeded, 1);
  assert.equal(output.games['future-game'].markets.ml.active.away, 1.64);
  assert.equal(output.games['future-game'].markets.ml.active.home, 2.2);
  assert.equal(output.games['future-game'].markets.hd.active.line, 1.5);
  assert.equal(output.games['future-game'].markets.ou.active.line, 6);
});

test('collector repairs previously stored reversed sides without inventing a favorite flip', async () => {
  const previous = {
    slug: 'future-game',
    name: 'New York Rangers - Tampa Bay Lightning',
    startTime: FUTURE,
    awayName: 'New York Rangers',
    homeName: 'Tampa Bay Lightning',
    awayTeam: '遊騎兵',
    homeTeam: '閃電',
    ml: {
      market: 'Winner (Incl. Overtime and Penalties)',
      outcomes: [
        { name: 'New York Rangers', side: 'away', odds: 2.15 },
        { name: 'Tampa Bay Lightning', side: 'home', odds: 1.7 },
      ],
    },
    hd: {
      market: 'Handicap (Incl. Overtime and Penalties)',
      line: 1.5,
      favSide: 'home',
      outcomes: [
        { name: 'New York Rangers', side: 'away', line: 1.5, odds: 1.45 },
        { name: 'Tampa Bay Lightning', side: 'home', line: -1.5, odds: 2.6 },
      ],
    },
    history: [{
      at: '2026-09-30T20:00:00.000Z',
      ml: {
        market: 'Winner (Incl. Overtime and Penalties)',
        outcomes: [
          { name: 'New York Rangers', side: 'away', odds: 2.15 },
          { name: 'Tampa Bay Lightning', side: 'home', odds: 1.7 },
        ],
      },
      hd: {
        market: 'Handicap (Incl. Overtime and Penalties)',
        line: 1.5,
        favSide: 'home',
        outcomes: [
          { name: 'New York Rangers', side: 'away', line: 1.5, odds: 1.45 },
          { name: 'Tampa Bay Lightning', side: 'home', line: -1.5, odds: 2.6 },
        ],
      },
    }],
    events: [],
  };
  const schedule = { schedule: [{ fixtures: [{
    slug: 'future-game',
    name: 'New York Rangers - Tampa Bay Lightning',
    date: FUTURE,
    status: 'active',
    preMatchEnabled: true,
  }] }] };

  const output = await collectStakeOdds({
    apiKey: '',
    now: NOW,
    previous: { games: { 'future-game': previous } },
    request: async () => schedule,
    fetchPage: async () => EVENT_HTML,
  });
  const game = output.games['future-game'];

  assert.equal(game.awayTeam, '閃電');
  assert.equal(game.homeTeam, '遊騎兵');
  assert.deepEqual(game.markets.ml.open, {
    at: '2026-09-30T20:00:00.000Z', away: 1.7, home: 2.15,
  });
  assert.equal(game.markets.hd.open.favorite, 'away');
  assert.equal(game.events.some((event) => event.type === 'favorite-flip'), false);
});

test('handicap price movement cannot create a favorite flip while the negative line stays on one team', () => {
  const first = {
    slug: 'same-favorite',
    hd: {
      line: 1.5,
      favSide: 'home',
      outcomes: [
        { name: 'Away', side: 'away', line: 1.5, odds: 1.45 },
        { name: 'Home', side: 'home', line: -1.5, odds: 2.6 },
      ],
    },
  };
  const second = {
    ...first,
    hd: {
      ...first.hd,
      outcomes: [
        { name: 'Away', side: 'away', line: 1.5, odds: 1.9 },
        { name: 'Home', side: 'home', line: -1.5, odds: 1.8 },
      ],
    },
  };
  const before = mergeStakeGame(null, first, '2026-10-01T00:00:00.000Z');
  const after = mergeStakeGame(before, second, '2026-10-01T00:05:00.000Z');

  assert.equal(after.events.some((event) => event.type === 'favorite-flip'), false);
});
