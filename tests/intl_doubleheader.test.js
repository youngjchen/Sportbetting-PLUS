'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildIntlState } = require('../index.js');

test('intl_state keeps same-day doubleheader games separate by start time', () => {
  const original = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-doubleheader-'));
  fs.mkdirSync(path.join(dir, 'data'));
  try {
    process.chdir(dir);
    fs.writeFileSync(path.join('data', 'pregame_data.json'), JSON.stringify([
      {
        league: 'MLB',
        date: '2026-07-29',
        time: '01:40',
        awayTeam: '守護者',
        homeTeam: '紅人',
        lotteryHandicap: { favSide: 'home', line: 1.5, src: '運彩' },
      },
      {
        league: 'MLB',
        date: '2026-07-29',
        time: '07:10',
        awayTeam: '守護者',
        homeTeam: '紅人',
        lotteryHandicap: { favSide: 'away', line: 1.5, src: '運彩' },
      },
    ]));
    fs.writeFileSync(path.join('data', 'lottery_series.json'), JSON.stringify({
      games: {
        'MLB_20260729_CLE@CIN_0140': {
          league: 'MLB',
          date: '2026-07-29',
          awayTeam: '守護者',
          homeTeam: '紅人',
          pts: [{ side: 'home', line: 1.5, t: '2026-07-28T08:00:00Z' }],
        },
        'MLB_20260729_CLE@CIN_0710': {
          league: 'MLB',
          date: '2026-07-29',
          awayTeam: '守護者',
          homeTeam: '紅人',
          pts: [{ side: 'away', line: 1.5, t: '2026-07-28T08:00:00Z' }],
        },
      },
    }));
    fs.writeFileSync(path.join('data', 'intl_state.json'), '{"updated":null,"games":{}}');

    buildIntlState({
      matches: {
        early: {
          league: 'mlb',
          awayTeam: '守護者',
          homeTeam: '紅人',
          startISO: '2026-07-29T01:40:00+08:00',
          ml: {},
          _hdTs: [{ line: 1.5, live: false, hhmm: '15:00', md: '7-28' }],
        },
        late: {
          league: 'mlb',
          awayTeam: '守護者',
          homeTeam: '紅人',
          startISO: '2026-07-29T07:10:00+08:00',
          ml: {},
          _hdTs: [{ line: -1.5, live: false, hhmm: '15:00', md: '7-28' }],
        },
      },
    }, '2026-07-28T16:00:00+08:00');

    const state = JSON.parse(fs.readFileSync(path.join('data', 'intl_state.json'), 'utf8'));
    const base = 'mlb|2026-07-29|守護者|紅人';
    assert.equal(state.games[base], undefined);
    assert.equal(state.games[`${base}|01:40`].is, 'home');
    assert.equal(state.games[`${base}|01:40`].ls, 'home');
    assert.equal(state.games[`${base}|07:10`].is, 'away');
    assert.equal(state.games[`${base}|07:10`].ls, 'away');
  } finally {
    process.chdir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('intl_state removes a stale timed entry when a reused Titan id has no current handicap evidence', () => {
  const original = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-reused-id-'));
  fs.mkdirSync(path.join(dir, 'data'));
  try {
    process.chdir(dir);
    fs.writeFileSync(path.join('data', 'pregame_data.json'), '[]');
    fs.writeFileSync(path.join('data', 'lottery_series.json'), '{"games":{}}');
    fs.writeFileSync(path.join('data', 'intl_state.json'), JSON.stringify({
      updated: '2026-07-28T15:00:00+08:00',
      games: {
        'mlb|2026-07-29|守護者|紅人|01:40': {
          is: 'away',
          il: 1.5,
          u: '2026-07-28T15:00:00+08:00',
        },
      },
    }));

    buildIntlState({
      matches: {
        early: {
          league: 'mlb',
          awayTeam: '守護者',
          homeTeam: '紅人',
          startISO: '2026-07-29T01:40:00+08:00',
          titanIdReusedFrom: '172884@0710',
          ml: {},
          hd: { bet365: null },
          _hdTs: [{ line: 1.5, live: false, hhmm: '15:00', md: '7-27' }],
        },
        late: {
          league: 'mlb',
          awayTeam: '守護者',
          homeTeam: '紅人',
          startISO: '2026-07-29T07:10:00+08:00',
          ml: {},
          _hdTs: [{ line: -1.5, live: false, hhmm: '15:00', md: '7-28' }],
        },
      },
    }, '2026-07-28T16:00:00+08:00');

    const state = JSON.parse(fs.readFileSync(path.join('data', 'intl_state.json'), 'utf8'));
    const base = 'mlb|2026-07-29|守護者|紅人';
    assert.equal(state.games[`${base}|01:40`], undefined);
    assert.equal(state.games[`${base}|07:10`].is, 'away');
  } finally {
    process.chdir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
