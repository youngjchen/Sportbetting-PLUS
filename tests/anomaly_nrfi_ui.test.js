'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  lookupStakeNrfi,
  collectBet365Taiwan,
  renderBet365TaiwanSection,
  install,
} = require('../anomaly-nrfi-addon.js');

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
