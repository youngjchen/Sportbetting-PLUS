'use strict';

// 卡片「讓分／大小基準線變動」提示（2026-10-10 使用者規格，同冰球）：只看 Stake，沒有 Stake 盤口才看 BET365；數值有變才顯示。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 括號不成對`);
}

const text = (hint) => (hint ? hint.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null);

// ---------- 棒球（index.html） ----------
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function baseball(stakeGame, bet365Game) {
  const sandbox = {
    doc: { activeDate: '2026-10-10' },
    window: {
      __baseballStakeIntegration: { gameFor: () => stakeGame },
      __baseballBet365Integration: { gameFor: () => bet365Game },
    },
  };
  vm.runInNewContext(`${extractFunction(indexSource, 'bLineMoves')}\nthis.result = bLineMoves({ id: 'x' });`, sandbox);
  return sandbox.result;
}
const stakeRow = (at, line, total) => ({ observedAt: at, canonicalLine: line, total: { line: total } });
const betRow = (at, line, total) => ({ observedAt: at, markets: { hd: { line }, total: { line: total } } });

test('棒球：Stake 讓分 1.5→2.5、大小 7.5→8 才顯示；開賽後的盤口不算', () => {
  const stake = {
    scheduledStart: '2026-10-10T09:00:00Z',
    history: [stakeRow('2026-10-09T10:00:00Z', 1.5, 7.5), stakeRow('2026-10-10T08:00:00Z', 2.5, 8)],
    ...stakeRow('2026-10-10T08:00:00Z', 2.5, 8),
  };
  stake.history.push(stakeRow('2026-10-10T10:00:00Z', 3.5, 9.5));   // 開賽後（場中盤）
  const r = baseball(stake, null);
  assert.equal(text(r.hd), 'STAKE 讓分 1.5→2.5');
  assert.equal(text(r.tot), 'STAKE 基準 7.5→8');
});

test('棒球：Stake 有盤口但沒變就不顯示（BET365 有變也不看）；沒有 Stake 才看 BET365', () => {
  const flatStake = { scheduledStart: '2026-10-10T09:00:00Z', history: [stakeRow('2026-10-09T10:00:00Z', 1.5, 7.5)], ...stakeRow('2026-10-10T08:00:00Z', 1.5, 7.5) };
  const movedBet = { scheduledStart: '2026-10-10T09:00:00Z', history: [betRow('2026-10-09T10:00:00Z', 1.5, 7), betRow('2026-10-10T08:00:00Z', 2.5, 7.5)] };
  const both = baseball(flatStake, movedBet);
  assert.equal(both.hd, null);
  assert.equal(both.tot, null);
  const onlyBet = baseball(null, movedBet);
  assert.equal(text(onlyBet.hd), 'BET365 讓分 1.5→2.5');
  assert.equal(text(onlyBet.tot), 'BET365 基準 7→7.5');
  const none = baseball(null, null);
  assert.equal(none.hd, null);
  assert.equal(none.tot, null);
});

// ---------- 籃球（nba.html） ----------
const nbaSource = fs.readFileSync(path.join(__dirname, '..', 'nba.html'), 'utf8');
function basketball(stakeGame, bet365Game, item) {
  const sandbox = { window: { __nbaOddsIntegration: { gameFor: (_m, k) => (k === 'stake' ? stakeGame : bet365Game) } } };
  vm.runInNewContext(`${extractFunction(nbaSource, 'bbStartMs')}\n${extractFunction(nbaSource, 'bbLineMoves')}
this.result = bbLineMoves({ date: '2026-10-10', time: '08:00' }, ${JSON.stringify(item || null)});`, sandbox);
  return sandbox.result;
}
const hist = (...rows) => ({ history: rows.map(([at, line, total]) => ({ observedAt: at, line, total: { line: total } })) });

test('籃球：Stake 讓分 5.5→7.5、大小 221.5→224.5', () => {
  const r = basketball(hist(['2026-10-09T10:00:00Z', -5.5, 221.5], ['2026-10-09T23:30:00Z', -7.5, 224.5]), null);
  assert.equal(text(r.hd), 'STAKE 讓分 5.5→7.5');
  assert.equal(text(r.tot), 'STAKE 基準 221.5→224.5');
});

test('籃球：沒有 Stake 才看 BET365；盤口滾出資料檔時讓分改用結算快照', () => {
  const r = basketball(null, hist(['2026-10-09T10:00:00Z', 3, 210], ['2026-10-09T23:00:00Z', 3, 212.5]));
  assert.equal(r.hd, null);
  assert.equal(text(r.tot), 'BET365 基準 210→212.5');
  const old = basketball(null, null, { lineSnap: { stake: { openFav: 'home', openLine: 4.5, closeFav: 'home', closeLine: 6.5 } } });
  assert.equal(text(old.hd), 'STAKE 讓分 4.5→6.5');
  assert.equal(old.tot, null);
});
