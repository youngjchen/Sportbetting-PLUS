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

// 2026-10-11：摘要的 markets 是 Stake.com 的盤（之前被誤當 BET365）→ BET365 備援只能用 bet365 欄
test('BetExplorer 備援只用真的 BET365 欄，絕不拿摘要裡 Stake.com 的 markets', () => {
  const fallback = betExplorerObservation({
    startISO: START,
    observedAt: '2026-10-04T08:30:00.000Z',
    bet365: { side: 'away', line: 1.5, odds: { home: 1.65, away: 2.15 }, observedAt: '2026-10-04T08:40:00.000Z' },
    markets: {   // Stake.com：讓分方相反、還有獨贏與大小 → 全部不可出現在 BET365
      ml: { close: { at: '2026-10-04T08:59:00.000Z', away: 2.3, home: 1.61, final: true } },
      hd: { close: { at: '2026-10-04T08:59:00.000Z', away: 1.86, home: 1.96, line: 1.5, favorite: 'home', final: true } },
      ou: { close: { at: '2026-10-04T08:59:00.000Z', over: 1.9, under: 1.92, line: 7.5, final: true } },
    },
  });
  assert.equal(fallback.provider, 'betexplorer-bet365');
  assert.equal(fallback.observedAt, '2026-10-04T08:40:00.000Z');
  assert.deepEqual(fallback.markets.hd, { favorite: 'away', line: 1.5, away: 2.15, home: 1.65, provider: 'betexplorer-bet365', observedAt: '2026-10-04T08:40:00.000Z' });
  assert.equal(fallback.markets.ml, undefined);
  assert.equal(fallback.markets.total, undefined);
  // 舊摘要沒有賠率：只有方向＋線也收
  assert.equal(betExplorerObservation({ startISO: START, observedAt: OBSERVED, bet365: { side: 'home', line: 1.5 } }).markets.hd.favorite, 'home');
  // 兩個方向同時開著＝方向不可信 → 不給，讓下一層來源接手
  assert.equal(betExplorerObservation({ startISO: START, observedAt: OBSERVED, bet365: { side: 'home', line: 1.5, ambiguous: true } }), null);
  // 沒有 bet365 欄（只有 Stake.com 的盤）→ 沒有 BET365 備援
  assert.equal(betExplorerObservation({ startISO: START, observedAt: OBSERVED, markets: { hd: { close: { line: 1.5, favorite: 'home', away: 2, home: 1.8 } } } }), null);
});

test('舊的「betexplorer」紀錄（其實是 Stake 的盤）會被清掉，官網紀錄保留', () => {
  const { purgeStakeMislabel } = require('../baseball_bet365_odds.js');
  const stakeOnly = { provider: 'betexplorer', markets: { hd: { provider: 'betexplorer' } },
    history: [{ provider: 'betexplorer', favorite: 'away' }, { provider: 'betexplorer', favorite: 'home' }],
    events: [{ type: 'favorite-flip', provider: 'betexplorer', from: 'away', to: 'home' }], favoriteFlipCount: 1 };
  assert.equal(purgeStakeMislabel(stakeOnly), null);
  const mixed = { provider: 'betexplorer', markets: { hd: { provider: 'betexplorer', favorite: 'home' } },
    history: [{ provider: 'bet365-official', favorite: 'away', markets: { hd: { favorite: 'away', line: 1.5, provider: 'bet365-official' } } },
      { provider: 'betexplorer', favorite: 'home' }],
    providerHistories: { 'bet365-official': [1], betexplorer: [2] },
    events: [{ type: 'source-change', from: 'bet365-official', to: 'betexplorer' }], favoriteFlipCount: 0 };
  const cleaned = purgeStakeMislabel(mixed);
  assert.equal(cleaned.provider, 'bet365-official');
  assert.equal(cleaned.favorite, 'away');
  assert.equal(cleaned.history.length, 1);
  assert.deepEqual(cleaned.events, []);
  assert.deepEqual(Object.keys(cleaned.providerHistories), ['bet365-official']);
  const clean = { provider: 'bet365-official', history: [{ provider: 'bet365-official' }], events: [] };
  assert.equal(purgeStakeMislabel(clean), clean);
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
    provider: 'betexplorer-bet365',
    from: 'home',
    to: 'away',
    line: 1.5,
    evidenceId: 'betexplorer-bet365:27mgd74D:bet365-favorite-flip:home:away',
  }]);
});
