'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  findGame,
  verdictFor,
  sourceLabel,
} = require('../baseball-bet365-integration.js');

const ROOT = path.resolve(__dirname, '..');

function officialGame(overrides = {}) {
  return {
    league: 'CPBL',
    officialId: 'CPBL_20261004_LIONS@BROTHERS_1705',
    scheduledStart: '2026-10-04T09:05:00.000Z',
    away: '統一',
    home: '兄弟',
    provider: 'bet365-official',
    observedAt: '2026-10-04T08:30:00.000Z',
    markets: {
      hd: {
        favorite: 'home', line: 1.5, away: 1.91, home: 1.83,
        provider: 'bet365-official', observedAt: '2026-10-04T08:30:00.000Z',
      },
    },
    events: [],
    history: [],
    ...overrides,
  };
}

test('finds CPBL official Bet365 odds before consulting the legacy BetExplorer integration', () => {
  const game = officialGame();
  const card = {
    officialId: game.officialId, league: 'cpbl',
    away: '統一獅', home: '中信兄弟', gameTime: '17:05',
  };
  assert.equal(findGame({ matches: { [game.officialId]: game } }, card, '2026-10-04'), game);
});

test('official handicap verdict reports the real source and ignores source-change as a flip', () => {
  const game = officialGame({
    events: [
      { at: '2026-10-04T08:10:00.000Z', type: 'source-change', from: 'betexplorer', to: 'bet365-official' },
    ],
  });
  const verdict = verdictFor(game);
  assert.equal(verdict.side, 'home');
  assert.equal(verdict.line, 1.5);
  assert.equal(verdict.flipEver, false);
  assert.equal(verdict.provider, 'bet365-official');
  assert.equal(sourceLabel(verdict.provider), 'BET365 官網');
});

test('same-provider favorite changes remain visible as Bet365 flip history', () => {
  const game = officialGame({
    events: [
      { at: '2026-10-04T08:20:00.000Z', type: 'favorite-flip', from: 'away', to: 'home' },
    ],
  });
  const verdict = verdictFor(game);
  assert.equal(verdict.flipEver, true);
  assert.deepEqual(verdict.struck, [
    { side: 'away', line: 1.5, at: '2026-10-04T08:20:00.000Z' },
  ]);
});

test('a fallback-only favorite flip is not reported as an official Bet365 flip after source recovery', () => {
  const game = officialGame({
    events: [
      {
        at: '2026-10-04T08:15:00.000Z', type: 'favorite-flip',
        provider: 'betexplorer', from: 'away', to: 'home', line: 1.5,
      },
      {
        at: '2026-10-04T08:25:00.000Z', type: 'source-change',
        from: 'betexplorer', to: 'bet365-official',
      },
    ],
  });

  const verdict = verdictFor(game);
  assert.equal(verdict.provider, 'bet365-official');
  assert.equal(verdict.flipEver, false);
  assert.deepEqual(verdict.struck, []);
});

test('fallback handicap is explicitly labeled BetExplorer backup', () => {
  const game = officialGame({
    provider: 'betexplorer',
    markets: {
      hd: {
        favorite: 'away', line: 1.5, away: 1.88, home: 1.9,
        provider: 'betexplorer', observedAt: '2026-10-04T08:25:00.000Z',
      },
    },
  });
  const verdict = verdictFor(game);
  assert.equal(verdict.side, 'away');
  assert.equal(verdict.provider, 'betexplorer');
  assert.equal(sourceLabel(verdict.provider), 'BetExplorer 備援');
});

function loadIntlVerdict(officialGameValue, legacyGame) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = html.indexOf('function intlVerdict(it, ist){');
  const end = html.indexOf('\nasync function loadIntlState()', start);
  assert.ok(start >= 0 && end > start, '找不到 intlVerdict 實作');
  const context = {
    doc: { activeDate: '2026-10-04' },
    window: {
      __baseballBet365Integration: {
        gameFor: () => officialGameValue,
        verdictFor,
        sourceLabel,
      },
      __oddsPortalIntegration: { gameFor: () => legacyGame },
    },
  };
  vm.runInNewContext(html.slice(start, end), context);
  return context.intlVerdict;
}

test('index international verdict uses the new official feed even when legacy BetExplorer has no match', () => {
  const verdict = loadIntlVerdict(officialGame(), null)(
    { officialId: 'CPBL_20261004_LIONS@BROTHERS_1705', away: '統一獅', home: '中信兄弟' },
    { is: null, il: null, ls: 'home', ll: 1.5, v: null },
  );
  assert.equal(verdict.side, 'home');
  assert.equal(verdict.line, 1.5);
  assert.equal(verdict.source, 'bet365-official');
  assert.equal(verdict.sourceLabel, 'BET365 官網');
});

test('index loads the versioned Bet365 baseball integration', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /baseball-bet365-integration\.js\?v=\d+/);
});
