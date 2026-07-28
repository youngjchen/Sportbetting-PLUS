'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handleScheduleMove, stripReusedMl } = require('../index.js');

function oldEntry() {
  return {
    id: 172884,
    firstSeen: '2026-07-27T07:11:19+08:00',
    league: 'mlb',
    startISO: '2026-07-28T07:10:00+08:00',
    time: '2026-07-28 07:10',
    awayTeam: '守護者',
    homeTeam: '紅人',
    ml: { bet365: { open: { away: 2.35, home: 1.63 }, live: [] } },
    hd: { bet365: [{ away: 0.65, line: '1.5', home: 1.3 }] },
    ou: { bet365: [{ over: 0.95, line: '8.5', under: 0.87 }] },
  };
}

test('Titan id reused on a different date archives the old game and resets all markets', () => {
  const entry = oldEntry();
  const log = { matches: { 172884: entry } };
  const current = {
    id: 172884,
    league: 'mlb',
    startISO: '2026-07-29T01:40:00+08:00',
    time: '2026-07-29 01:40',
  };
  const stamp = '2026-07-28T16:03:34+08:00';

  const result = handleScheduleMove(log, entry, current, {}, stamp, {});

  assert.equal(result, 'split');
  assert.equal(log.matches['172884@0710'].startISO, '2026-07-28T07:10:00+08:00');
  assert.deepEqual(log.matches['172884@0710'].hd.bet365, [
    { away: 0.65, line: '1.5', home: 1.3 },
  ]);
  assert.equal(entry.firstSeen, stamp);
  assert.equal(entry.titanIdReusedFrom, '172884@0710');
  assert.deepEqual(entry.ml, {});
  assert.deepEqual(entry.hd, { bet365: null });
  assert.deepEqual(entry.ou, { bet365: null });
});

test('reused Titan id does not re-import the archived game moneyline as the new game', () => {
  const entry = oldEntry();
  const log = { matches: { 172884: entry } };
  handleScheduleMove(log, entry, {
    id: 172884,
    league: 'mlb',
    startISO: '2026-07-29T01:40:00+08:00',
    time: '2026-07-29 01:40',
  }, {}, 'stamp', {});

  const stale = stripReusedMl({
    bet365: {
      openHome: 1.63,
      openAway: 2.35,
      liveHome: 1.63,
      liveAway: 2.35,
    },
  }, log, entry);
  assert.deepEqual(stale, {});

  const changed = stripReusedMl({
    bet365: {
      openHome: 1.63,
      openAway: 2.35,
      liveHome: 1.8,
      liveAway: 2.1,
    },
  }, log, entry);
  assert.deepEqual(changed.bet365, {
    openHome: 1.8,
    openAway: 2.1,
    liveHome: 1.8,
    liveAway: 2.1,
  });
});

test('same-date single-game reschedule keeps the existing market history', () => {
  const entry = oldEntry();
  const log = { matches: { 172884: entry } };
  const current = {
    id: 172884,
    league: 'mlb',
    startISO: '2026-07-28T10:10:00+08:00',
    time: '2026-07-28 10:10',
  };

  const result = handleScheduleMove(log, entry, current, {}, 'stamp', {});

  assert.equal(result, 'follow');
  assert.equal(log.matches['172884@0710'], undefined);
  assert.ok(entry.ml.bet365);
});
