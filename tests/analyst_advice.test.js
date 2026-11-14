'use strict';
// 「今天押什麼」共用判斷（analyst-advice.js）與結算程式的存檔／戰績（2026-11-15）
const assert = require('node:assert/strict');
const test = require('node:test');

const Core = require('../analyst-core.js');
const NhlStake = require('../nhl_stake_core.js');
const NhlBet365 = require('../nhl_bet365_core.js');
const Advice = require('../analyst-advice.js');
const { adviceSnapshots } = require('../analyst_settle.js');

const deps = { Core, NhlStake, NhlBet365 };
const START = Date.parse('2026-11-16T00:00:00Z');   // 台灣 11/16 08:00
const NOW = START - 3600e3;
const nbaGame = { league: 'NBA', officialId: 'NBA_20261116_DAL@MIN', date: '2026-11-16', time: '08:00', away: '獨行俠', home: '灰狼', startMs: START };
const nbaFeed = { updated: new Date(NOW).toISOString(), matches: [{
  officialId: 'NBA_20261116_DAL@MIN', away: '獨行俠', home: '灰狼', scheduledStart: new Date(START).toISOString(),
  moneyline: { away: 2.6, home: 1.52 }, favorite: 'home', line: 5.5, handicapOdds: { away: 1.9, home: 1.9 }, observedAt: new Date(NOW).toISOString(),
  history: [{ observedAt: new Date(NOW - 86400e3).toISOString(), favorite: 'home', line: 5, moneyline: { away: 2.5, home: 1.55 } }],
}] };
const pick = (analyst, side, extra = {}) => ({ analyst, officialId: nbaGame.officialId, league: 'NBA', date: nbaGame.date, time: nbaGame.time,
  away: nbaGame.away, home: nbaGame.home, layer: 'card', side, market: 'ML', line: 0, ...extra });

test('decide：NBA 兩人同邊沒人反對 → 押、帶 Stake 現價與市場移動', () => {
  const dec = Advice.decide({ g: nbaGame, all: [pick('APE', 'home'), pick('MONEY', 'home')], core: null, L: { ann: [] },
    feeds: { NBA: { stake: nbaFeed } }, deps });
  assert.deepEqual([dec.a.tier, dec.a.side, dec.q.pick.market, dec.q.odds], ['bet', 'home', 'ML', 1.52]);
  assert.equal(dec.move.team, 'home');
  assert.equal(dec.move.pp, Math.round((1 / 1.52 - 1 / 1.55) * 1000) / 10);
  const frozen = Advice.freeze(dec, 'T');
  assert.deepEqual([frozen.tier, frozen.side, frozen.market, frozen.line, frozen.odds, frozen.by], ['bet', 'home', 'ML', 0, 1.52, 'analysts']);
  assert.ok(Advice.sameAdvice(frozen, Object.assign({}, frozen, { at: 'U' })));
});

test('decide：NBA 押冷門獨贏 → 跳過；只有一位 → 跳過', () => {
  const dog = Advice.decide({ g: nbaGame, all: [pick('APE', 'away'), pick('MONEY', 'away')], core: null, L: { ann: [] }, feeds: { NBA: { stake: nbaFeed } }, deps });
  assert.deepEqual([dog.a.tier, dog.a.side, dog.q], ['skip', null, null]);
  const one = Advice.decide({ g: nbaGame, all: [pick('APE', 'home')], core: null, L: { ann: [] }, feeds: { NBA: { stake: nbaFeed } }, deps });
  assert.equal(one.a.tier, 'skip');
});

test('adviceSnapshots：只替還沒開賽的場存檔；用預設設定（忽略 BANKROLL）', () => {
  const picks = [pick('APE', 'home'), pick('MONEY', 'home'), pick('BANKROLL', 'away')];
  const schedule = { NHL: new Map(), MLB: new Map(), NBA: new Map([[nbaGame.officialId, nbaGame]]) };
  const feeds = { NHL: {}, MLB: {}, NBA: { stake: nbaFeed } };
  const out = adviceSnapshots({ picks, results: { games: {} }, schedule, feeds, history: { games: {}, picks: [] }, now: NOW });
  assert.deepEqual(Object.keys(out), [nbaGame.officialId]);
  assert.deepEqual([out[nbaGame.officialId].tier, out[nbaGame.officialId].side], ['bet', 'home']);
  const after = adviceSnapshots({ picks, results: { games: {} }, schedule, feeds, history: { games: {}, picks: [] }, now: START + 60e3 });
  assert.deepEqual(after, {});
});

test('adviceRecord：用存檔判斷結算（存檔時的價）、跳過另計、−1.5 可加與否分開', () => {
  const games = {
    A: { league: 'NHL', date: '2026-11-16', final: true, awayScore: 1, homeScore: 4, advice: { side: 'home', market: 'ML', line: 0, odds: 1.6, by: 'spot', alt: { line: -1.5, odds: 2.2, ok: true } } },
    B: { league: 'NHL', date: '2026-11-17', final: true, awayScore: 3, homeScore: 2, advice: { side: 'home', market: 'ML', line: 0, odds: 1.8, by: 'analysts' } },
    C: { league: 'NBA', date: '2026-11-16', final: true, awayScore: 100, homeScore: 90, advice: { tier: 'skip' } },
    D: { league: 'NHL', date: '2026-11-18', final: false, advice: { side: 'away', market: 'ML', line: 0, odds: 2 } },
  };
  const r = Advice.adviceRecord(games, Core);
  assert.equal(r.since, '2026-11-16');
  assert.deepEqual([r.all.n, r.all.w, r.all.skip], [2, 1, 1]);
  assert.equal(Math.round(r.all.profit * 100) / 100, -0.4);
  assert.deepEqual([r.byRule.spot.w, r.byRule.analysts.w], [1, 0]);
  assert.deepEqual([r.alt.ok.n, r.alt.ok.w], [1, 1]);
  assert.equal(r.byLeague.NBA.skip, 1);
});
