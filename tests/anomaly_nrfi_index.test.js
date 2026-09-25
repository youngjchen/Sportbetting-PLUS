'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadCollectCrossTab(doc, lookupStakeNrfi) {
  const start = indexSource.indexOf('function collectCrossTab(leagueFilter)');
  const end = indexSource.indexOf('// 異常組合統計「未讀」提示', start);
  assert.ok(start >= 0 && end > start, '找不到 collectCrossTab 原始函式');
  const sandbox = { doc, window: { lookupStakeNrfi } };
  vm.runInNewContext(`${indexSource.slice(start, end)}\nthis.collectCrossTab = collectCrossTab;`, sandbox);
  return sandbox.collectCrossTab;
}

function loadBAnomInfo(intlState, crossTab) {
  const start = indexSource.indexOf('function bAnomInfo(it){');
  const end = indexSource.indexOf('// 獨贏 ⓘ：STAKE 賠率評語', start);
  assert.ok(start >= 0 && end > start, '找不到 bAnomInfo 原始函式');
  const sandbox = {
    intlFor: () => intlState,
    crossTabCached: () => crossTab,
  };
  vm.runInNewContext(`${indexSource.slice(start, end)}\nthis.bAnomInfo = bAnomInfo;`, sandbox);
  return sandbox.bAnomInfo;
}

function crossTabFixture() {
  const bucket = (n = 0) => ({ n, fw: 0, fwN: n, cov: 0, covN: n, ov: 0, ovN: n, nr: 0, nrN: n });
  const group = () => ({ solo: bucket(1), swap: bucket(1), div: bucket(1), both: bucket(1), all: bucket(1) });
  return {
    total: 1,
    grp: { flip: group(), conv: group() },
    other: { swapOnly: bucket(1), divOnly: bucket(1), bothOD: bucket(1) },
  };
}

test('既有 Stake 異常統計以 sid 合併 NRFI，且保留首局比分供明細核對', () => {
  const game = {
    sid: 'stake_1', league: 'mlb', date: '2026-08-01', flipState: 'flipped',
    awayTeam: 'A', homeTeam: 'B', awayScore: 2, homeScore: 1,
    closeOddsAway: 1.7, closeOddsHome: 2.1, hdFav: 'away',
    hdResult: 'fav_cover', totResult: 'under', preGameSwap: false,
  };
  const collect = loadCollectCrossTab({ games: [game] }, (sid) => (
    sid === 'stake_1' ? { nrfi: true, awayFirst: 0, homeFirst: 0 } : null
  ));
  const bucket = collect('all').grp.flip.solo;
  assert.deepEqual({ n: bucket.n, nr: bucket.nr, nrN: bucket.nrN }, { n: 1, nr: 1, nrN: 1 });
  assert.deepEqual(
    { nrfi: bucket.games[0].nrfi, awayFirst: bucket.games[0].awayFirst, homeFirst: bucket.games[0].homeFirst },
    { nrfi: true, awayFirst: 0, homeFirst: 0 },
  );
});

test('未來卡片已結算 NRFI 時優先使用卡片結果，不被舊 sid 快照覆蓋', () => {
  const game = {
    sid: 'stake_new', league: 'mlb', date: '2026-08-24', flipState: 'flipped',
    awayTeam: 'A', homeTeam: 'B', awayScore: 3, homeScore: 1,
    closeOddsAway: 1.6, closeOddsHome: 2.3, hdFav: 'away',
    hdResult: 'fav_cover', totResult: 'under', preGameSwap: false,
    nrfiStatus: 'yrfi', nrfi: false, awayFirst: 1, homeFirst: 0,
  };
  const collect = loadCollectCrossTab({ games: [game] }, () => ({ nrfi: true, awayFirst: 0, homeFirst: 0 }));
  const bucket = collect('all').grp.flip.solo;
  assert.deepEqual(
    { nr: bucket.nr, nrN: bucket.nrN, nrfi: bucket.games[0].nrfi, awayFirst: bucket.games[0].awayFirst },
    { nr: 0, nrN: 1, nrfi: false, awayFirst: 1 },
  );
});

test('第一套 Stake × 台彩統計不得用 Bet365 × 台彩快照自動補分類', () => {
  const game = {
    sid: 'auto-anomaly', league: 'mlb', date: '2026-09-24', flipState: 'none',
    awayTeam: '藍鳥', homeTeam: '金鶯', awayScore: 2, homeScore: 4,
    closeOddsAway: 2.1, closeOddsHome: 1.7, hdFav: 'home',
    hdResult: 'fav_cover', totResult: 'under', preGameSwap: false,
    bet365Taiwan: { relation: '收斂', swapCombo: 'bet365_only' },
  };
  const collect = loadCollectCrossTab({ games: [game] }, () => null);
  const result = collect('all');
  assert.equal(result.grp.conv.solo.n, 0);
  assert.equal(result.grp.flip.solo.n, 0);
  assert.equal(result.other.swapOnly.n, 0);
  assert.equal(result.other.divOnly.n, 0);
});

test('第一套統計仍保留 flipState=none 的 Stake 只對調與只背離', () => {
  const base = {
    league: 'kbo', date: '2026-09-25', flipState: 'none',
    awayTeam: '韓華鷹', homeTeam: 'NC恐龍', awayScore: 7, homeScore: 8,
    hdResult: 'fav_nocover', totResult: 'over',
  };
  const games = [{
    ...base, sid: 'swap-only', hdFav: 'away', preGameSwap: true,
    closeOddsAway: 1.9, closeOddsHome: 1.9,
  }, {
    ...base, sid: 'div-only', hdFav: 'home', preGameSwap: false,
    closeOddsAway: 1.6, closeOddsHome: 2.2,
  }];

  const result = loadCollectCrossTab({ games }, () => null)('all');
  assert.equal(result.other.swapOnly.n, 1);
  assert.equal(result.other.divOnly.n, 1);
});

test('晶片無視 Bet365 × 台彩顛倒，Stake 與台彩同邊時不顯示', () => {
  const info = loadBAnomInfo(
    { is: 'home', ls: 'away', v: 'flip', sw: 1, lsw: 0 },
    crossTabFixture(),
  )({
    hdFav: 'away', platformFlip: false, flipVanished: false, preGameSwap: false,
    closeOddsAway: 1.9, closeOddsHome: 1.9,
  });

  assert.equal(info, null);
});

test('晶片仍會顯示 Stake 與台彩當下方向相反的顛倒', () => {
  const info = loadBAnomInfo(
    { is: 'home', ls: 'away', v: null, sw: 0, lsw: 0 },
    crossTabFixture(),
  )({
    hdFav: 'home', platformFlip: false, flipVanished: false, preGameSwap: false,
    closeOddsAway: 1.9, closeOddsHome: 1.9,
  });

  assert.equal(info.lbl, '顛倒');
});

test('盤面用時間或官方賽事 ID 區分雙重賽，載入時修復遺漏的已結算卡片', () => {
  assert.match(indexSource, /__gameRecordUtils\.sameGame\(x, g\)/);
  assert.match(indexSource, /function recoverMissingSettledGames\(\)/);
  assert.match(indexSource, /missingSettledCards\(doc\)/);
  assert.match(indexSource, /applySettlement\(row\.item, row\.picks, \+1, row\.date\)/);
});

test('國際軸晚於結算載入時，會按結算日期重新配對並觸發七類回補', () => {
  assert.match(indexSource, /function intlFor\(it,dateKey\)/);
  assert.match(indexSource, /const activeDate = dateKey \|\| doc\.activeDate/);
  assert.match(indexSource, /return intlFor\(card,game\.date\)/);
  assert.match(
    indexSource,
    /__intlRaw = txt; __intl = JSON\.parse\(txt\);\s*try\{ backfillRecentBet365TaiwanSnapshots\(\); \}catch\(_\)\{\}/,
  );
});

test('正式歷史快照維持 262 個 Stake sid 與 Bet365 × 台彩七類 273 場', () => {
  const history = JSON.parse(fs.readFileSync(path.join(root, 'data', 'anomaly_nrfi_history.json'), 'utf8'));
  assert.equal(Object.keys(history.stakeBySid).length, 262);
  assert.equal(history.bet365Taiwan.length, 273);
  assert.equal(history.bet365Taiwan.filter((g) => g.relation === '顛倒').length, 112);
  assert.equal(history.bet365Taiwan.filter((g) => g.relation === '收斂').length, 161);
});

test('玩運彩缺漏以官方資料補齊，真正取消場標記取消且不冒充 NRFI', () => {
  const history = JSON.parse(fs.readFileSync(path.join(root, 'data', 'anomaly_nrfi_history.json'), 'utf8'));
  const byKey = Object.fromEntries(history.bet365Taiwan.map((game) => [game.alertKey, game]));
  assert.deepEqual(
    [byKey['mlb|2026-07-19|道奇|洋基'].nrfi, byKey['mlb|2026-07-19|道奇|洋基'].awayFirst, byKey['mlb|2026-07-19|道奇|洋基'].homeFirst],
    [true, 0, 0],
  );
  assert.deepEqual(
    [byKey['npb|2026-08-22|西武獅|樂天金鷲'].nrfi, byKey['npb|2026-08-22|西武獅|樂天金鷲'].awayFirst, byKey['npb|2026-08-22|西武獅|樂天金鷲'].homeFirst],
    [true, 0, 0],
  );
  const canceled = byKey['kbo|2026-08-05|KT巫師|起亞虎'];
  assert.equal(canceled.eventStatus, 'canceled');
  assert.equal(canceled.nrfi, null);
  assert.equal(history.bet365Taiwan.filter((game) => game.nrfi == null).length, 1);
});
