'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { stabilizeIds, mergeSeasonGames } = require('../nhl_scraper.js');

const live = (time, extra = {}) => ({
  officialId: `NHL_20261009_雪崩@火焰_${time.replace(':', '')}`, league: 'NHL', date: '2026-10-09', time,
  away: '雪崩', home: '火焰', status: 'finished', awayScore: 7, homeScore: 3, ...extra,
});

test('開賽後玩運彩把時間改成 09:04：沿用先前的代號 _0900', () => {
  const fresh = [live('09:04')];
  stabilizeIds(fresh, [live('09:00', { status: 'upcoming', awayScore: null, homeScore: null })]);
  assert.equal(fresh[0].officialId, 'NHL_20261009_雪崩@火焰_0900');
  assert.equal(fresh[0].time, '09:04');   // 顯示時間照新的，只有代號固定
});

test('先前缺時間（_0000）時改用有時間的新代號；不同對戰不受影響', () => {
  const fresh = [live('09:00'), { ...live('10:00'), officialId: 'NHL_20261009_油人@加人_1000', away: '油人', home: '加人' }];
  stabilizeIds(fresh, [{ ...live('00:00'), officialId: 'NHL_20261009_雪崩@火焰_0000' }]);
  assert.equal(fresh[0].officialId, 'NHL_20261009_雪崩@火焰_0900');
  assert.equal(fresh[1].officialId, 'NHL_20261009_油人@加人_1000');
});

test('整季檔：同一場換了代號仍只留一筆、保留原代號；舊檔已重複的會合併', () => {
  const season = (sid, extra = {}) => ({ sid, date: '2026-10-09', league: 'NHL', awayTeam: '雪崩', homeTeam: '火焰', awayScore: 7, homeScore: 3, ...extra });
  const merged = mergeSeasonGames(
    [season('NHL_20261009_雪崩@火焰_0904', { decidedBy: 'OT' }), season('NHL_20261009_雪崩@火焰_0900')],
    [],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sid, 'NHL_20261009_雪崩@火焰_0900');

  const updated = mergeSeasonGames([season('NHL_20261009_雪崩@火焰_0900')], [live('09:04', { homeScore: 4 })]);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].sid, 'NHL_20261009_雪崩@火焰_0900');
  assert.equal(updated[0].homeScore, 4);
});
