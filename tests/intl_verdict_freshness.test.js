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
