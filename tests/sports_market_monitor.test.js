'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { renderPlatformMonitor, timeText } = require('../sports-market-monitor.js');

test('三平台收合列只顯示目前方向與是否對調，時間與來源只在明細', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const monitor = renderPlatformMonitor({
    documentRef: dom.window.document,
    sources: [
      {
        key: 'stake', label: 'STAKE', current: '暴龍讓3.5', changed: true,
        details: [['獨贏', '客 熱火 2.25／主 暴龍 1.58']],
        events: [{ at: '2026-10-03T15:57:05.999Z', text: '熱火 → 暴龍' }],
        sourceLabel: 'Stake 官網',
      },
      { key: 'bet365', label: 'BET365', current: '暴龍讓3.5', changed: false, details: [], events: [], sourceLabel: 'BET365 官網' },
      { key: 'taiwan', label: '台彩', current: '暴龍讓3.5', changed: false, details: [], events: [], sourceLabel: '玩運彩開盤' },
    ],
  });

  assert.ok(monitor.classList.contains('source-count-3'));
  const head = monitor.querySelector('.market-monitor-head');
  assert.match(head.textContent, /STAKE暴龍讓3\.5曾對調/);
  assert.doesNotMatch(head.textContent, /23:57|官網|2\.25/);
  assert.equal(monitor.querySelector('.market-monitor-details').hidden, true);

  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(monitor.querySelector('.market-monitor-details').hidden, false);
  assert.match(monitor.querySelector('.market-monitor-details').textContent, /23:57熱火 → 暴龍/);
  assert.match(monitor.querySelector('.market-monitor-details').textContent, /Stake 官網/);
});

test('NHL 兩平台版維持兩欄且缺盤顯示待資料', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const monitor = renderPlatformMonitor({
    documentRef: dom.window.document,
    sources: [
      { key: 'stake', label: 'STAKE', current: '企鵝讓1.5', changed: false, details: [], events: [] },
      { key: 'bet365', label: 'BET365', current: '未取得方向', available: false, details: [], events: [] },
    ],
  });

  assert.ok(monitor.classList.contains('source-count-2'));
  assert.equal(monitor.querySelectorAll('.market-platform').length, 2);
  assert.match(monitor.querySelector('.market-platform.bet365').textContent, /未取得方向待資料/);
});

test('顯示時間固定轉成台灣時間', () => {
  assert.equal(timeText('2026-10-03T15:57:05.999Z'), '23:57');
});
