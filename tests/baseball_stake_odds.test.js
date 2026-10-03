'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  flattenSchedule,
  parseStakeApiMarkets,
  parseStakeBaseballPage,
  collectBaseballStakeOdds,
} = require('../baseball_stake_odds.js');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-10-03T14:00:00.000Z');
const NPB_START = Date.parse('2026-10-04T09:00:00.000Z');

function fixture(name = 'Yokohama Dena Baystars - Hanshin Tigers', overrides = {}) {
  return {
    id: 'npb-1', slug: '46892736-yokohama-dena-baystars-hanshin-tigers',
    name, startTime: NPB_START, date: NPB_START, status: 'active', preMatchEnabled: true,
    ...overrides,
  };
}

function apiGroups() {
  return [{ name: 'main', markets: [
    [{ name: 'Winner (Incl. Extra Innings)', status: 'active', outcomes: [
      { name: 'Yokohama Dena Baystars', odds: 1.95, active: true },
      { name: 'Hanshin Tigers', odds: 1.79, active: true },
    ] }],
    [{ name: 'Total (Incl. Extra Innings)', status: 'active', specifiers: 'total=4.5', outcomes: [
      { name: 'Over 4.5', odds: 1.25, active: true },
      { name: 'Under 4.5', odds: 3.5, active: true },
    ] }],
    [{ name: 'Total (Incl. Extra Innings)', status: 'active', specifiers: 'total=7.5', outcomes: [
      { name: 'Over 7.5', odds: 1.89, active: true },
      { name: 'Under 7.5', odds: 1.79, active: true },
    ] }],
    [{ name: 'Handicap (Incl. Extra Innings)', status: 'active', specifiers: 'hcp=1.5', outcomes: [
      { name: 'Yokohama Dena Baystars (1.5)', odds: 1.52, active: true },
      { name: 'Hanshin Tigers (-1.5)', odds: 2.32, active: true },
    ] }],
    [{ name: 'Innings 1 to 5 - Winner', status: 'active', outcomes: [
      { name: 'Yokohama Dena Baystars', odds: 1.9 }, { name: 'Hanshin Tigers', odds: 1.8 },
    ] }],
  ] }];
}

function officialRows() {
  return [
    {
      league: 'NPB', officialId: 'NPB_20261004_Tigers@DeNA_1700', date: '2026-10-04', time: '17:00',
      awayTeam: '阪神', homeTeam: '橫濱', status: 'upcoming',
    },
    {
      league: 'KBO', officialId: 'KBO_20261004_DOOSAN@SAMSUNG_1300', date: '2026-10-04', time: '13:00',
      awayTeam: '斗山熊', homeTeam: '三星獅', status: 'upcoming',
    },
    {
      league: 'MLB', officialId: 'MLB_20261004_CWS@CLE_0100', date: '2026-10-04', time: '01:00',
      awayTeam: '白襪', homeTeam: '守護者', status: 'upcoming',
    },
    {
      league: 'MLB', officialId: 'MLB_20261004_NYY@TB_0630', date: '2026-10-04', time: '06:30',
      awayTeam: '洋基', homeTeam: '光芒', status: 'upcoming',
    },
  ];
}

test('flattens nested schedule buckets without duplicate fixtures', () => {
  const one = fixture();
  const result = flattenSchedule({ schedule: [{ fixtures: [one] }, { fixtures: [one] }] });
  assert.equal(result.length, 1);
  assert.equal(result[0].slug, one.slug);
});

test('parses official API nested main markets and ignores first-five-innings markets', () => {
  const markets = parseStakeApiMarkets(apiGroups(), fixture());
  assert.deepEqual(markets.ml, { away: 1.79, home: 1.95 });
  assert.deepEqual(markets.hd, { favorite: 'away', line: 1.5, away: 2.32, home: 1.52 });
  assert.deepEqual(markets.total, { line: 7.5, over: 1.89, under: 1.79 });
});

test('selects the balanced Stake main handicap instead of the first alternate run line', () => {
  const cleveland = fixture('Cleveland Guardians - Chicago White Sox');
  const groups = [{ name: 'main', markets: [[
    {
      name: 'Handicap (Incl. Extra Innings)', status: 'active', specifiers: 'hcp=1', outcomes: [
        { name: 'Cleveland Guardians (1)', odds: 1.44, active: true },
        { name: 'Chicago White Sox (-1)', odds: 2.8, active: true },
      ],
    },
    {
      name: 'Handicap (Incl. Extra Innings)', status: 'active', specifiers: 'hcp=-1', outcomes: [
        { name: 'Cleveland Guardians (-1)', odds: 1.98, active: true },
        { name: 'Chicago White Sox (1)', odds: 1.84, active: true },
      ],
    },
    {
      name: 'Handicap (Incl. Extra Innings)', status: 'active', specifiers: 'hcp=-1.5', outcomes: [
        { name: 'Cleveland Guardians (-1.5)', odds: 2.42, active: true },
        { name: 'Chicago White Sox (1.5)', odds: 1.57, active: true },
      ],
    },
  ]] }];

  assert.deepEqual(parseStakeApiMarkets(groups, cleveland).hd, {
    favorite: 'home', line: 1, away: 1.84, home: 1.98,
  });
});

test('parses the same three full-game markets from a Stake official event page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tests/fixtures/stake-baseball-event.html'), 'utf8');
  const markets = parseStakeBaseballPage(html, fixture());
  assert.deepEqual(markets.ml, { away: 1.79, home: 1.95 });
  assert.deepEqual(markets.hd, { favorite: 'away', line: 1.5, away: 2.32, home: 1.52 });
  assert.deepEqual(markets.total, { line: 7.5, over: 1.89, under: 1.79 });
});

test('uses odds-detail team names for MLB schedule placeholders while keeping leagues independent', async () => {
  const mlbScheduleFixture = fixture('Cleveland Guardians - AL 3/6', {
    slug: 'mlb-placeholder', startTime: Date.parse('2026-10-03T17:00:00Z'), date: Date.parse('2026-10-03T17:00:00Z'),
  });
  const mlbDetailFixture = fixture('Cleveland Guardians - Chicago White Sox', {
    slug: 'mlb-placeholder', startTime: Date.parse('2026-10-03T17:00:00Z'), date: Date.parse('2026-10-03T17:00:00Z'),
  });
  const raysPlaceholder = fixture('Tampa Bay Rays - AL 4/5', {
    slug: 'rays-placeholder', startTime: Date.parse('2026-10-03T22:30:00Z'), date: Date.parse('2026-10-03T22:30:00Z'),
  });
  const routes = {
    '/schedule/sport/baseball/japan/tournament/npb': { schedule: [{ fixtures: [fixture()] }] },
    [`/odds/${fixture().slug}`]: { fixture: fixture(), groups: apiGroups() },
    '/schedule/sport/baseball/usa/tournament/mlb': { schedule: [{ fixtures: [mlbScheduleFixture, raysPlaceholder] }] },
    '/odds/mlb-placeholder': { fixture: mlbDetailFixture, groups: [{ name: 'main', markets: [
      [{ name: 'Winner (Incl. Extra Innings)', status: 'active', outcomes: [
        { name: 'Cleveland Guardians', odds: 1.75 }, { name: 'Chicago White Sox', odds: 2.05 },
      ] }],
      [{ name: 'Handicap (Incl. Extra Innings)', status: 'active', specifiers: 'hcp=-1.5', outcomes: [
        { name: 'Cleveland Guardians (-1.5)', odds: 2.15 }, { name: 'Chicago White Sox (1.5)', odds: 1.62 },
      ] }],
      [{ name: 'Total (Incl. Extra Innings)', status: 'active', specifiers: 'total=8.5', outcomes: [
        { name: 'Over 8.5', odds: 1.9 }, { name: 'Under 8.5', odds: 1.9 },
      ] }],
    ] }] },
    '/odds/rays-placeholder': { fixture: raysPlaceholder, groups: [{ name: 'main', markets: [
      [{ name: 'Winner (Incl. Extra Innings)', status: 'active', outcomes: [
        { name: 'Tampa Bay Rays', odds: 2.2 }, { name: 'New York Yankees', odds: 1.65 },
      ] }],
      [{ name: 'Handicap (Incl. Extra Innings)', status: 'active', specifiers: 'hcp=1.5', outcomes: [
        { name: 'Tampa Bay Rays (1.5)', odds: 1.55 }, { name: 'New York Yankees (-1.5)', odds: 2.28 },
      ] }],
      [{ name: 'Total (Incl. Extra Innings)', status: 'active', specifiers: 'total=7.5', outcomes: [
        { name: 'Over 7.5', odds: 1.88 }, { name: 'Under 7.5', odds: 1.9 },
      ] }],
    ] }] },
    '/schedule/sport/baseball/republic-of-korea/tournament/kbo-league': new Error('KBO blocked'),
    '/schedule/sport/baseball/chinese-taipei/tournament/cpbl': { schedule: [] },
  };
  const request = async (route) => {
    const value = routes[route];
    if (value instanceof Error) throw value;
    if (!value) throw new Error(`unexpected route ${route}`);
    return value;
  };
  const feed = await collectBaseballStakeOdds({
    now: NOW, clock: () => NOW, request, fetchPage: async () => { throw new Error('page fallback must not run'); },
    officialRows: officialRows(), previous: { schemaVersion: 1, leagues: {}, matches: {} },
    betExplorer: { bookmaker: 'Stake.com', games: {} },
  });

  assert.ok(feed.matches['NPB_20261004_Tigers@DeNA_1700']);
  assert.equal(feed.matches['MLB_20261004_CWS@CLE_0100'].favorite, 'home');
  assert.equal(feed.matches['MLB_20261004_NYY@TB_0630'].favorite, 'away');
  assert.equal(feed.leagues.KBO.status, 'partial');
  assert.equal(feed.leagues.CPBL.status, 'ok');
});

test('uses the official page only when API markets are incomplete', async () => {
  let pageCalls = 0;
  const html = fs.readFileSync(path.join(ROOT, 'tests/fixtures/stake-baseball-event.html'), 'utf8');
  const request = async (route) => {
    if (route.includes('/schedule/')) return { schedule: [{ fixtures: [fixture()] }] };
    if (route.includes('/odds/')) return { fixture: fixture(), groups: [] };
    throw new Error(`unexpected route ${route}`);
  };
  const feed = await collectBaseballStakeOdds({
    leagues: ['NPB'], now: NOW, clock: () => NOW, request,
    fetchPage: async () => { pageCalls++; return html; },
    officialRows: officialRows(), previous: { matches: {} }, betExplorer: { bookmaker: 'Stake.com', games: {} },
  });

  assert.equal(pageCalls, 1);
  assert.equal(feed.matches['NPB_20261004_Tigers@DeNA_1700'].favorite, 'away');
});

test('keeps a partial API observation when official-page fallback is blocked', async () => {
  const onlyWinnerAndHandicap = apiGroups().map((group) => ({
    ...group,
    markets: group.markets.filter((entry) => !String(entry[0] && entry[0].name).startsWith('Total')),
  }));
  const request = async (route) => {
    if (route.includes('/schedule/')) return { schedule: [{ fixtures: [fixture()] }] };
    if (route.includes('/odds/')) return { fixture: fixture(), groups: onlyWinnerAndHandicap };
    throw new Error(`unexpected route ${route}`);
  };
  const feed = await collectBaseballStakeOdds({
    leagues: ['NPB'], now: NOW, clock: () => NOW, request,
    fetchPage: async () => { throw new Error('challenge page'); },
    officialRows: officialRows(), previous: { matches: {} }, betExplorer: { bookmaker: 'Stake.com', games: {} },
  });

  assert.equal(feed.matches['NPB_20261004_Tigers@DeNA_1700'].favorite, 'away');
  assert.equal(feed.matches['NPB_20261004_Tigers@DeNA_1700'].total, null);
  assert.equal(feed.matches['NPB_20261004_Tigers@DeNA_1700'].partial, true);
  assert.equal(feed.leagues.NPB.status, 'partial');
});

test('all league failures with no prior valid feed fail closed instead of producing an empty file', async () => {
  await assert.rejects(() => collectBaseballStakeOdds({
    now: NOW, clock: () => NOW, request: async () => { throw new Error('network down'); },
    fetchPage: async () => { throw new Error('network down'); }, officialRows: officialRows(), previous: null,
  }), /沒有任何有效聯盟資料/);
});
