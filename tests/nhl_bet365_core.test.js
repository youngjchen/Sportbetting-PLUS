'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TEAM_ZH,
  translateTeam,
  stableGameKey,
  mergeBet365Game,
  findBet365Game,
} = require('../nhl_bet365_core.js');

const ALL_TEAMS = [
  ['ANA Ducks', '巨鴨'], ['BOS Bruins', '棕熊'], ['BUF Sabres', '軍刀'],
  ['CGY Flames', '火焰'], ['CAR Hurricanes', '颶風'], ['CHI Blackhawks', '黑鷹'],
  ['COL Avalanche', '雪崩'], ['CBJ Blue Jackets', '藍衣'], ['DAL Stars', '達拉斯'],
  ['DET Red Wings', '紅翼'], ['EDM Oilers', '油人'], ['FLA Panthers', '佛羅里'],
  ['LA Kings', '國王'], ['MIN Wild', '荒野'], ['MON Canadiens', '加拿大'],
  ['NAS Predators', '掠奪者'], ['NJ Devils', '魔鬼'], ['NY Islanders', '島人'],
  ['NY Rangers', '遊騎兵'], ['OTT Senators', '參議員'], ['PHI Flyers', '飛人'],
  ['PIT Penguins', '企鵝'], ['SJ Sharks', '鯊魚'], ['SEA Kraken', '海怪'],
  ['STL Blues', '藍調'], ['TB Lightning', '閃電'], ['TOR Maple Leafs', '楓葉'],
  ['UTA Mammoth', '猛瑪象'], ['VAN Canucks', '加人'], ['VGS Golden Knights', '騎士'],
  ['WAS Capitals', '首都'], ['WPG Jets', '噴射機'],
];

function sampleGame(overrides = {}) {
  return {
    startTime: Date.parse('2026-09-30T23:00:00Z'),
    away: 'FLA Panthers',
    home: 'CAR Hurricanes',
    awayZh: '佛羅里',
    homeZh: '颶風',
    ml: {
      market: 'Money Line',
      outcomes: [
        { name: 'FLA Panthers', side: 'away', odds: 2.05 },
        { name: 'CAR Hurricanes', side: 'home', odds: 1.72 },
      ],
    },
    hd: {
      market: 'Puck Line',
      line: 1.5,
      favSide: 'home',
      outcomes: [
        { name: 'FLA Panthers', side: 'away', line: 1.5, odds: 1.4 },
        { name: 'CAR Hurricanes', side: 'home', line: -1.5, odds: 2.85 },
      ],
    },
    ...overrides,
  };
}

test('translates every NHL club Bet365 can emit', () => {
  assert.equal(Object.keys(TEAM_ZH).length, 32);
  for (const [english, traditionalChinese] of ALL_TEAMS) {
    assert.equal(translateTeam(english), traditionalChinese, english);
  }
});

test('rejects an unknown NHL club instead of attaching odds to the wrong card', () => {
  assert.throws(() => translateTeam('Unknown Club'), /未知 NHL 隊名/);
});

test('builds the same key for repeated observations of one matchup', () => {
  const game = sampleGame();
  assert.equal(
    stableGameKey(game),
    '1790809200000|FLA Panthers|CAR Hurricanes',
  );
});

test('does not add history when the markets are unchanged', () => {
  const first = mergeBet365Game(null, sampleGame(), '2026-09-30T00:00:00.000Z');
  const second = mergeBet365Game(first, sampleGame(), '2026-09-30T00:05:00.000Z');
  assert.equal(second.history.length, 1);
  assert.equal(second.history[0].at, '2026-09-30T00:00:00.000Z');
});

test('prepends price changes and records a puck-line favorite flip', () => {
  const first = mergeBet365Game(null, sampleGame(), '2026-09-30T00:00:00.000Z');
  const flipped = sampleGame({
    hd: {
      market: 'Puck Line', line: 1.5, favSide: 'away',
      outcomes: [
        { name: 'FLA Panthers', side: 'away', line: -1.5, odds: 2.8 },
        { name: 'CAR Hurricanes', side: 'home', line: 1.5, odds: 1.42 },
      ],
    },
  });
  const second = mergeBet365Game(first, flipped, '2026-09-30T00:05:00.000Z');

  assert.equal(second.history.length, 2);
  assert.equal(second.history[0].hd.favSide, 'away');
  assert.deepEqual(second.events[0], {
    at: '2026-09-30T00:05:00.000Z',
    type: 'favorite-flip',
    from: 'home',
    to: 'away',
  });
});

test('matches a pregame card by translated teams and nearest start time', () => {
  const near = mergeBet365Game(null, sampleGame(), '2026-09-30T00:00:00.000Z');
  const far = mergeBet365Game(null, sampleGame({ startTime: Date.parse('2026-10-02T23:00:00Z') }), '2026-09-30T00:00:00.000Z');
  const feed = { games: { near, far } };

  const match = findBet365Game(feed, {
    away: '佛羅里', home: '颶風', date: '2026-10-01', time: '07:00',
  });

  assert.equal(match.game.startTime, near.startTime);
  assert.equal(match.hd.favSide, 'home');
  assert.deepEqual(match.ml.outcomes.map((outcome) => outcome.odds), [2.05, 1.72]);
});

test('does not match a same-team event outside the twelve-hour window', () => {
  const feed = { games: { only: mergeBet365Game(null, sampleGame(), '2026-09-30T00:00:00.000Z') } };
  const match = findBet365Game(feed, {
    away: '佛羅里', home: '颶風', date: '2026-10-02', time: '07:01',
  });
  assert.equal(match, null);
});
