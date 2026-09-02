'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  lookupStakeNrfi,
  collectBet365Taiwan,
  classifyBet365TaiwanEvidence,
  buildBet365TaiwanSnapshot,
  resolveSettlementOfficialId,
  settledGameToBet365TaiwanRow,
  renderBet365TaiwanSection,
  backfillBet365TaiwanSnapshots,
  install,
} = require('../anomaly-nrfi-addon.js');

test('結算 officialId 依自動配對、既有結算、卡片本身的順序安全回退', () => {
  assert.equal(resolveSettlementOfficialId({ dataset: { officialId: 'AUTO_1' } }, {
    settled: { officialId: 'OLD_1' }, officialId: 'CARD_1',
  }), 'AUTO_1');
  assert.equal(resolveSettlementOfficialId(null, {
    settled: { officialId: 'OLD_1' }, officialId: 'CARD_1',
  }), 'OLD_1');
  assert.equal(resolveSettlementOfficialId(null, { officialId: 'CARD_1' }), 'CARD_1');
  assert.equal(resolveSettlementOfficialId(null, {}), null);
});

const history = {
  stakeBySid: {
    stake_1: { nrfi: true, awayFirst: 0, homeFirst: 0, firstInningRuns: 0 },
  },
  bet365Taiwan: [
    {
      alertKey: 'a', league: 'mlb', date: '2026-08-01', away: 'A', home: 'B',
      awayScore: 2, homeScore: 1, relation: '顛倒', swapCombo: 'neither',
      mlFavorite: 'away', mlFavoriteWin: true, handicapResult: 'cover', totalResult: 'under',
      nrfi: true, awayFirst: 0, homeFirst: 0,
    },
    {
      alertKey: 'b', league: 'mlb', date: '2026-08-02', away: 'C', home: 'D',
      awayScore: 1, homeScore: 4, relation: '顛倒', swapCombo: 'taiwan_only',
      mlFavorite: 'away', mlFavoriteWin: false, handicapResult: 'nocover', totalResult: 'over',
      nrfi: false, awayFirst: 1, homeFirst: 0,
    },
    {
      alertKey: 'c', league: 'npb', date: '2026-08-03', away: 'E', home: 'F',
      awayScore: 3, homeScore: 2, relation: '收斂', swapCombo: 'bet365_only',
      mlFavorite: null, mlFavoriteWin: null, handicapResult: 'push', totalResult: 'push',
      nrfi: null, awayFirst: null, homeFirst: null,
    },
  ],
};

test('Stake 異常場用 sid 取得 NRFI 與首局比分證據', () => {
  assert.deepEqual(lookupStakeNrfi(history, 'stake_1'), history.stakeBySid.stake_1);
  assert.equal(lookupStakeNrfi(history, 'missing'), null);
});

test('Bet365 × 台彩七類依聯盟分組，走盤與缺值不進分母', () => {
  const all = collectBet365Taiwan(history, 'all');
  assert.equal(all.total, 3);
  assert.deepEqual(
    { n: all.groups.inverted.neither.n, fw: all.groups.inverted.neither.fw, cov: all.groups.inverted.neither.cov, ov: all.groups.inverted.neither.ov, nr: all.groups.inverted.neither.nr },
    { n: 1, fw: 1, cov: 1, ov: 0, nr: 1 },
  );
  assert.deepEqual(
    { n: all.groups.converged.bet365_only.n, fwN: all.groups.converged.bet365_only.fwN, covN: all.groups.converged.bet365_only.covN, ovN: all.groups.converged.bet365_only.ovN, nrN: all.groups.converged.bet365_only.nrN },
    { n: 1, fwN: 0, covN: 0, ovN: 0, nrN: 0 },
  );
  assert.equal(collectBet365Taiwan(history, 'mlb').total, 2);
});

test('七類表放在獨立區塊，NRFI 在開大後，明細顯示首局證據', () => {
  const drillGames = [];
  const html = renderBet365TaiwanSection('all', history, {
    today: '2026-08-02',
    drillBlock(games, roleFn) {
      drillGames.push(...games);
      return { id: 'dr-1', html: `<div>${games.map(roleFn).join('|')}</div>` };
    },
  });

  assert.match(html, /Bet365 × 台彩七類/);
  assert.match(html, /<th>開大<\/th><th>NRFI<\/th>/);
  assert.match(html, /顛倒/);
  assert.match(html, /收斂/);
  assert.match(html, /colspan="6"/);
  assert.match(html, /NRFI（首局 0-0）/);
  assert.ok(drillGames.some(g => g.away === 'A' && g.home === 'B'));
});

test('歷史資料晚於回顧頁載入時，會重畫已開啟的回顧頁', async () => {
  let renders = 0;
  const browser = {
    document: {
      getElementById(id) {
        return id === 'reviewpage' ? { classList: { contains: (name) => name === 'show' } } : null;
      },
    },
    fetch: async () => ({ ok: true, json: async () => history }),
    renderReviewPage: () => { renders += 1; },
    console: { warn: () => {} },
  };
  install(browser);
  await browser.ANOMALY_NRFI_READY;
  assert.equal(renders, 1);
  assert.equal(browser.lookupStakeNrfi('stake_1').nrfi, true);
});

test('官方取消場在明細清楚標示取消，不顯示成資料缺漏', () => {
  const canceled = {
    eventStatus: 'canceled', officialSourceLabel: 'KBO 官網',
    mlFavoriteWin: null, handicapResult: null, totalResult: null, nrfi: null,
  };
  const { detailRole } = require('../anomaly-nrfi-addon.js');
  assert.match(detailRole(canceled), /官方取消/);
  assert.match(detailRole(canceled), /NRFI 不計/);
  assert.doesNotMatch(detailRole(canceled), /首局—/);
});

test('警示條證據自動分成七類，正常同向且雙方未對調不列入', () => {
  assert.deepEqual(
    classifyBet365TaiwanEvidence({
      relationCode: 'flip', bet365Swapped: false, taiwanSwapped: false,
      bet365Side: 'away', taiwanSide: 'home',
    }),
    {
      relation: '顛倒', swapCombo: 'neither', bet365Swapped: false, taiwanSwapped: false,
      bet365Side: 'away', taiwanSide: 'home',
    },
  );
  assert.equal(classifyBet365TaiwanEvidence({
    relationCode: 'was', bet365Swapped: false, taiwanSwapped: false,
    bet365Side: 'home', taiwanSide: 'home',
  }), null);
  assert.equal(
    classifyBet365TaiwanEvidence({
      relationCode: 'was', bet365Swapped: true, taiwanSwapped: true,
      bet365Side: 'home', taiwanSide: 'home',
    }).swapCombo,
    'both',
  );
});

test('七類統計聯集歷史與卡片結算，officialId 相同時只算一次且採最新卡片結果', () => {
  const historical = {
    bet365Taiwan: [{
      officialId: 'MLB_GAME_1', league: 'mlb', date: '2026-08-01', away: 'A', home: 'B',
      relation: '顛倒', swapCombo: 'neither', mlFavoriteWin: false,
      handicapResult: 'nocover', totalResult: 'under', nrfi: false,
    }],
  };
  const settled = [{
    sid: 's-new', officialId: 'MLB_GAME_1', league: 'mlb', date: '2026-08-01',
    awayTeam: 'A', homeTeam: 'B', awayScore: 4, homeScore: 1,
    closeOddsAway: 1.70, closeOddsHome: 2.20, hdResult: 'fav_cover', totResult: 'over',
    nrfiStatus: 'nrfi', awayFirst: 0, homeFirst: 0,
    bet365Taiwan: { relation: '顛倒', swapCombo: 'neither', bet365Swapped: false, taiwanSwapped: false },
  }];
  const row = settledGameToBet365TaiwanRow(settled[0]);
  assert.equal(row.mlFavoriteWin, true);
  assert.equal(row.handicapResult, 'cover');
  assert.equal(row.nrfi, true);

  const all = collectBet365Taiwan(historical, 'all', settled);
  assert.equal(all.total, 1);
  assert.deepEqual(
    { fw: all.groups.inverted.neither.fw, cov: all.groups.inverted.neither.cov, ov: all.groups.inverted.neither.ov, nr: all.groups.inverted.neither.nr },
    { fw: 1, cov: 1, ov: 1, nr: 1 },
  );
});

test('結算時凍結警示條同一來源：BetExplorer 優先、Titan 只作缺列備援', () => {
  const snapshot = buildBet365TaiwanSnapshot(
    { sw: 2, lsw: 1, ls: 'home', ll: 1.5, u: '2026-08-24T12:00:00+08:00' },
    { v: 'was', side: 'home', line: 1.5, be: { flipEver: false, struck: [] } },
  );
  assert.deepEqual(
    {
      relation: snapshot.relation,
      swapCombo: snapshot.swapCombo,
      bet365Swapped: snapshot.bet365Swapped,
      taiwanSwapped: snapshot.taiwanSwapped,
      evidenceSource: snapshot.evidenceSource,
    },
    {
      relation: '收斂', swapCombo: 'taiwan_only',
      bet365Swapped: false, taiwanSwapped: true,
      evidenceSource: 'betexplorer+playsport',
    },
  );

  const fallback = buildBet365TaiwanSnapshot(
    { sw: 1, lsw: 0, is: 'away', il: 1.5, ls: 'home', ll: 1.5 },
    { v: 'flip', side: 'away', line: 1.5, be: null },
  );
  assert.equal(fallback.swapCombo, 'bet365_only');
  assert.equal(fallback.evidenceSource, 'titan+playsport');
});

test('BetExplorer 列暫缺但曾相反事實已鎖定時，結算快照仍歸入 Bet365 對調收斂', () => {
  const snapshot = buildBet365TaiwanSnapshot(
    { sw: 0, lsw: 0, eo: true, is: 'home', il: 1.5, ls: 'home', ll: 1.5 },
    { v: 'was', side: 'home', line: 1.5, be: null },
  );

  assert.equal(snapshot.relation, '收斂');
  assert.equal(snapshot.swapCombo, 'bet365_only');
  assert.equal(snapshot.bet365Swapped, true);
});

test('補回已結算但因舊重複賽事列而漏掉的 Bet365 × 台彩快照', () => {
  const games = [{
    date: '2026-09-02', awayTeam: '大都會', homeTeam: '光芒',
    intlState: { eo: true, sw: 2, lsw: 0, ls: 'home', ll: 1.5 },
    bet365Taiwan: null,
  }, {
    date: '2026-09-01', awayTeam: '已完成', homeTeam: '不可覆蓋',
    intlState: { eo: true },
    bet365Taiwan: { relation: '顛倒', swapCombo: 'neither' },
  }];
  const changed = backfillBet365TaiwanSnapshots(games, (game) => ({
    v: 'was', side: 'home', line: 1.5,
    be: { flipEver: true, struck: [{ side: 'away', line: 1.5 }] },
  }));
  assert.equal(changed, 1);
  assert.equal(games[0].bet365Taiwan.relation, '收斂');
  assert.equal(games[0].bet365Taiwan.swapCombo, 'bet365_only');
  assert.deepEqual(games[1].bet365Taiwan, { relation: '顛倒', swapCombo: 'neither' });
});

test('結算當下國際軸尚未載入，資料晚到後仍會補回七類快照', () => {
  const lateIntlState = {
    is: 'home', il: 1.5, sw: 0,
    ls: 'away', ll: 1.5, lsw: 4,
    eo: true, v: 'flip',
    u: '2026-09-02T17:59:08+08:00',
  };
  const games = [{
    date: '2026-09-02', league: 'kbo', gameTime: '17:30',
    awayTeam: '韓華鷹', homeTeam: 'KT巫師',
    intlState: null, bet365Taiwan: null,
  }];

  const changed = backfillBet365TaiwanSnapshots(
    games,
    (_game, state) => ({
      v: 'flip', side: 'home', line: 1.5,
      be: { flipEver: false, struck: [] },
    }),
    () => lateIntlState,
  );

  assert.equal(changed, 1);
  assert.deepEqual(games[0].intlState, lateIntlState);
  assert.equal(games[0].bet365Taiwan.relation, '顛倒');
  assert.equal(games[0].bet365Taiwan.swapCombo, 'taiwan_only');
  assert.equal(games[0].bet365Taiwan.taiwanSwitchCount, 4);
});

test('手動 NRFI／YRFI 沒有逐局比分時，明細仍顯示人工判定來源', () => {
  const { detailRole } = require('../anomaly-nrfi-addon.js');
  assert.match(detailRole({ nrfiStatus: 'nrfi', nrfi: true, nrfiSource: 'manual' }), /NRFI（手動）/);
  assert.match(detailRole({ nrfiStatus: 'yrfi', nrfi: false, nrfiSource: 'manual' }), /YRFI（手動）/);
  assert.match(detailRole({ nrfiStatus: 'pending', nrfi: null }), /待補/);
});
