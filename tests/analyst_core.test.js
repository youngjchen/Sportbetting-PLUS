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
  for (const a of core.ANALYSTS) {
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
  assert.deepEqual(rec(core.scenarioStats(ann, 'conflict')), { APE: '21/37', BOOKIE: '29/43', BANKROLL: '19/31', SNIPER: '3/3', MONEY: '26/47' });
  assert.deepEqual(rec(core.scenarioStats(ann, 'loneDissent')), { APE: '5/13', BOOKIE: '4/6', BANKROLL: '1/2', SNIPER: '0/0', MONEY: '5/14' });
  assert.deepEqual(rec(core.scenarioStats(ann, 'noOpposition')), { APE: '28/35', BOOKIE: '32/39', BANKROLL: '19/28', SNIPER: '2/3', MONEY: '36/45' });
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
  assert.ok(core.WATCH.includes('LEO') && !core.ANALYSTS.includes('LEO'));
});
