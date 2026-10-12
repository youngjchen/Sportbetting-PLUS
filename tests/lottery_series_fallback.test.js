'use strict';

// 2026-10-12：intl_state 沒有的場（Titan 沒收），台彩側要從 lottery_series 算換邊，不可寫死 0。
// 實例：美職 道奇@釀酒人 台彩 釀酒人讓→道奇讓，被記成七類「收斂／只有 BET365 對調」。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(from, to) {
  const start = INDEX_SOURCE.indexOf(from);
  const end = INDEX_SOURCE.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `找不到 ${from}`);
  return INDEX_SOURCE.slice(start, end);
}

const SERIES = {
  games: {
    MLB_20261012_LAD_MIL_0800: {
      league: 'MLB', date: '2026-10-12', awayTeam: '道奇', homeTeam: '釀酒人',
      pts: [
        { t: '2026-10-10T16:12:00.000Z', side: 'home', line: 1.5 },
        { t: '2026-10-11T23:21:00.000Z', side: 'away', line: 1.5 },
        { t: '2026-10-12T00:30:00.000Z', side: 'home', line: 1.5 },   // 開賽（08:00）後的點：不算
      ],
    },
  },
};

function loadIntlFor({ series = SERIES, pregame } = {}) {
  const row = pregame || { date: '2026-10-12', awayTeam: '道奇', homeTeam: '釀酒人',
    lotteryHandicap: { src: '運彩', favSide: 'away', line: 1.5 } };
  const sandbox = {
    __intl: { games: {} },
    __lotSer: series,
    doc: { activeDate: '2026-10-12' },
    leagueOf: () => 'mlb',
    intlArchFor: () => null,
    window: { __psFusion: { getData: () => [row], findGame: () => row } },
  };
  const code = slice('function intlFor(it,dateKey)', 'function intlVerdictColor') +
    slice('function lotterySeriesState(', 'async function loadLotterySeries') +
    '\nthis.intlFor = intlFor;';
  vm.runInNewContext(code, sandbox);
  return sandbox.intlFor;
}

const CARD = { type: 'match', away: '道奇', home: '釀酒人', league: 'mlb', gameTime: '08:00' };

test('intl_state 沒有這場時，台彩方向、換邊數與軌跡從 lottery_series 算（只看開賽前）', () => {
  const ist = loadIntlFor()(CARD, '2026-10-12');
  assert.equal(ist.ls, 'away');
  assert.equal(ist.ll, 1.5);
  assert.equal(ist.lsw, 1);
  assert.equal(ist.ltr, '00:12 釀酒人 → 07:21 道奇');
  assert.equal(ist.lsLive, true);
});

test('沒有序列時仍退回賽前快照（單點、換邊數 0）', () => {
  const ist = loadIntlFor({ series: { games: {} } })(CARD, '2026-10-12');
  assert.equal(ist.ls, 'away');
  assert.equal(ist.lsw, 0);
  assert.equal(ist.lsLive, false);
});

test('雙重賽：取開球時間最近的那一場序列', () => {
  const series = { games: {
    MLB_20261012_LAD_MIL_0800: SERIES.games.MLB_20261012_LAD_MIL_0800,
    MLB_20261012_LAD_MIL_1400: { league: 'MLB', date: '2026-10-12', awayTeam: '道奇', homeTeam: '釀酒人',
      pts: [{ t: '2026-10-12T03:00:00.000Z', side: 'home', line: 1.5 }] },
  } };
  const ist = loadIntlFor({ series })({ ...CARD, gameTime: '14:05' }, '2026-10-12');
  assert.equal(ist.ls, 'home');
  assert.equal(ist.lsw, 0);
});

test('七類更正只改 10/12 道奇@釀酒人 仍是錯值的紀錄、結算副本與自動快照，改過不再動', () => {
  const code = slice('// ── 2026-10-12 七類更正', '  loadActiveBoard();');
  const wrong = () => ({ relation: '收斂', swapCombo: 'bet365_only', bet365Swapped: true, taiwanSwapped: false,
    bet365Side: 'away', taiwanSide: 'away', taiwanSwitchCount: 0 });
  const state = () => ({ ls: 'away', ll: 1.5, lsw: 0, ltr: null });
  const games = [
    { league: 'mlb', date: '2026-10-12', awayTeam: '道奇', homeTeam: '釀酒人',
      bet365Taiwan: wrong(), bet365TaiwanAuto: wrong(), intlState: state() },
    { league: 'mlb', date: '2026-10-08', awayTeam: '道奇', homeTeam: '勇士', bet365Taiwan: wrong(), intlState: state() },
  ];
  const card = { away: '道奇', home: '釀酒人', league: 'mlb',
    settled: { bet365Taiwan: wrong(), bet365TaiwanAuto: wrong(), intlState: state() } };
  let saves = 0;
  const context = { doc: { games, boards: { '2026-10-12': { items: [card] } } }, _loadBlocked: false,
    save: () => { saves++; }, bumpGamesVersion: () => {}, console: { warn() {} } };
  const run = () => vm.runInNewContext(code, context);
  run();
  for (const s of [games[0].bet365Taiwan, games[0].bet365TaiwanAuto, card.settled.bet365Taiwan, card.settled.bet365TaiwanAuto]) {
    assert.equal(s.relation, '收斂');
    assert.equal(s.swapCombo, 'both');
    assert.equal(s.taiwanSwapped, true);
    assert.equal(s.taiwanSwitchCount, 1);
  }
  assert.equal(games[0].intlState.lsw, 1);
  assert.equal(card.settled.intlState.ltr, '00:12 釀酒人 → 07:21 道奇');
  assert.equal(games[1].bet365Taiwan.swapCombo, 'bet365_only');   // 別場不碰
  assert.equal(saves, 1);
  run();
  assert.equal(saves, 1);                                          // 已更正 → 不再寫入
});
