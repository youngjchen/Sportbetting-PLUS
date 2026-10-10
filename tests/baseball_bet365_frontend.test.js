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
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

test('卡片表面只顯示 BET365，備援來源只留在三方監控明細', () => {
  const { JSDOM } = require('jsdom');
  const { renderMonitor } = require('../baseball-market-monitor.js');
  const dom = new JSDOM('<!doctype html><body></body>');
  const monitor = renderMonitor({
    documentRef: dom.window.document,
    card: { away: '統一獅', home: '中信兄弟' },
    bet365: { side: 'home', line: 1.5, providerLabel: 'BetExplorer 備援', events: [] },
  });
  dom.window.document.body.appendChild(monitor);
  assert.match(monitor.querySelector('.market-monitor-head').textContent, /BET365/);
  assert.doesNotMatch(monitor.querySelector('.market-monitor-head').textContent, /BetExplorer|備援/);
  monitor.querySelector('.market-monitor-head').click();
  assert.match(monitor.querySelector('.market-monitor-details').textContent, /BetExplorer 備援/);
});

// 2026-10-10：官網只有 MLB 抓得到；使用者在 BET365 官網親眼確認的讓分方優先順序最高，Titan 舊快照不得蓋過。
const { manualFeedFrom } = require('../baseball-bet365-integration.js');
const MANUAL = {
  matches: {
    'CPBL_20261010_BRO@UNI_1705': {
      league: 'CPBL', officialId: 'CPBL_20261010_BRO@UNI_1705', scheduledStart: '2026-10-10T09:05:00.000Z',
      away: '兄弟', home: '統一', side: 'home', line: 1.5, confirmedAt: '2026-10-10T11:50:00+08:00',
    },
    'BAD': { side: 'nobody', line: 1.5 },
  },
};

test('人工確認清單：用卡片找得到、讓分方照清單、來源標成人工確認；格式不對的列略過', () => {
  const feed = manualFeedFrom(MANUAL);
  assert.deepEqual(Object.keys(feed.matches), ['CPBL_20261010_BRO@UNI_1705']);
  const card = { officialId: 'CPBL_20261010_BRO@UNI_1705', league: 'cpbl', away: '中信兄弟', home: '統一獅', gameTime: '17:05' };
  const game = findGame(feed, card, '2026-10-10');
  const verdict = verdictFor(game);
  assert.equal(verdict.side, 'home');
  assert.equal(verdict.line, 1.5);
  assert.equal(verdict.flipEver, false);
  assert.equal(verdict.provider, 'bet365-manual');
  assert.equal(sourceLabel(verdict.provider), 'BET365 官網（人工確認）');
});

test('人工確認的讓分方不會被時間較新的 Titan 相反方向蓋掉', () => {
  const game = manualFeedFrom(MANUAL).matches['CPBL_20261010_BRO@UNI_1705'];
  const verdict = loadIntlVerdict(game, null)(
    { officialId: 'CPBL_20261010_BRO@UNI_1705', away: '中信兄弟', home: '統一獅' },
    { is: 'away', il: 1.5, sw: 0, ls: 'home', ll: 1.5, v: null, u: '2026-10-10T12:30:00+08:00' },
  );
  assert.equal(verdict.side, 'home');
  assert.equal(verdict.source, 'bet365-manual');
  assert.equal(verdict.v, null);   // 台彩也主讓、沒人換邊 → 不入顛倒／收斂
});

test('七類更正只改 10/4 阪神虎@橫濱DeNA 的錯值，改過不再動，其他場不碰', () => {
  const start = INDEX_SOURCE.indexOf('// ── 2026-10-10 七類更正');
  const end = INDEX_SOURCE.indexOf('  loadActiveBoard();', start);
  assert.ok(start >= 0 && end > start, '找不到七類更正程式');
  const wrong = () => ({ relation: '顛倒', bet365Side: 'away', taiwanSide: 'home', bet365Swapped: true, taiwanSwapped: true, swapCombo: 'both' });
  const games = [
    { league: 'npb', date: '2026-10-04', awayTeam: '阪神虎', homeTeam: '橫濱DeNA', bet365Taiwan: wrong() },
    { league: 'npb', date: '2026-10-05', awayTeam: '阪神虎', homeTeam: '橫濱DeNA', bet365Taiwan: wrong() },
  ];
  let saves = 0;
  const context = { doc: { games }, _loadBlocked: false, save: () => { saves++; }, console: { warn() {} } };
  const run = () => vm.runInNewContext(INDEX_SOURCE.slice(start, end), context);
  run();
  assert.equal(games[0].bet365Taiwan.relation, '收斂');
  assert.equal(games[0].bet365Taiwan.bet365Side, 'home');
  assert.equal(games[0].bet365Taiwan.swapCombo, 'both');
  assert.equal(games[1].bet365Taiwan.relation, '顛倒');      // 別天同對戰不碰
  assert.equal(saves, 1);
  run();
  assert.equal(saves, 1);                                    // 已更正 → 不再寫入
});

test('人工確認只知道讓分方時，BET365 顯示「未確認」而不是「未對調」，也不套用曾對調樣式', () => {
  const { JSDOM } = require('jsdom');
  const { renderMonitor } = require('../baseball-market-monitor.js');
  const feed = manualFeedFrom({ matches: { X: { ...MANUAL.matches['CPBL_20261010_BRO@UNI_1705'], swapKnown: false } } });
  const verdict = verdictFor(feed.matches.X);
  assert.equal(verdict.swapUnknown, true);
  assert.equal(verdict.flipEver, false);
  const dom = new JSDOM('<!doctype html><body></body>');
  const card = { away: '中信兄弟', home: '統一獅' };
  const monitor = renderMonitor({ documentRef: dom.window.document, card,
    bet365: { side: verdict.side, line: verdict.line, flipEver: false, swapUnknown: true, events: [], providerLabel: 'BET365 官網（人工確認）' } });
  const cell = monitor.querySelector('.market-platform.bet365');
  assert.match(cell.textContent, /統一獅讓1\.5/);
  assert.match(cell.querySelector('.market-state').textContent, /^未確認$/);
  assert.equal(cell.classList.contains('changed'), false);
  assert.match(monitor.querySelector('.market-monitor-details').textContent, /有沒有對調未確認/);
  const known = renderMonitor({ documentRef: dom.window.document, card,
    bet365: { side: 'home', line: 1.5, flipEver: false, events: [] } });
  assert.match(known.querySelector('.market-platform.bet365 .market-state').textContent, /^未對調$/);
});
