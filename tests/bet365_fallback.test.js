'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseBet365Hub,
  augmentUpcoming,
  mergeOfficialRows,
} = require('../bet365_fallback.js');

function fixture(category, odds, fixtureId = '198609828') {
  return `
    <li data-item-category2="MLB"
        data-item-category3="${category}"
        data-item-name="ARI Diamondbacks @ PIT Pirates"
        data-fixture-id="${fixtureId}">
      <span data-utc="2026-07-28T22:40:00Z"></span>
      ${odds.map(({ variant, decimal, text }) => `
        <a data-item-variant="${variant}" data-item-odds="${decimal}">
          <span>${text}</span>
        </a>`).join('')}
    </li>`;
}

test('Bet365 hub parser converts all three markets without reversing home and away', () => {
  const html = [
    fixture('Money Line', [
      { variant: 'Away Win', decimal: '1.96', text: '1 -104' },
      { variant: 'Home Win', decimal: '1.79', text: '2 -126' },
    ]),
    fixture('Money Line', [
      { variant: 'Away Win', decimal: '1.96', text: '1 -104' },
      { variant: 'Home Win', decimal: '1.79', text: '2 -126' },
    ]),
    fixture('Game Totals', [
      { variant: 'Over', decimal: '1.86', text: '9.0 -115' },
      { variant: 'Under', decimal: '1.86', text: '9.0 -115' },
    ], '198609830'),
    fixture('Run Line', [
      { variant: 'Away Win', decimal: '1.45', text: '+1.5 -218' },
      { variant: 'Home Win', decimal: '2.65', text: '-1.5 +165' },
    ], '198609829'),
  ].join('');

  const games = parseBet365Hub(html);
  assert.equal(games.length, 1);
  assert.deepEqual(games[0], {
    fixtureId: '198609828',
    awayTeam: '響尾蛇',
    homeTeam: '海盜',
    startISO: '2026-07-29T06:40:00+08:00',
    ml: { away: 1.96, home: 1.79 },
    hd: { away: 0.45, home: 1.65, line: 1.5 },
    ou: { over: 0.86, under: 0.86, line: 9 },
  });
});

test('Bet365 fallback adds the missing first game of a doubleheader with a stable archive-style id', () => {
  const upcoming = [{
    id: 172895,
    league: 'mlb',
    startISO: '2026-07-29T07:10:00+08:00',
    time: '2026-07-29 07:10',
    awayTeam: '守護者',
    homeTeam: '紅人',
  }];
  const official = [
    {
      fixtureId: 'early',
      awayTeam: '守護者',
      homeTeam: '紅人',
      startISO: '2026-07-29T01:40:00+08:00',
      ml: { away: 2.3, home: 1.62 },
      hd: { away: 0.8, home: 1.1, line: 1.5 },
      ou: { over: 0.9, under: 0.9, line: 9 },
    },
    {
      fixtureId: 'late',
      awayTeam: '守護者',
      homeTeam: '紅人',
      startISO: '2026-07-29T07:10:00+08:00',
      ml: { away: 1.7, home: 2.1 },
      hd: { away: 1.1, home: 0.8, line: -1.5 },
      ou: { over: 0.9, under: 0.9, line: 9 },
    },
  ];

  const out = augmentUpcoming(upcoming, official, Date.parse('2026-07-28T15:00:00+08:00'));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, '172895@0140');
  assert.equal(out[0].startISO, '2026-07-29T01:40:00+08:00');
  assert.equal(out[0].bet365Fixture.fixtureId, 'early');
  assert.equal(out[1].id, 172895);
  assert.equal(out[1].bet365Fixture.fixtureId, 'late');
});

test('Bet365 parser rejects non-numeric external odds instead of accepting a false complete market', () => {
  const html = fixture('Money Line', [
    { variant: 'Away Win', decimal: 'not-a-number', text: '1 —' },
    { variant: 'Home Win', decimal: '1.79', text: '2 -126' },
  ]);
  const games = parseBet365Hub(html);
  assert.equal(games.length, 1);
  assert.equal(games[0].ml, undefined);
});

test('official snapshots prepend only real changes and retain their source', () => {
  const old = [{ home: 1.6, line: '1.5', away: 0.5, ts: 'old', src: 'bet365_official' }];
  const same = mergeOfficialRows(old, { home: 1.6, line: '1.5', away: 0.5 }, 'new');
  assert.equal(same, old);

  const changed = mergeOfficialRows(old, { home: 1.65, line: '1.5', away: 0.45 }, 'new');
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[0], {
    home: 1.65,
    line: '1.5',
    away: 0.45,
    ts: 'new',
    src: 'bet365_official',
  });
});
