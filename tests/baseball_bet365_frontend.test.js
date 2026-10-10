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

// ===== 2026-10-10 BET365 手動調整：點隊名換邊、點圓圈標對調 =====
function loadManualHelpers(extra = {}) {
  const start = INDEX_SOURCE.indexOf('// ===== BET365 手動調整（2026-10-10 使用者規格）=====');
  const end = INDEX_SOURCE.indexOf('\nasync function loadIntlState()', start);
  assert.ok(start >= 0 && end > start, '找不到 BET365 手動調整程式');
  const context = {
    doc: { activeDate: '2026-10-10', games: extra.games || [] },
    bumpGamesVersion() {},
    window: {
      __baseballBet365Integration: { gameFor: () => extra.feedGame || null, verdictFor, sourceLabel },
      __oddsPortalIntegration: { gameFor: () => null },
    },
  };
  vm.runInNewContext(`${INDEX_SOURCE.slice(start, end)}\nthis.api = { bet365ManualOf, bet365TaiwanWithManual, syncSettledBet365Manual, intlVerdict };`, context);
  return context.api;
}

test('手動讓分方與對調優先於所有自動來源；手動「沒對調」時 Titan 的舊換邊不算', () => {
  const { intlVerdict } = loadManualHelpers({ feedGame: officialGame({ provider: 'betexplorer', markets: { hd: {
    favorite: 'away', line: 1.5, away: 2.5, home: 1.5, provider: 'betexplorer', observedAt: '2026-10-10T03:00:00.000Z' } } }) });
  const titan = { is: 'away', il: 1.5, sw: 2, ls: 'home', ll: 1.5, lsw: 0, v: 'was', u: '2026-10-10T12:30:00+08:00' };
  const auto = intlVerdict({ away: '統一獅', home: '中信兄弟' }, titan);
  assert.equal(auto.v, 'flip');                                  // 自動：客讓 vs 台彩主讓 → 顛倒
  const manualSide = intlVerdict({ away: '統一獅', home: '中信兄弟', bet365ManualSide: 'home' }, titan);
  assert.equal(manualSide.side, 'home');
  assert.equal(manualSide.source, 'bet365-card-manual');
  assert.equal(manualSide.v, 'was');                             // 同邊，沒手標對調 → 沿用 Titan 證據 → 收斂
  const noSwap = intlVerdict({ away: '統一獅', home: '中信兄弟', bet365ManualSide: 'home', bet365ManualSwap: false }, titan);
  assert.equal(noSwap.v, null);                                  // 手動說沒對調、台彩也沒換 → 不入七類
  const swapped = intlVerdict({ away: '統一獅', home: '中信兄弟', bet365ManualSide: 'home', bet365ManualSwap: true }, titan);
  assert.equal(swapped.v, 'was');
  assert.equal(swapped.be.flipEver, true);
});

test('手動值改寫七類：同邊沒對調不入七類、有對調收斂、不同邊顛倒', () => {
  const { bet365TaiwanWithManual } = loadManualHelpers();
  const ist = { ls: 'home', ll: 1.5, lsw: 0, il: 1.5 };
  assert.equal(bet365TaiwanWithManual(null, { side: 'home', swap: false }, ist), null);
  const was = bet365TaiwanWithManual(null, { side: 'home', swap: true }, ist);
  assert.deepEqual([was.relation, was.swapCombo, was.bet365SwitchCount, was.evidenceSource], ['收斂', 'bet365_only', 1, 'manual+playsport']);
  const flip = bet365TaiwanWithManual({ relation: '收斂', swapCombo: 'taiwan_only', bet365Side: 'home', taiwanSide: 'home', taiwanSwapped: true, bet365Swapped: false },
    { side: 'away', swap: null }, ist);
  assert.deepEqual([flip.relation, flip.swapCombo, flip.bet365Side], ['顛倒', 'taiwan_only', 'away']);
});

test('已結算的卡片手動調整會同步改寫歷史紀錄，按恢復自動判斷原樣還原', () => {
  const original = { relation: '顛倒', swapCombo: 'neither', bet365Side: 'away', taiwanSide: 'home', bet365Swapped: false, taiwanSwapped: false };
  const rec = { sid: 's1', intlState: { ls: 'home', lsw: 0 }, bet365Taiwan: JSON.parse(JSON.stringify(original)) };
  const { syncSettledBet365Manual } = loadManualHelpers({ games: [rec] });
  const it = { away: '統一獅', home: '中信兄弟', settled: { _sid: 's1', intlState: { ls: 'home', lsw: 0 }, bet365Taiwan: JSON.parse(JSON.stringify(original)) } };
  it.bet365ManualSide = 'home'; it.bet365ManualSwap = true;
  syncSettledBet365Manual(it);
  assert.equal(rec.bet365Taiwan.relation, '收斂');
  assert.equal(it.settled.bet365Taiwan.swapCombo, 'bet365_only');
  assert.equal(rec.bet365TaiwanAuto.relation, '顛倒');
  delete it.bet365ManualSide; delete it.bet365ManualSwap;
  syncSettledBet365Manual(it);
  assert.equal(JSON.stringify(rec.bet365Taiwan), JSON.stringify(original));
  assert.equal('bet365TaiwanAuto' in rec, false);
});

test('監控列：點 BET365 隊名換成另一隊、點圓圈切換對調，都不會展開明細；手動時有恢復按鈕', () => {
  const { JSDOM } = require('jsdom');
  const { renderMonitor } = require('../baseball-market-monitor.js');
  const dom = new JSDOM('<!doctype html><body></body>');
  const calls = [];
  const monitor = renderMonitor({ documentRef: dom.window.document, card: { away: '中信兄弟', home: '統一獅' },
    bet365: { side: 'away', line: 1.5, flipEver: false, events: [] },
    bet365Manual: true, bet365ManualSwap: true,
    onBet365Side: (s) => calls.push(['side', s]), onBet365Swap: (v) => calls.push(['swap', v]), onBet365Restore: () => calls.push(['restore']) });
  dom.window.document.body.appendChild(monitor);
  const cell = monitor.querySelector('.market-platform.bet365');
  assert.equal(cell.classList.contains('changed'), true);          // 手動亮＝曾對調
  assert.match(cell.querySelector('.market-state').textContent, /^曾對調$/);
  cell.querySelector('.market-current').click();
  cell.querySelector('.market-source').click();
  monitor.querySelector('.market-detail-section.bet365 .market-auto-controls button').click();
  assert.deepEqual(calls, [['side', 'home'], ['swap', false], ['restore']]);
  assert.equal(monitor.querySelector('.market-monitor-details').hidden, true);   // 點隊名／圓圈不展開明細
});
