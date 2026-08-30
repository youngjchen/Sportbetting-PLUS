'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadIntlVerdict(game) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function intlVerdict(it, ist){');
  const end = html.indexOf('\nasync function loadIntlState()', start);
  assert.ok(start >= 0 && end > start, '找不到 intlVerdict 實作');
  const context = {
    doc: { activeDate: '2026-08-26' },
    window: {
      __oddsPortalIntegration: { gameFor: () => game },
    },
  };
  vm.runInNewContext(html.slice(start, end), context);
  return context.intlVerdict;
}

function loadIntlHistoryHelper() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function intlBet365HistoryHTML(it, ist, iv){');
  const end = html.indexOf('\nasync function loadIntlState()', start);
  assert.ok(start >= 0 && end > start, '找不到 Bet365 歷史證據共用顯示函式');
  const context = { esc: (value) => String(value) };
  vm.runInNewContext(html.slice(start, end), context);
  return context.intlBet365HistoryHTML;
}

function loadIntlColorHelper() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function intlVerdictColor(v, has){');
  const end = html.indexOf('\nfunction intlBet365HistoryHTML', start);
  assert.ok(start >= 0 && end > start, '找不到國際軸警示色共用函式');
  const context = {};
  vm.runInNewContext(html.slice(start, end), context);
  return context.intlVerdictColor;
}

const item = { type: 'match', away: '海盜', home: '教士' };
const titan = {
  is: 'home', il: 1.5, sw: 1, ls: 'home', v: 'was', mf: 'home',
  u: '2026-08-26T10:04:15+08:00',
};

test('過期 BetExplorer 摘要不得蓋掉較新的 Titan 現行方向', () => {
  const verdict = loadIntlVerdict({
    observedAt: '2026-08-25T07:50:06+08:00',
    bet365: { side: 'away', line: 1.5, flipEver: false },
  })(item, titan);

  assert.equal(verdict.side, 'home');
  assert.equal(verdict.line, 1.5);
  assert.equal(verdict.v, 'was');
  assert.equal(verdict.be, null);
  assert.equal(verdict.lag, false);
});

test('較新的 BetExplorer 摘要仍維持主來源裁決', () => {
  const verdict = loadIntlVerdict({
    observedAt: '2026-08-26T10:05:00+08:00',
    bet365: { side: 'away', line: 1.5, flipEver: false },
  })(item, titan);

  assert.equal(verdict.side, 'away');
  assert.equal(verdict.v, 'flip');
  assert.equal(verdict.be.side, 'away');
  assert.equal(verdict.lag, true);
});

test('Bet365 自己的觀測時間優先於整場舊時間', () => {
  const verdict = loadIntlVerdict({
    observedAt: '2026-08-25T07:50:06+08:00',
    bet365: {
      side: 'away', line: 1.5, flipEver: false,
      observedAt: '2026-08-26T10:05:00+08:00',
    },
  })(item, titan);

  assert.equal(verdict.side, 'away');
  assert.equal(verdict.be.side, 'away');
});

test('台彩尚未開盤時，BetExplorer 已確認的 Bet365 對調仍要亮警示', () => {
  const verdict = loadIntlVerdict({
    bet365: {
      side: 'home', line: 1.5, flipEver: true,
      struck: [{ side: 'away', line: 1.5, at: '2026-08-30T03:21:00+08:00' }],
      observedAt: '2026-08-30T10:20:11+08:00',
    },
  })(
    { type: 'match', away: '太空人', home: '大都會' },
    { is: 'home', il: 1.5, sw: 1, ls: null, lsw: 0, v: 'swap' },
  );

  assert.equal(verdict.v, 'swap');
  assert.equal(verdict.be.flipEver, true);
});

test('逐筆舊列暫缺時，明細仍交代已保存的 Bet365 對調證據', () => {
  const historyHTML = loadIntlHistoryHelper();
  const text = historyHTML(
    { away: '白襪', home: '雙城' },
    { is: 'home', sw: 0, ls: 'home', lsw: 0, eo: true, v: 'was' },
    { be: null, side: 'home', line: 1.5, v: 'was' },
  );

  assert.match(text, /bet365 曾對調/);
  assert.match(text, /逐筆時間/);
});

test('Bet365 單平台對調在卡片警示條使用青綠色，而不是普通灰色', () => {
  const colorFor = loadIntlColorHelper();
  assert.equal(colorFor('swap', true), '#2bbfa0');
  assert.notEqual(colorFor('swap', true), colorFor(null, true));
});
