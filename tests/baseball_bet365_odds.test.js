'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseBet365BaseballPage,
  translateBaseballTeam,
  betExplorerObservation,
  resolveBaseballGame,
  collectBaseballBet365Odds,
} = require('../baseball_bet365_odds.js');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'bet365-baseball-markets.html'), 'utf8');
const START = '2026-10-04T09:05:00.000Z';
const OBSERVED = '2026-10-04T08:00:00.000Z';

test('combines three official fixture ids by teams and start time', () => {
  const games = parseBet365BaseballPage(FIXTURE);
  assert.equal(games.length, 1);
  assert.equal(games[0].league, 'CPBL');
  assert.equal(games[0].away, '兄弟');
  assert.equal(games[0].home, '味全');
  assert.deepEqual(games[0].fixtureIds, { ml: 'cpbl-ml', hd: 'cpbl-hd', total: 'cpbl-ou' });
  assert.deepEqual(games[0].markets.hd, {
    favorite: 'home',
    line: 1.5,
    away: 1.84,
    home: 1.98,
  });
  assert.deepEqual(games[0].markets.total, { line: 7.5, over: 1.95, under: 1.87 });
});

test('translates all four baseball league naming families', () => {
  assert.equal(translateBaseballTeam('MLB', 'LA Dodgers'), '道奇');
  assert.equal(translateBaseballTeam('NPB', 'Yokohama DeNA BayStars'), '橫濱');
  assert.equal(translateBaseballTeam('KBO', 'Hanwha Eagles'), '華老鷹');
  assert.equal(translateBaseballTeam('CPBL', 'CTBC Brothers'), '兄弟');
});

test('BetExplorer adapter chooses the last valid pregame snapshot', () => {
  const fallback = betExplorerObservation({
    startISO: START,
    observedAt: '2026-10-04T10:00:00.000Z',
    bet365: { side: 'home', line: 1.5 },
    markets: {
      ml: { close: { at: '2026-10-04T08:59:00.000Z', away: 2.3, home: 1.61, final: true } },
      hd: { close: { at: '2026-10-04T08:59:00.000Z', away: 1.86, home: 1.96, line: 1.5, favorite: 'home', final: true } },
      ou: { close: { at: '2026-10-04T08:59:00.000Z', over: 1.9, under: 1.92, line: 7.5, final: true } },
    },
  });

  assert.equal(fallback.provider, 'betexplorer');
  assert.equal(fallback.observedAt, '2026-10-04T08:59:00.000Z');
  assert.equal(fallback.markets.hd.favorite, 'home');
  assert.equal(fallback.markets.total.line, 7.5);
});

test('official markets win while fallback fills only a missing market', () => {
  const official = {
    provider: 'bet365-official',
    observedAt: OBSERVED,
    markets: { ml: { away: 2.2, home: 1.66 } },
  };
  const fallback = {
    provider: 'betexplorer',
    observedAt: OBSERVED,
    markets: {
      ml: { away: 2.3, home: 1.61 },
      hd: { favorite: 'home', line: 1.5, away: 1.86, home: 1.96 },
    },
  };
  const resolved = resolveBaseballGame(official, fallback, null);

  assert.equal(resolved.markets.ml.provider, 'bet365-official');
  assert.equal(resolved.markets.hd.provider, 'betexplorer');
  assert.equal(resolved.favorite, 'home');
});

test('collector matches CPBL official odds without requiring a BetExplorer row', async () => {
  const output = await collectBaseballBet365Odds({
    now: Date.parse(OBSERVED),
    officialRows: [{
      league: 'CPBL',
      officialId: 'CPBL_20261004_Brothers@Dragons_1705',
      date: '2026-10-04',
      time: '17:05',
      awayTeam: '兄弟',
      homeTeam: '味全',
      status: 'upcoming',
    }],
    previous: { matches: {}, leagues: {} },
    betExplorer: { games: {} },
    fetchPages: async () => [{ league: 'CPBL', html: FIXTURE }],
  });

  const game = output.matches['CPBL_20261004_Brothers@Dragons_1705'];
  assert.equal(output.leagues.CPBL.status, 'ok');
  assert.equal(game.provider, 'bet365-official');
  assert.equal(game.markets.hd.provider, 'bet365-official');
  assert.equal(game.markets.total.line, 7.5);
});

test('collector imports BetExplorer Bet365 flip evidence even when only the active line is sampled', async () => {
  const officialId = 'NPB_20261004_Tigers@DeNA_1700';
  const output = await collectBaseballBet365Odds({
    now: Date.parse('2026-10-04T08:00:00.000Z'),
    officialRows: [{
      league: 'NPB',
      officialId,
      date: '2026-10-04',
      time: '17:00',
      awayTeam: '阪神',
      homeTeam: '橫濱',
      status: 'upcoming',
    }],
    previous: { matches: {}, leagues: {} },
    betExplorer: {
      games: {
        target: {
          eventId: '27mgd74D',
          league: 'npb',
          date: '2026-10-04',
          startTime: '17:00',
          startISO: '2026-10-04T17:00:00+08:00',
          awayTeam: '阪神',
          homeTeam: '橫濱',
          bet365: {
            side: 'away',
            line: 1.5,
            at: '2026-10-04T11:16:00+08:00',
            flipEver: true,
            struck: [{ side: 'home', line: -1.5, at: '2026-08-22T11:53:00+08:00' }],
          },
          markets: {
            hd: {
              active: {
                at: '2026-10-04T15:30:05+08:00',
                away: 2.55,
                home: 1.43,
                line: 1.5,
                favorite: 'away',
              },
            },
          },
        },
      },
    },
    fetchPages: async () => [],
  });

  const game = output.matches[officialId];
  assert.equal(game.favoriteFlipCount, 1);
  assert.deepEqual(game.events, [{
    at: '2026-10-04T03:16:00.000Z',
    type: 'favorite-flip',
    provider: 'betexplorer',
    from: 'home',
    to: 'away',
    line: 1.5,
    evidenceId: 'betexplorer:27mgd74D:bet365-favorite-flip:home:away',
  }]);
});
