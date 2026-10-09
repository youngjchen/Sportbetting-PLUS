'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'nba.html'), 'utf8');

function loadLineMove(doc) {
  const start = source.indexOf('const BB_PLATFORMS = ');
  const end = source.indexOf('function collectCrossTab(leagueFilter){', start);
  assert.ok(start >= 0 && end > start, '找不到讓分級距原始程式');
  const sandbox = { doc, window: {}, nbaSeriesCache: {}, seriesCache: {} };
  vm.runInNewContext(`${source.slice(start, end)}
this.api = { bbPlatformLine, bbMoveGroup, bbSnapScore, collectLineMoves, BB_GROUPS };`, sandbox);
  return sandbox.api;
}

const line = (openFav, openLine, closeFav, closeLine, closeTotal = 220.5) => ({ openFav, openLine, closeFav, closeLine, closeTotal, points: 2 });

test('分組：加深／縮小以 2 分為界，1.5 分以內算微調，讓分方不同算換邊', () => {
  const { bbMoveGroup } = loadLineMove({});
  assert.equal(bbMoveGroup(line('home', 5.5, 'home', 7.5)), 'deeper');
  assert.equal(bbMoveGroup(line('home', 5.5, 'home', 3.5)), 'shallower');
  assert.equal(bbMoveGroup(line('home', 5.5, 'home', 7)), 'small');
  assert.equal(bbMoveGroup(line('home', 5.5, 'home', 4)), 'small');
  assert.equal(bbMoveGroup(line('home', 5.5, 'home', 5.5)), 'small');
  assert.equal(bbMoveGroup(line('home', 1.5, 'away', 1.5)), 'swap');
  assert.equal(bbMoveGroup(null), null);
});

test('開收盤：取第一筆與最後一筆有效讓分，收盤大小分取最後一筆', () => {
  const { bbPlatformLine } = loadLineMove({});
  const result = bbPlatformLine([
    { at: '2026-10-03T10:00:00Z', fav: 'home', line: 3.5, total: 229.5 },
    { at: '2026-10-03T12:00:00Z', fav: null, line: NaN, total: NaN },
    { at: '2026-10-03T22:00:00Z', fav: 'home', line: 2.5, total: 228.5 },
  ]);
  assert.equal(result.openFav, 'home');
  assert.equal(result.openLine, 3.5);
  assert.equal(result.closeLine, 2.5);
  assert.equal(result.closeTotal, 228.5);
  assert.equal(bbPlatformLine([]), null);
});

test('統計：熱門用獨贏熱門，讓分過盤用該平台收盤線，NBA／WNBA 分開', () => {
  const doc = {
    boards: { '2026-10-08': { items: [
      { id: 'NBA_A', settled: { awayScore: 100 }, lineSnap: { stake: line('home', 5.5, 'home', 7.5, 210.5), taiwan: line('home', 5.5, 'home', 6.5, 212.5), mlFav: 'home' } },
      { id: 'WNBA_B', settled: { awayScore: 80 }, lineSnap: { stake: line('away', 3.5, 'away', 3.5), mlFav: 'away' } },
    ] } },
    games: [
      { sid: 'NBA_A', league: 'NBA', awayScore: 100, homeScore: 107, totBasis: 211.5 },
      { sid: 'WNBA_B', league: 'WNBA', awayScore: 80, homeScore: 70, totBasis: 160.5 },
    ],
  };
  const { collectLineMoves } = loadLineMove(doc);
  const nba = collectLineMoves('NBA');
  assert.equal(nba.total, 1);
  const deeper = nba.out.stake.deeper;
  assert.deepEqual([deeper.n, deeper.fw, deeper.fwN], [1, 1, 1]);   // 主隊熱門贏 7 分
  assert.deepEqual([deeper.cov, deeper.covN], [0, 1]);              // 讓 7.5 沒過
  assert.deepEqual([deeper.ov, deeper.ovN], [0, 1]);                // 207 < 210.5
  assert.equal(nba.out.taiwan.small.cov, 1);                        // 台彩收盤讓 6.5 → 過盤
  const detail = deeper.games[0];                                   // 點列展開的明細
  assert.equal(deeper.games.length, 1);
  assert.equal(detail.move, '主讓5.5 → 主讓7.5');
  assert.deepEqual([detail.hd, detail.tot, detail.fv], ['nocover', 'under', 'home']);
  const wnba = collectLineMoves('WNBA');
  assert.equal(wnba.total, 1);
  assert.equal(wnba.out.stake.small.fw, 1);
});
