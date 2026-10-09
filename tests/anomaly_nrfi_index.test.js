'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { findGame } = require('../pregame-integration.js');

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

function loadBAnomInfo(intlState, crossTab, league = 'npb') {
  const start = indexSource.indexOf('function bAnomInfo(it){');
  const end = indexSource.indexOf('// 獨贏 ⓘ：STAKE 賠率評語', start);
  assert.ok(start >= 0 && end > start, '找不到 bAnomInfo 原始函式');
  const sandbox = {
    intlFor: () => intlState,
    crossTabCached: typeof crossTab === 'function' ? crossTab : () => crossTab,
    leagueOf: () => league,
    bLeagueMeta: () => ({ league, label: { mlb: 'MLB', npb: '日職', kbo: '韓職', cpbl: '中職' }[league] }),
  };
  vm.runInNewContext(`${indexSource.slice(start, end)}\nthis.bAnomInfo = bAnomInfo;`, sandbox);
  return sandbox.bAnomInfo;
}

function loadBAnomRecommendation(overrides = {}) {
  const start = indexSource.indexOf('function bAnomRecommendationFor(it){');
  const end = indexSource.indexOf('// 獨贏 ⓘ：STAKE 賠率評語', start);
  assert.ok(start >= 0 && end > start, '找不到 bAnomRecommendationFor 原始函式');
  const sandbox = {
    bAnomInfo: () => ({ bucket: { n: 40, fw: 25, fwN: 40 }, lbl: '顛倒' }),
    intlFor: () => ({ ls: 'home' }),
    intlVerdict: () => ({ v: 'flip', side: 'away' }),
    leagueOf: () => 'npb',
    bLeagueMeta: () => ({ league: 'npb', label: '日職' }),
    doc: { games: [] },
    window: {
      buildBet365TaiwanSnapshot: () => ({ relation: '顛倒', swapCombo: 'neither' }),
      collectBet365Taiwan: () => ({ groups: { inverted: { neither: { n: 35, fw: 22, fwN: 35 } } } }),
      __baseballStakeIntegration: {
        gameFor: () => ({
          favorite: 'away', canonicalLine: 1.5,
          moneyline: { away: 1.70, home: 2.10 },
          handicapOdds: { away: 2.20, home: 1.62 },
          total: { line: 7.5, over: 1.90, under: 1.80 },
        }),
      },
      buildAnomalyRecommendation: (input) => input,
    },
    ...overrides,
  };
  vm.runInNewContext(`${indexSource.slice(start, end)}\nthis.bAnomRecommendationFor = bAnomRecommendationFor;`, sandbox);
  return sandbox.bAnomRecommendationFor;
}

function loadAppendBAnomRecommendation(overrides = {}) {
  const start = indexSource.indexOf('function appendBAnomRecommendation(root,it){');
  const end = indexSource.indexOf('function renderCardB(it){', start);
  assert.ok(start >= 0 && end > start, '找不到 appendBAnomRecommendation 原始函式');
  const rendered = { className: 'anom-decision' };
  const sandbox = {
    bAnomRecommendationFor: () => ({ markets: [] }),
    window: { renderAnomalyRecommendation: () => rendered },
    ...overrides,
  };
  vm.runInNewContext(`${indexSource.slice(start, end)}\nthis.appendBAnomRecommendation = appendBAnomRecommendation;`, sandbox);
  return { append: sandbox.appendBAnomRecommendation, rendered };
}

function loadIntlFor(intlState, pregameData) {
  const start = indexSource.indexOf('function intlFor(it,dateKey)');
  const end = indexSource.indexOf('function intlVerdictColor', start);
  assert.ok(start >= 0 && end > start, '找不到 intlFor 原始函式');
  const sandbox = {
    __intl: intlState,
    doc: { activeDate: '2026-09-30' },
    leagueOf: () => 'mlb',
    intlArchFor: () => null,
    window: {
      __psFusion: {
        getData: () => pregameData,
        findGame,
      },
    },
  };
  vm.runInNewContext(`${indexSource.slice(start, end)}\nthis.intlFor = intlFor;`, sandbox);
  return sandbox.intlFor;
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

test('異常卡片把兩套對應分類與 Stake 即時三市場賠率交給決策器', () => {
  const recommend = loadBAnomRecommendation();
  const result = recommend({ away: '阪神', home: '橫濱', hdFav: 'away', hdVal: 1.5, totVal: 7.5 });

  assert.deepEqual(Array.from(result.sources, (source) => source.label), ['異常統計', 'BET365 × 台彩七類']);
  assert.equal(result.game.away, '阪神');
  assert.equal(result.game.home, '橫濱');
  assert.equal(result.game.moneyline.away, 1.70);
  assert.equal(result.game.handicapOdds.home, 1.62);
  assert.equal(result.game.total.under, 1.80);
});

test('本場不屬 Bet365 × 台彩七類時仍顯示未納入原因，但不把它當成推薦證據', () => {
  const recommend = loadBAnomRecommendation({
    window: {
      buildBet365TaiwanSnapshot: () => null,
      collectBet365Taiwan: () => { throw new Error('未分類時不應讀取七類統計'); },
      __baseballStakeIntegration: { gameFor: () => null },
      buildAnomalyRecommendation: (input) => input,
    },
  });
  const result = recommend({ away: '阪神', home: '橫濱', hdFav: 'away', hdVal: 1.5, totVal: 7.5 });

  assert.deepEqual(Array.from(result.sources, (source) => source.label), ['異常統計', 'BET365 × 台彩七類']);
  assert.equal(result.sources[1].excluded, true);
  assert.match(result.sources[1].category, /本場不屬七類/);
  assert.equal(result.sources[1].bucket, null);
});

test('本場可歸入七類但統計模組尚未載入時，不得誤標成不屬七類', () => {
  const recommend = loadBAnomRecommendation({
    window: {
      buildBet365TaiwanSnapshot: () => ({ relation: '顛倒', swapCombo: 'both' }),
      __baseballStakeIntegration: { gameFor: () => null },
      buildAnomalyRecommendation: (input) => input,
    },
  });
  const result = recommend({ away: '阪神', home: '橫濱', hdFav: 'away', hdVal: 1.5, totVal: 7.5 });

  assert.equal(result.sources[1].excluded, true);
  assert.match(result.sources[1].category, /尚未載入/);
  assert.doesNotMatch(result.sources[1].category, /不屬七類/);
});

test('阪神對橫濱只讀日職分類，BET365 與台彩都對調時落在顛倒－雙方都對調五場', () => {
  const requestedLeagues = [];
  const recommend = loadBAnomRecommendation({
    bAnomInfo: () => ({
      bucket: { n: 7, fw: 4, fwN: 7 }, lbl: '顛倒＋對調', leagueLabel: '日職', league: 'npb',
    }),
    intlFor: () => ({ ls: 'home', lsw: 1 }),
    intlVerdict: () => ({ v: 'flip', side: 'away', be: { flipEver: true, struck: [{ side: 'home' }] } }),
    window: {
      buildBet365TaiwanSnapshot: () => ({ relation: '顛倒', swapCombo: 'both' }),
      collectBet365Taiwan: (league) => {
        requestedLeagues.push(league);
        return { groups: { inverted: { both: { n: league === 'npb' ? 5 : 61, fw: 3, fwN: 5 } } } };
      },
      __baseballStakeIntegration: { gameFor: () => null },
      buildAnomalyRecommendation: (input) => input,
    },
  });
  const result = recommend({ league: 'npb', away: '阪神', home: '橫濱', hdFav: 'home', hdVal: 1.5, totVal: 7.5 });

  assert.deepEqual(requestedLeagues, ['npb']);
  assert.equal(result.sources[1].bucket.n, 5);
  assert.equal(result.sources[1].category, '顛倒－雙方都對調');
  assert.equal(result.sources[1].leagueLabel, '日職');
});

test('第一套異常統計也只讀卡片所屬聯盟，不再硬抓四聯盟合計', () => {
  const requestedLeagues = [];
  const info = loadBAnomInfo(
    { ls: 'away' },
    (league) => { requestedLeagues.push(league); return crossTabFixture(); },
    'npb',
  )({
    league: 'npb', hdFav: 'home', platformFlip: false, flipVanished: false, preGameSwap: false,
    closeOddsAway: 1.9, closeOddsHome: 1.9,
  });

  assert.ok(info);
  assert.deepEqual(requestedLeagues, ['npb']);
  assert.equal(info.league, 'npb');
  assert.equal(info.leagueLabel, '日職');
});

function loadBAnomInfoLive(intlState, stakeGame, league = 'mlb') {
  const anomStart = indexSource.indexOf('function bAnomInfo(it){');
  const anomEnd = indexSource.indexOf('// 獨贏 ⓘ：STAKE 賠率評語', anomStart);
  const liveStart = indexSource.indexOf('function bStakeTaiwanLive(it){');
  const liveEnd = indexSource.indexOf('// 卡片框色', liveStart);
  assert.ok(anomStart >= 0 && anomEnd > anomStart && liveStart >= 0 && liveEnd > liveStart, '找不到異常判定原始函式');
  const sandbox = {
    intlFor: () => intlState,
    crossTabCached: () => crossTabFixture(),
    leagueOf: () => league,
    bLeagueMeta: () => ({ league, label: 'MLB' }),
    doc: { activeDate: '2026-10-09' },
    window: { __baseballStakeIntegration: { gameFor: () => stakeGame } },
  };
  vm.runInNewContext(`${indexSource.slice(liveStart, liveEnd)}\n${indexSource.slice(anomStart, anomEnd)}\nthis.bAnomInfo = bAnomInfo;`, sandbox);
  return sandbox.bAnomInfo;
}

const unmarked = (extra = {}) => ({
  league: 'mlb', platformFlip: false, flipVanished: false, preGameSwap: false,
  closeOddsAway: 1.9, closeOddsHome: 1.9, ...extra,
});

test('未手標：只有台彩換邊、兩邊同向＝收斂＋單獨（台彩換邊不算對調）', () => {
  const info = loadBAnomInfoLive({ ls: 'away', lsw: 1 }, { favorite: 'away', favoriteFlipCount: 0 })(unmarked({ hdFav: 'away' }));
  assert.equal(info.lbl, '收斂');
});

test('未手標：Stake 讓分方換過邊、兩邊同向＝收斂＋對調', () => {
  const info = loadBAnomInfoLive({ ls: 'away', lsw: 1 }, { favorite: 'away', favoriteTransitions: [{ from: 'home', to: 'away' }] })(unmarked({ hdFav: 'away' }));
  assert.equal(info.lbl, '收斂＋對調');
});

test('未手標：讓分方相反且 Stake 換過邊＝顛倒＋對調', () => {
  const info = loadBAnomInfoLive({ ls: 'home', lsw: 0 }, { favorite: 'away', favoriteFlipCount: 1 })(unmarked({ hdFav: 'away' }));
  assert.equal(info.lbl, '顛倒＋對調');
});

test('已手標的場次不被即時資料改寫', () => {
  const load = () => loadBAnomInfoLive({ ls: 'away', lsw: 1 }, { favorite: 'away', favoriteFlipCount: 1 });
  assert.equal(load()(unmarked({ hdFav: 'away', flipState: 'none' })), null);
  assert.equal(load()(unmarked({ hdFav: 'away', flipState: 'converged_lottery', flipVanished: true })).lbl, '收斂');
});

test('Stake 尚未配對時不推測收斂', () => {
  const info = loadBAnomInfoLive({ ls: 'away', lsw: 1 }, null)(unmarked({ hdFav: 'away' }));
  assert.equal(info, null);
});

test('未結算異常卡片直接掛上決策條，已結算卡片不再顯示即時下注判定', () => {
  const { append, rendered } = loadAppendBAnomRecommendation();
  const root = { children: [], appendChild(child) { this.children.push(child); } };
  assert.equal(append(root, { settled: null }), rendered);
  assert.deepEqual(root.children, [rendered]);

  const settledRoot = { children: [], appendChild(child) { this.children.push(child); } };
  assert.equal(append(settledRoot, { settled: { awayScore: 2, homeScore: 1 } }), null);
  assert.deepEqual(settledRoot.children, []);
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

test('國際軸缺少當日條目時仍直接顯示玩運彩讓分方', () => {
  const intlFor = loadIntlFor({ games: {} }, [{
    league: 'MLB', date: '2026-09-30', time: '08:00',
    awayTeam: '紅襪', homeTeam: '洋基',
    lotteryHandicap: { favSide: 'home', line: 1.5, src: '運彩' },
  }]);

  const state = intlFor({
    type: 'match', league: 'mlb', gameTime: '08:00',
    away: '紅襪', home: '洋基',
  });

  assert.equal(state.is, null);
  assert.equal(state.ls, 'home');
  assert.equal(state.ll, 1.5);
  assert.equal(state.lsLive, false);
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
