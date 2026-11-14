'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const core = require('../analyst-core.js');

const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const game = (awayScore, homeScore, extra = {}) => ({ awayScore, homeScore, final: true, phase: 'regular', ...extra });
const pick = (over) => ({ analyst: 'APE', officialId: 'G1', league: 'NHL', date: '2026-10-14', layer: 'card', side: 'away', market: 'ML', line: 0, ...over });

test('settlePick: ML, +1.5 one-goal loss, NBA spread push', () => {
  assert.equal(core.settlePick(pick(), game(3, 2)).result, 'win');
  assert.equal(core.settlePick(pick(), game(2, 3)).result, 'loss');
  const plus = core.settlePick(pick({ market: 'SPREAD', line: 1.5 }), game(3, 4));
  assert.deepEqual(plus, { result: 'win', direction: 'loss' });
  assert.equal(core.settlePick(pick({ market: 'SPREAD', line: -4 }), game(104, 100)).result, 'push');
  assert.equal(core.settlePick(pick({ market: 'SPREAD', line: -4.5 }), game(104, 100)).result, 'loss');
  assert.equal(core.settlePick(pick(), { awayScore: 1, homeScore: 0, final: false }).result, 'pending');
});

test('void (postponed) game is a refund: not settled, not pending, no profit, no context', () => {
  const rows = core.buildLedger([pick({ entryOdds: 1.9 }), pick({ analyst: 'BOOKIE', side: 'home' })], { G1: { void: true } });
  assert.deepEqual(rows.map((r) => r.result), ['refund', 'refund']);
  assert.equal(rows[0].profit, null);
  const s = core.summarize(rows);
  assert.deepEqual([s.settled, s.refunds, s.pending], [0, 2, 0]);
  assert.equal(core.annotateContexts(rows).length, 0);
  assert.equal(core.inScenario({ ctx: { oppCount: 2, ownCount: 1, shape: 'lone' } }, 'loneDissent'), true);
  // 歷史帳本已判定、但對不到單一場次（雙重賽未標）：照原判定，不需要比分
  const fixed = core.buildLedger([pick({ officialId: 'DH', fixedResult: 'loss' })], {});
  assert.deepEqual([fixed[0].result, fixed[0].direction], ['loss', 'loss']);
});

test('priceFrom: favourite +1.5 has no Stake price; underdog +1.5 and NBA favourite spread do', () => {
  const snap = { ml: { away: 1.89, home: 1.92 }, spread: { line: 1.5, favorite: 'away', away: 3.05, home: 1.36 } };
  assert.equal(core.priceFrom(snap, pick({ market: 'SPREAD', line: 1.5 })), null);
  assert.equal(core.priceFrom(snap, pick({ side: 'home', market: 'SPREAD', line: 1.5 })), 1.36);
  assert.equal(core.priceFrom(snap, pick({ side: 'home' })), 1.92);
  const nba = { spread: { line: 4.5, favorite: 'home', away: 1.9, home: 1.92 } };
  assert.equal(core.priceFrom(nba, pick({ side: 'home', market: 'SPREAD', line: -4.5 })), 1.92);
  assert.equal(core.priceFrom(nba, pick({ side: 'home', market: 'SPREAD', line: -5.5 })), null);
});

test('spreads list: picks the pair matching the pick (Stake alternate line first, bet365 main line second)', () => {
  // 客隊是熱門：Stake 存另開盤（主 -1.5／客 +1.5），bet365 存主盤（客 -1.5／主 +1.5）
  const snap = { ml: { away: 1.6, home: 2.4, book: 'stake' }, spreads: [
    { line: 1.5, favorite: 'home', away: 1.28, home: 3.4, book: 'stake' },
    { line: 1.5, favorite: 'away', away: 2.3, home: 1.62, book: 'bet365' },
  ] };
  assert.deepEqual(core.priceQuote(snap, pick({ market: 'SPREAD', line: 1.5 })), { odds: 1.28, book: 'stake' });
  assert.deepEqual(core.priceQuote(snap, pick({ side: 'home', market: 'SPREAD', line: 1.5 })), { odds: 1.62, book: 'bet365' });
  assert.deepEqual(core.priceQuote(snap, pick({ side: 'home' })), { odds: 2.4, book: 'stake' });
  const row = core.buildLedger([pick({ side: 'home', market: 'SPREAD', line: 1.5 })], { G1: { awayScore: 3, homeScore: 2, final: true, closing: snap } })[0];
  assert.deepEqual([row.result, row.odds, row.oddsBook, row.profit], ['win', 1.62, 'bet365', 0.62]);
});

test('spread orientation is checked against the moneyline (Stake favorite field can be the ML favourite)', () => {
  // 真實案例 US 10/06 LAD@ATL：ML 1.91／1.94，Stake 記 favorite=away 但價是「主 -1.5 2.90／客 +1.5 1.42」
  const snap = { ml: { away: 1.91, home: 1.94 }, spreads: [{ line: 1.5, favorite: 'away', away: 1.42, home: 2.9, book: 'stake' }] };
  assert.equal(core.priceFrom(snap, pick({ side: 'home', market: 'SPREAD', line: 1.5 })), null, 'ATL +1.5 must not be priced at 2.90');
  assert.equal(core.priceFrom(snap, pick({ side: 'away', market: 'SPREAD', line: 1.5 })), 1.42);
  // 兩種方向都說不通（兩邊讓分價都比獨贏還難中）→ 不用
  const bad = { ml: { away: 1.5, home: 2.6 }, spread: { line: 1.5, favorite: 'away', away: 3.2, home: 3.0 } };
  assert.equal(core.priceFrom(bad, pick({ side: 'home', market: 'SPREAD', line: 1.5 })), null);
  // 沒有獨贏可校正時照原樣
  assert.equal(core.priceFrom({ spread: { line: 1.5, favorite: 'away', away: 3.05, home: 1.36 } }, pick({ side: 'home', market: 'SPREAD', line: 1.5 })), 1.36);
});

test('duel: hero +1.5 against opposing ML, specific opponents, same-side relation', () => {
  const results = { A: game(3, 4), B: game(5, 1), C: game(2, 6) };
  const rows = core.buildLedger([
    // A：BAN 客 +1.5（輸 1 分→過），APE＋BOO 主 ML（贏）→ 兩邊都過
    pick({ officialId: 'A', analyst: 'BANKROLL', market: 'SPREAD', line: 1.5 }),
    pick({ officialId: 'A', analyst: 'APE', side: 'home' }), pick({ officialId: 'A', analyst: 'BOOKIE', side: 'home' }),
    // B：BAN 主 +1.5（輸 4 分→不過），MONEY 客 ML（贏）
    pick({ officialId: 'B', analyst: 'BANKROLL', side: 'home', market: 'SPREAD', line: 1.5 }), pick({ officialId: 'B', analyst: 'MONEY' }),
    // C：BAN 主 ML，APE 主 ML（同隊）
    pick({ officialId: 'C', analyst: 'BANKROLL', side: 'home' }), pick({ officialId: 'C', analyst: 'APE', side: 'home' }),
  ], results);
  const ann = core.annotateContexts(rows);
  const d = core.duel(ann, { hero: 'BANKROLL', heroMarket: 'PLUS', oppMarket: 'ML' });
  assert.deepEqual([d.games, d.hero.wins, d.opp.wins, d.both], [2, 1, 2, 1]);
  assert.deepEqual(d.events.find((e) => e.officialId === 'A').opps.map((r) => r.analyst), ['APE', 'BOOKIE']);
  assert.equal(core.duel(ann, { hero: 'BANKROLL', opp: ['APE', 'BOOKIE'] }).games, 1);
  assert.equal(core.duel(ann, { hero: 'BANKROLL', opp: ['APE', 'MONEY'] }).games, 0, 'all named opponents must be present');
  const same = core.duel(ann, { hero: 'BANKROLL', relation: 'same' });
  assert.deepEqual([same.games, same.events[0].officialId], [1, 'C']);
  assert.equal(core.marketKind({ market: 'SPREAD', line: -4.5 }), 'MINUS');
});

test('mergePicks keeps the newer copy and keeps tombstones', () => {
  const a = pick({ updatedAt: '2026-10-14T01:00:00Z' });
  const b = pick({ market: 'SPREAD', line: 1.5, updatedAt: '2026-10-14T02:00:00Z' });
  const gone = pick({ layer: 'lotto', deleted: true, updatedAt: '2026-10-14T03:00:00Z' });
  const old = pick({ layer: 'lotto', updatedAt: '2026-10-14T00:00:00Z' });
  const merged = core.mergePicks([a, old], [b, gone]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((p) => p.layer === 'card').market, 'SPREAD');
  assert.equal(core.livePicks(merged).length, 1);
});

test('lotto relation and main-ledger rule', () => {
  const results = { G1: game(4, 1), G2: game(2, 5) };
  const rows = core.buildLedger([
    pick({ market: 'SPREAD', line: 1.5 }),
    pick({ layer: 'lotto' }),
    pick({ officialId: 'G2', layer: 'lotto', side: 'home' }),
  ], results);
  const lottoOnCard = rows.find((r) => r.officialId === 'G1' && r.layer === 'lotto');
  assert.equal(lottoOnCard.relation, '同隊改盤口');
  assert.equal(lottoOnCard.countsInMain, false);
  const lottoOnly = rows.find((r) => r.officialId === 'G2');
  assert.equal(lottoOnly.relation, '表單沒有');
  assert.equal(lottoOnly.countsInMain, true);
  assert.equal(core.relationToCard(pick({ layer: 'lotto', side: 'home' }), pick()), '反向');
});

test('absolute vs relative alignment and conflict', () => {
  const results = { A: game(3, 1), B: game(3, 2) };
  const ann = core.annotateContexts(core.buildLedger([
    pick({ officialId: 'A' }), pick({ officialId: 'A', analyst: 'BOOKIE' }),
    pick({ officialId: 'B' }), pick({ officialId: 'B', analyst: 'BOOKIE', side: 'home' }),
    pick({ officialId: 'B', analyst: 'MONEY', side: 'home', market: 'SPREAD', line: 1.5 }),
  ], results));
  assert.equal(ann.find((r) => r.officialId === 'A').ctx.alignment, 'absolute');
  const ape = ann.find((r) => r.officialId === 'B' && r.analyst === 'APE');
  assert.equal(ape.ctx.conflict, 'absolute');
  assert.equal(ape.ctx.shape, 'lone');
  assert.equal(ann.find((r) => r.analyst === 'MONEY').ctx.conflict, 'relative');
  const bookieB = ann.find((r) => r.officialId === 'B' && r.analyst === 'BOOKIE');
  assert.equal(core.inScenario(bookieB, 'majorityVsLone'), true);
  assert.equal(core.inScenario(ape, 'majorityVsLone'), false);
});

test('acceptance: US 2026-10-13 NHL reproduces the C: tracker settlement and Stake ROI', () => {
  const fx = load('analyst_core_nhl_20261013.json');
  const rows = core.buildLedger(fx.picks, fx.results);
  const main = rows.filter((r) => r.countsInMain);
  const sMain = core.summarize(main);
  assert.equal(sMain.wins, fx.expected.main.wins);
  assert.equal(sMain.losses, fx.expected.main.losses);
  for (const a of Object.keys(fx.expected.analysts)) {   // 驗收資料是 10/13 的五位（LEO 10/14 起）
    const s = core.summarize(main.filter((r) => r.analyst === a));
    assert.equal(`${s.wins}-${s.losses}`, `${fx.expected.analysts[a].wins}-${fx.expected.analysts[a].losses}`, a);
  }
  const extra = rows.filter((r) => !r.countsInMain);
  assert.equal(core.summarize(extra).wins, 10);
  assert.equal(core.summarize(extra).losses, 0);
  const sourceOf = (r) => (r.layer === 'card' ? '表單' : r.countsInMain ? { BANKROLL: 'HAIL MARY', SNIPER: 'RENT PARLAY' }[r.analyst] : 'LOTTO');
  for (const [a, kinds] of Object.entries(fx.expected.sources)) {
    for (const [kind, want] of Object.entries(kinds)) {
      if (kind === '主要命中率') continue;
      const s = core.summarize(rows.filter((r) => r.analyst === a && sourceOf(r) === kind));
      assert.equal(s.priced, want.odds_tickets, `${a} ${kind} priced`);
      assert.ok(Math.abs(s.profit - want.profit_units) < 1e-6, `${a} ${kind} profit ${s.profit} vs ${want.profit_units}`);
    }
  }
  for (const [rel, want] of Object.entries(fx.expected.lottoByRelation)) {
    const s = core.summarize(extra.filter((r) => r.relation === rel));
    assert.equal(s.wins, want.wins, rel);
    assert.ok(Math.abs(s.profit - want.profit_units) < 1e-6, rel);
  }
});

test('acceptance: NHL 9/29-10/13 consensus and conflict numbers match the 10/14 analysis', () => {
  const fx = load('analyst_core_nhl_history.json');
  const rows = core.buildLedger(fx.picks, fx.results);
  const sMain = core.summarize(rows.filter((r) => r.countsInMain));
  assert.equal(`${sMain.wins}-${sMain.losses}`, '221-98');
  const ann = core.annotateContexts(rows);
  const rec = (stats) => Object.fromEntries(Object.entries(stats).map(([a, s]) => [a, `${s.wins}/${s.settled}`]));
  assert.deepEqual(rec(core.scenarioStats(ann, 'conflict')), { APE: '21/37', BOOKIE: '29/43', BANKROLL: '19/31', SNIPER: '3/3', MONEY: '26/47', LEO: '0/0' });
  assert.deepEqual(rec(core.scenarioStats(ann, 'loneDissent')), { APE: '5/13', BOOKIE: '4/6', BANKROLL: '1/2', SNIPER: '0/0', MONEY: '5/14', LEO: '0/0' });
  assert.deepEqual(rec(core.scenarioStats(ann, 'noOpposition')), { APE: '28/35', BOOKIE: '32/39', BANKROLL: '19/28', SNIPER: '2/3', MONEY: '36/45', LEO: '0/0' });
  const { same, versus } = core.pairMatrix(ann);
  assert.deepEqual([same['APE+BOOKIE'].games, same['APE+BOOKIE'].dirWins], [45, 34]);
  assert.deepEqual([same['BOOKIE+MONEY'].games, same['BOOKIE+MONEY'].dirWins], [47, 37]);
  assert.deepEqual([same['BANKROLL+MONEY'].games, same['BANKROLL+MONEY'].dirWins], [39, 25]);
  assert.deepEqual([versus['BOOKIE>MONEY'].games, versus['BOOKIE>MONEY'].wins, versus['MONEY>BOOKIE'].wins], [30, 20, 14]);
  const idx = core.sideIndex(ann);
  assert.deepEqual([idx.query({ key: 'APE+BOOKIE+MONEY', opposed: false }).games, idx.query({ key: 'APE+BOOKIE+MONEY', opposed: false }).dirWins], [11, 10]);
  assert.equal(idx.query({ key: 'APE+BOOKIE+MONEY', opposed: true }).games, 0);
  const vsMoney = idx.query({ key: 'APE+BOOKIE', oppKey: 'MONEY' });
  assert.equal(vsMoney.games, idx.sides.filter((s) => s.key === 'APE+BOOKIE' && s.oppKey === 'MONEY').length);
  assert.equal(idx.query({}).games, idx.sides.length);
  const board = core.comboBoard(ann);
  assert.deepEqual([board['APE+BOOKIE+MONEY'].games, board['APE+BOOKIE+MONEY'].dirWins], [11, 10]);
  assert.deepEqual([board['APE+BOOKIE+BANKROLL+MONEY'].games, board['APE+BOOKIE+BANKROLL+MONEY'].dirWins], [11, 10]);
  const abs = core.scenarioStats(ann, 'absoluteAligned');
  const rel = core.scenarioStats(ann, 'relativeAligned');
  for (const a of core.ANALYSTS) {
    assert.equal(abs[a].settled + rel[a].settled, core.scenarioStats(ann, 'noOpposition')[a].settled, a);
  }
});

test('revision layer (改版另計) never counts in the main ledger, even without a card', () => {
  const rows = core.buildLedger([
    pick({ analyst: 'LEO', layer: 'card', side: 'away' }),
    pick({ analyst: 'LEO', layer: 'rev', side: 'home', market: 'SPREAD', line: 1.5 }),
    pick({ analyst: 'LEO', officialId: 'G2', layer: 'rev', side: 'home' }),
    pick({ analyst: 'LEO', officialId: 'G2', layer: 'lotto', side: 'away' }),
  ], { G1: game(3, 2), G2: game(1, 4) });
  const by = (id, layer) => rows.find((r) => r.officialId === id && r.layer === layer);
  assert.equal(by('G1', 'card').countsInMain, true);
  assert.equal(by('G1', 'rev').countsInMain, false);
  assert.equal(by('G1', 'rev').relation, '反向');
  assert.equal(by('G2', 'rev').countsInMain, false);
  assert.equal(by('G2', 'lotto').countsInMain, true);   // 沒表單的 LOTTO 照舊算主帳
  assert.ok(core.ANALYSTS.includes('LEO') && !core.WATCH.includes('LEO') && core.REVISERS.includes('LEO'));
});

/* ---------- 今天押什麼（2026-11-13） ---------- */
// 歷史：n 場 hero 押客、opps 押主；前 wins 場客勝（ML 對 ML，賠率 1.9）
function history(hero, opps, n, wins, { heroPartners = [], prefix = 'H' } = {}) {
  const picks = []; const results = {};
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    results[id] = { awayScore: i < wins ? 3 : 1, homeScore: i < wins ? 1 : 3, final: true, phase: 'regular', closing: { ml: { away: 1.9, home: 1.9 } } };
    for (const a of [hero, ...heroPartners]) picks.push(pick({ analyst: a, officialId: id, side: 'away' }));
    for (const a of opps) picks.push(pick({ analyst: a, officialId: id, side: 'home' }));
  }
  return core.annotateContexts(core.buildLedger(picks, results));
}
const today = (list) => list.map(([analyst, side, market = 'ML', line = 0]) => pick({ analyst, officialId: 'T', side, market, line }));

test('advice: 收斂·雙方對調 → 讓分方有人推就押讓分方 ML（推薦）；沒人推＝跳過', () => {
  const picks = today([['BOOKIE', 'home', 'SPREAD', 1.5], ['APE', 'away']]);
  const anomaly = { cls: { kind: 'conv', combo: 'both', div: false }, hdFav: 'home' };
  const a = core.adviseGame({ picks, core: 'BOOKIE', ann: [], anomaly });
  assert.deepEqual([a.tier, a.side, a.follow, a.by], ['bet', 'home', 'core', 'anomaly']);
  assert.deepEqual(core.advicePick(a, picks), { market: 'ML', line: 0 });
  assert.equal(a.ev.anomaly.label, '收斂·雙方對調');
  const none = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['APE', 'away']]), core: 'BOOKIE', ann: [], anomaly });
  assert.deepEqual([none.tier, none.side], ['skip', null]);
});

test('advice: 收斂·只有一家對調 → 另一邊人數 ≥ 讓分方才押另一邊（小注）；分析師也推那邊時保留推薦', () => {
  const anomaly = { cls: { kind: 'conv', combo: 'stake', div: false }, hdFav: 'home' };
  const homePicks = today([['BOOKIE', 'home'], ['APE', 'home']]);
  const n = core.adviseGame({ picks: homePicks, core: 'BOOKIE', ann: [], anomaly });   // 沒人撐另一邊 → 照分析師規則
  assert.deepEqual([n.tier, n.side, n.by], ['bet', 'home', 'analysts']);
  const split = today([['BOOKIE', 'home'], ['APE', 'away', 'SPREAD', 1.5], ['MONEY', 'away', 'SPREAD', 1.5]]);
  const a = core.adviseGame({ picks: split, core: 'BOOKIE', ann: [], anomaly });
  assert.deepEqual([a.tier, a.side, a.follow], ['small', 'away', 'against']);
  assert.deepEqual(core.advicePick(a, split), { market: 'SPREAD', line: 1.5 });
  const b = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['APE', 'away']]), core: 'BOOKIE', ann: [], anomaly });
  assert.deepEqual([b.tier, b.side, b.follow], ['bet', 'away', 'core']);
});

test('advice: 沒人反對 → 跟；同樣人數沒人反對的過去報酬是負的 → 小注', () => {
  const picks = today([['BOOKIE', 'away'], ['APE', 'away']]);
  assert.equal(core.adviseGame({ picks, core: 'BOOKIE', ann: [] }).tier, 'bet');
  // 過去 12 場兩人同邊沒人反對，只贏 4 場（ML 1.9）→ 報酬負
  const ann = history('BOOKIE', [], 12, 4, { heroPartners: ['APE'] });
  const a = core.adviseGame({ picks, core: 'BOOKIE', ann });
  assert.deepEqual([a.tier, a.side, a.ev.agree.n], ['small', 'away', 2]);
  assert.equal(core.adviseGame({ picks: today([['APE', 'home']]), core: 'BOOKIE', ann: [] }).tier, 'small');
});

test('advice: 有人反對 → 兩組對上與單挑都挺主跟的人＝推薦；人數一樣降成小注', () => {
  const ann = history('BOOKIE', ['APE'], 10, 8, { heroPartners: ['SNIPER'] });
  const a = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['SNIPER', 'away'], ['APE', 'home']]), core: 'BOOKIE', ann });
  assert.deepEqual([a.tier, a.side, a.follow], ['bet', 'away', 'core']);
  assert.deepEqual(a.ev.signals, { clash: 1, h2h: 1 });
  assert.equal(a.ev.clash.games, 10);
  assert.equal(a.ev.h2h.each.APE.games, 10);
  const tie = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['SNIPER', 'away'], ['APE', 'home'], ['MONEY', 'home']]), core: 'BOOKIE', ann });
  assert.deepEqual([tie.tier, tie.side], ['small', 'away']);
  assert.match(tie.reason, /2:2/);
});

test('advice: 兩個訊號都反 → 押對面小注；樣本不足照跟；主跟的人沒推 → 只看兩組對上', () => {
  const bad = history('BOOKIE', ['APE'], 10, 2);
  const a = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['APE', 'home'], ['MONEY', 'home']]), core: 'BOOKIE', ann: bad });
  assert.deepEqual([a.tier, a.side, a.follow], ['small', 'home', 'against']);
  const thin = history('BOOKIE', ['APE'], 3, 0);
  const b = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['APE', 'home']]), core: 'BOOKIE', ann: thin });
  assert.deepEqual([b.tier, b.side], ['small', 'away']);   // 1:1 人數一樣 → 降一級
  const c = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['SNIPER', 'away'], ['APE', 'home']]), core: 'BOOKIE', ann: thin });
  assert.deepEqual([c.tier, c.side], ['bet', 'away']);
  const noCore = core.adviseGame({ picks: today([['SNIPER', 'away'], ['APE', 'home']]), core: 'BOOKIE', ann: history('SNIPER', ['APE'], 8, 7) });
  assert.deepEqual([noCore.tier, noCore.side, noCore.follow], ['small', 'away', null]);
});

test('advice: 兩組對上挺、單挑反 → 跳過', () => {
  // 兩組對上（BOOKIE＋SNIPER vs APE）贏 8/10；另有 20 場 BOOKIE 對 APE＋SNIPER 只贏 2 場（SNIPER 換邊 → 不算兩組對上，只算單挑）
  const ann = history('BOOKIE', ['APE'], 10, 8, { heroPartners: ['SNIPER'] }).concat(history('BOOKIE', ['APE', 'SNIPER'], 20, 2, { prefix: 'K' }));
  const a = core.adviseGame({ picks: today([['BOOKIE', 'away'], ['SNIPER', 'away'], ['APE', 'home']]), core: 'BOOKIE', ann });
  assert.deepEqual(a.ev.signals, { clash: 1, h2h: -1 });
  assert.deepEqual([a.tier, a.side], ['skip', null]);
});

test('anomClassify: 手動歸類優先；flipStateManual 收斂·雙方；快照讀法同冰球頁', () => {
  assert.deepEqual(core.anomClassify(null, { anomManual: { kind: 'conv', combo: 'stake' } }, 'home'), { kind: 'conv', combo: 'stake', div: false, manual: true });
  assert.equal(core.anomClassify({ relation: 'diverged', stakeSwaps: 1, bet365Swaps: 0 }, { anomManual: { kind: 'none' } }, 'home'), null);
  assert.deepEqual(core.anomClassify({ relation: 'aligned', stakeSwaps: 0, bet365Swaps: 0 }, { flipStateManual: 'converged_both' }, 'home'), { kind: 'conv', combo: 'both', div: false });
  const snap = { flip: false, stakeSwaps: 1, bet365Swaps: 2, relation: 'aligned', mlOdds: { away: 1.6, home: 2.4 } };
  const it = { anomSnap: { relation: null, stakeSwaps: 0 }, anomLive: snap };
  const ev = core.anomEvidenceFromSnap(core.anomBestSnap(it));
  assert.deepEqual(core.anomClassify(ev, it, 'home'), { kind: 'conv', combo: 'both', div: true });
  assert.equal(core.anomRule(core.anomClassify(ev, it, 'home')), 'convBoth');
  assert.equal(core.anomLabel({ kind: 'conv', combo: 'bet365', div: false }), '收斂·只有 BET365 對調');
});

test('anomalyRecord: 押讓分方 vs 另一邊（票）與讓分方直勝', () => {
  const ann = history('BOOKIE', ['APE'], 4, 3);   // 客勝 3／4
  const labels = new Map(['H0', 'H1', 'H2', 'H3'].map((id) => [id, { cls: { kind: 'conv', combo: 'both' }, hdFav: 'away' }]));
  labels.set('H3', { cls: { kind: 'conv', combo: 'stake' }, hdFav: 'away' });
  const r = core.anomalyRecord(ann, labels, 'convBoth');
  assert.deepEqual([r.games, r.fav.wins, r.fav.settled, r.other.wins, r.favDir, r.dirN], [3, 3, 3, 0, 3, 3]);
  assert.deepEqual([r.backed, r.unbacked], [{ n: 3, win: 3 }, { n: 0, win: 0 }]);
  const one = core.anomalyRecord(ann, labels, 'convOne');   // H3：讓分方客、另一邊（主）1:1 有人撐、主勝
  assert.deepEqual([one.games, one.backed, one.unbacked], [1, { n: 1, win: 1 }, { n: 0, win: 0 }]);
});

/* ---------- NBA：不設主跟、讓分加深、冷門獨贏降一級（2026-11-13） ---------- */
test('lineMoveOf／lineMoveGroup：開盤＝最早、現在＝最晚；加深 ≥2、縮小 ≤−2、換邊', () => {
  const rows = [{ at: '2026-11-12T10:00:00Z', fav: 'home', line: -10.5 }, { at: '2026-11-12T01:00:00Z', fav: 'home', line: 7.5 }, { at: 'x', fav: null, line: 3 }];
  const m = core.lineMoveOf(rows);
  assert.deepEqual(m, { openFav: 'home', openLine: 7.5, closeFav: 'home', closeLine: 10.5 });
  assert.equal(core.lineMoveGroup(m), 'deeper');
  assert.equal(core.lineMoveGroup({ openFav: 'home', openLine: 7.5, closeFav: 'home', closeLine: 8.5 }), 'small');
  assert.equal(core.lineMoveGroup({ openFav: 'home', openLine: 7.5, closeFav: 'home', closeLine: 5.5 }), 'shallower');
  assert.equal(core.lineMoveGroup({ openFav: 'away', openLine: 1.5, closeFav: 'home', closeLine: 1.5 }), 'swap');
  assert.equal(core.lineMoveOf([]), null);
});

test('NBA 讓分加深：熱門有人推 → 押熱門獨贏（推薦）；沒人推 → 跳過', () => {
  const lineMove = { openFav: 'home', openLine: 4.5, closeFav: 'home', closeLine: 7.5 };
  const picks = today([['APE', 'home', 'SPREAD', -7.5], ['MONEY', 'away']]);
  const a = core.adviseGame({ picks, core: null, ann: [], lineMove });
  assert.deepEqual([a.tier, a.side, a.by, a.follow], ['bet', 'home', 'lineMove', null]);
  assert.deepEqual(core.advicePick(a, picks), { market: 'ML', line: 0 });
  assert.equal(a.ev.lineMove.label, '加深');
  const none = core.adviseGame({ picks: today([['APE', 'away']]), core: null, ann: [], lineMove });
  assert.deepEqual([none.tier, none.side], ['skip', null]);
  const small = core.adviseGame({ picks, core: null, ann: [], lineMove: { openFav: 'home', openLine: 4.5, closeFav: 'home', closeLine: 5.5 } });
  assert.equal(small.ev.lineMove.label, '微調');
  assert.notEqual(small.by, 'lineMove');
});

test('NBA 不設主跟：理由不出現主跟的人；衝突只看兩組對上', () => {
  const one = core.adviseGame({ picks: today([['APE', 'away']]), core: null, ann: [] });
  assert.deepEqual([one.tier, one.reason], ['small', '只有 APE 推']);
  const two = core.adviseGame({ picks: today([['APE', 'away'], ['MONEY', 'away']]), core: null, ann: [] });
  assert.deepEqual([two.tier, two.reason], ['bet', '2 人同邊、沒人反對']);
  const cf = core.adviseGame({ picks: today([['SNIPER', 'away'], ['APE', 'home']]), core: null, ann: history('SNIPER', ['APE'], 8, 7) });
  assert.deepEqual([cf.tier, cf.side, cf.reason], ['small', 'away', '兩組對上這邊較好']);
  assert.equal(cf.ev.h2h, null);
});

test('dogMlAdjust：押冷門獨贏降一級；冷門讓分、熱門獨贏不動', () => {
  const lineMove = { openFav: 'home', openLine: 6.5, closeFav: 'home', closeLine: 6.5 };
  const bet = { tier: 'bet', side: 'away', reason: 'x' };
  assert.deepEqual(core.dogMlAdjust(bet, { market: 'ML', line: 0 }, lineMove), { tier: 'small', side: 'away', reason: 'x；押冷門獨贏，降一級', dogMl: true });
  assert.deepEqual([core.dogMlAdjust({ tier: 'small', side: 'away', reason: 'y' }, { market: 'ML', line: 0 }, lineMove).tier], ['skip']);
  assert.equal(core.dogMlAdjust(bet, { market: 'SPREAD', line: 6.5 }, lineMove), bet);
  assert.equal(core.dogMlAdjust({ tier: 'bet', side: 'home', reason: 'z' }, { market: 'ML', line: 0 }, lineMove).tier, 'bet');
  assert.equal(core.dogMlAdjust(bet, { market: 'ML', line: 0 }, null), bet);
});

test('lineMoveRecord：加深場熱門有人推／沒人推的直勝，押熱門獨贏與冷門獨贏的票', () => {
  const ann = history('BOOKIE', ['APE'], 4, 3);   // BOOKIE 押客（客勝 3／4）、APE 押主，都是 ML
  const labels = new Map([['H0', { group: 'deeper', fav: 'away' }], ['H1', { group: 'deeper', fav: 'away' }], ['H2', { group: 'small', fav: 'away' }], ['H3', { group: 'deeper', fav: 'away' }]]);
  const r = core.lineMoveRecord(ann, labels);
  assert.deepEqual([r.games, r.backed, r.unbacked], [3, { n: 3, win: 2 }, { n: 0, win: 0 }]);
  assert.deepEqual([r.favML.wins, r.favML.settled, r.dogML.wins, r.dogML.settled], [2, 3, 1, 4]);
});

/* ---------- 冰球：熱門讓分價 vs 冷門獨贏價（2026-11-14） ---------- */
// 遊騎兵@加人 11/14：遊騎兵 1.46／加人 2.65；讓分 遊騎兵 −1.5 @2.10／加人 +1.5 @1.71
const rangers = { ml: { away: 1.46, home: 2.65 }, spread: { line: 1.5, favorite: 'away', away: 2.1, home: 1.71 } };

test('priceSpot：熱門 −1.5 價低於冷門獨贏＝cheap；方向對不上就不判', () => {
  assert.deepEqual(core.priceSpot(rangers), { fav: 'away', favMl: 1.46, dogMl: 2.65, favHd: 2.1, favLine: -1.5, cheap: true, gap: 0.55, hdOk: true });
  const knights = { ml: { away: 2.28, home: 1.61 }, spread: { line: 1.5, favorite: 'home', away: 1.53, home: 2.45 } };
  assert.equal(core.priceSpot(knights).cheap, false);
  const narrow = core.priceSpot({ ml: { away: 1.55, home: 2.45 }, spread: { line: 1.5, favorite: 'away', away: 2.3, home: 1.62 } });
  assert.deepEqual([narrow.cheap, narrow.gap, narrow.hdOk], [true, 0.15, false]);
  assert.equal(core.priceSpot({ ml: { away: 1.9, home: 1.9 }, spread: rangers.spread }), null);
  assert.equal(core.priceSpot({ ml: rangers.ml }), null);
});

test('advice：讓分價低＋熱門那邊人數不少 → 推薦熱門獨贏、附 −1.5；冷門那邊人多 → 照分析師規則', () => {
  const picks = today([['BOOKIE', 'away'], ['SNIPER', 'away'], ['MONEY', 'away'], ['APE', 'home']]);
  const spot = core.priceSpot(rangers);
  const a = core.adviseGame({ picks, core: 'BOOKIE', ann: [], spot });
  assert.deepEqual([a.tier, a.side, a.by, a.follow], ['bet', 'away', 'spot', 'core']);
  assert.deepEqual(core.advicePick(a, picks), { market: 'ML', line: 0, alt: { market: 'SPREAD', line: -1.5, ok: true } });
  // BOOKIE 押冷門、但熱門那邊 2:2 → 仍推熱門（反 BOOKIE）
  const tie = core.adviseGame({ picks: today([['SNIPER', 'away'], ['MONEY', 'away'], ['BOOKIE', 'home', 'SPREAD', 1.5], ['APE', 'home']]), core: 'BOOKIE', ann: [], spot });
  assert.deepEqual([tie.tier, tie.side, tie.follow], ['bet', 'away', 'against']);
  const more = core.adviseGame({ picks: today([['SNIPER', 'away'], ['BOOKIE', 'home'], ['APE', 'home']]), core: 'BOOKIE', ann: [], spot });
  assert.notEqual(more.by, 'spot');
  assert.equal(more.ev.spot.backed, false);
  // 收斂·只有一家（另一邊人數不少）優先
  const conv = core.adviseGame({ picks: today([['SNIPER', 'away'], ['APE', 'home']]), core: 'BOOKIE', ann: [], spot,
    anomaly: { cls: { kind: 'conv', combo: 'stake', div: false }, hdFav: 'away' } });
  assert.equal(conv.by, 'anomaly');
});

test('spotRecord：只算讓分價低的場；熱門有人撐的直勝、獨贏與 −1.5 報酬', () => {
  const ann = history('BOOKIE', ['APE'], 4, 3);   // BOOKIE 押客（熱門）、APE 押主；客勝 3／4
  const games = {};
  for (let i = 0; i < 4; i++) games[`H${i}`] = { final: true, awayScore: i < 3 ? (i === 0 ? 5 : 3) : 1, homeScore: i < 3 ? (i === 0 ? 1 : 2) : 3, closing: rangers };
  games.H3.closing = { ml: { away: 1.9, home: 1.95 }, spread: { line: 1.5, favorite: 'away', away: 2.9, home: 1.4 } };   // 不是讓分價低
  const r = core.spotRecord(ann, games);
  assert.deepEqual([r.games, r.backed.n, r.backed.win, r.backed.cover, r.unbacked.n], [3, 3, 3, 1, 0]);
  assert.equal(r.backed.mlRoi, 0.46);
  assert.equal(r.backed.hdRoi, Math.round(((2.1 - 1) - 2) / 3 * 1000) / 1000);
  assert.deepEqual([r.wide.n, r.narrow.n], [3, 0]);   // 2.65 − 2.10＝0.55 ≥ 0.30
  games.H2.closing = { ml: { away: 1.55, home: 2.45 }, spread: { line: 1.5, favorite: 'away', away: 2.3, home: 1.62 } };   // 差距 0.15
  const r2 = core.spotRecord(ann, games);
  assert.deepEqual([r2.wide.n, r2.narrow.n, r2.narrow.win, r2.narrow.cover], [2, 1, 1, 0]);
});

test('priceSpot 一律用熱門 −1.5：主線 2.5 時取副盤；沒有 −1.5 價就不判斷（11/15 海怪@颶風）', () => {
  const canes = { ml: { away: 4, home: 1.25 }, spread: { line: 2.5, favorite: 'home', away: 1.75, home: 2.08 },
    lines: [{ line: 1.5, favorite: 'away', away: 8, home: 1.08 }, { line: 1.5, favorite: 'home', away: 2.28, home: 1.63 }, { line: 2.5, favorite: 'home', away: 1.75, home: 2.08 }] };
  const sp = core.priceSpot(canes);
  assert.deepEqual([sp.fav, sp.favHd, sp.favLine, sp.gap, sp.hdOk], ['home', 1.63, -1.5, 2.37, true]);
  assert.equal(core.priceSpot({ ml: canes.ml, spread: canes.spread }), null);
  // 副盤也拿得到報價：颶風 −1.5、颶風 +1.5（海怪讓 1.5 那組）
  assert.equal(core.priceFrom(canes, pick({ side: 'home', market: 'SPREAD', line: -1.5 })), 1.63);
  assert.equal(core.priceFrom(canes, pick({ side: 'home', market: 'SPREAD', line: 1.5 })), 1.08);
  assert.equal(core.priceFrom(canes, pick({ side: 'home', market: 'SPREAD', line: -2.5 })), 2.08);
});
