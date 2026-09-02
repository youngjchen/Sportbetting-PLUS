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
