'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

let monitor = null;
try { monitor = require('../baseball-market-monitor.js'); } catch (_) {}

function stakeGame() {
  return {
    away: '阪神', home: '橫濱', favorite: 'home', canonicalLine: 1.5,
    observedAt: '2026-10-04T08:59:00.000Z', favoriteFlipCount: 1,
    favoriteTransitions: [
      { at: '2026-10-04T03:43:00.000Z', from: 'away', to: 'home' },
    ],
    moneyline: { away: 1.86, home: 1.88 },
    handicapOdds: { away: 1.61, home: 2.13 },
    total: { line: 7.5, over: 2.03, under: 1.73 },
    history: [
      { observedAt: '2026-10-03T14:22:00.000Z', favorite: 'away', canonicalLine: 1.5, total: { line: 7.0 }, handicapOdds: { away: 2.30, home: 1.52 } },
      { observedAt: '2026-10-03T14:25:00.000Z', favorite: 'away', canonicalLine: 1.5, total: { line: 7.0 }, handicapOdds: { away: 2.33, home: 1.52 } },
      { observedAt: '2026-10-04T03:43:00.000Z', favorite: 'home', canonicalLine: 1.5, total: { line: 7.0 }, handicapOdds: { away: 1.61, home: 2.13 } },
      { observedAt: '2026-10-04T05:10:00.000Z', favorite: 'home', canonicalLine: 1.5, total: { line: 7.5 }, handicapOdds: { away: 1.62, home: 2.12 } },
    ],
    sources: { direction: 'stake-official', handicapOdds: 'stake-official', total: 'stake-official', moneyline: 'stake-official' },
  };
}

test('Stake 前台時間軸只保留方向與基準線變動，不列細碎賠率波動', () => {
  assert.ok(monitor, '缺少 baseball-market-monitor 模組');
  const events = monitor.meaningfulStakeEvents(stakeGame());
  assert.deepEqual(events.map((event) => event.text), [
    '阪神 → 橫濱',
    '大小 7 → 7.5',
  ]);
  assert.doesNotMatch(events.map((event) => event.text).join(' '), /2\.30|2\.33|1\.52/);
});

test('三個平台共用單一警示條，收合層不顯示時間、展開層才顯示變動時間', () => {
  assert.ok(monitor, '缺少 baseball-market-monitor 模組');
  const dom = new JSDOM('<!doctype html><body></body>');
  const card = { away: '阪神', home: '橫濱', hdFav: 'home', hdVal: 1.5 };
  const element = monitor.renderMonitor({
    documentRef: dom.window.document,
    card,
    stakeGame: stakeGame(),
    bet365: {
      side: 'away', line: 1.5, flipEver: true, providerLabel: 'BET365 官網',
      events: [{ at: '2026-10-04T03:16:00.000Z', type: 'favorite-flip', from: 'home', to: 'away' }],
    },
    taiwan: { side: 'home', line: 1.5, flipCount: 1, transitionText: '09:33 阪神 → 11:52 橫濱', live: true },
  });
  dom.window.document.body.appendChild(element);

  const head = element.querySelector('.market-monitor-head');
  assert.equal(head.querySelectorAll('.market-source').length, 3);
  assert.match(head.textContent, /STAKE.*橫濱讓1\.5.*曾對調/);
  assert.match(head.textContent, /BET365.*阪神讓1\.5.*曾對調/);
  assert.match(head.textContent, /台彩.*橫濱讓1\.5.*曾對調/);
  assert.doesNotMatch(head.textContent, /03:16|09:33|11:52/);

  head.click();
  const details = element.querySelector('.market-monitor-details');
  assert.equal(details.hidden, false);
  assert.match(details.textContent, /11:43.*阪神 → 橫濱/);
  assert.match(details.textContent, /11:16.*橫濱 → 阪神/);
  assert.match(details.textContent, /09:33 阪神 → 11:52 橫濱/);
  assert.doesNotMatch(details.textContent, /唯讀|不會改卡片|時間不明|2\.30|2\.33/);
});

test('BET365 舊序列只有摘要時仍保留對調明細，但不把時間塞進警示條', () => {
  assert.ok(monitor, '缺少 baseball-market-monitor 模組');
  const dom = new JSDOM('<!doctype html><body></body>');
  const element = monitor.renderMonitor({
    documentRef: dom.window.document,
    card: { away: '阪神', home: '橫濱' },
    bet365: {
      side: 'away', line: 1.5, flipEver: true, events: [],
      transitionText: '02:15 橫濱 → 03:16 阪神', providerLabel: '舊快照',
    },
  });
  const head = element.querySelector('.market-monitor-head');
  assert.doesNotMatch(head.textContent, /02:15|03:16/);
  head.click();
  assert.match(element.querySelector('.market-monitor-details').textContent, /02:15 橫濱 → 03:16 阪神/);
});
