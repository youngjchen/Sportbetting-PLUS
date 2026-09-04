'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
const originalSetInterval = global.setInterval;
const originalFetch = global.fetch;
global.setInterval = () => 0;
global.fetch = async () => { throw new Error('network disabled in unit test'); };

const odds = require('../odds-integration.js');

test.after(() => {
  dom.window.close();
  delete global.window;
  delete global.document;
  global.setInterval = originalSetInterval;
  global.fetch = originalFetch;
});

test('auto arrange unions BetExplorer fallback without duplicating the Titan doubleheader game', () => {
  assert.equal(typeof odds.oddsPortalAutoGames, 'function', '尚未把 BetExplorer 摘要轉成排卡候選');
  assert.equal(typeof odds.mergeAutoArrangeGames, 'function', '尚未聯集 Titan 與 BetExplorer 排卡候選');

  const titan = [{
    id: 173329,
    league: 'mlb',
    awayTeam: '響尾蛇',
    homeTeam: '巨人',
    startISO: '2026-08-30T04:05:00+08:00',
  }];
  const summary = { games: {
    early: {
      eventId: '8MwEu99s', league: 'mlb', date: '2026-08-30', startTime: '04:05',
      awayTeam: '響尾蛇', homeTeam: '巨人',
      markets: { hd: { open: { favorite: 'home', line: 1.5 } } },
    },
    late: {
      eventId: 'rwubIuCG', league: 'mlb', date: '2026-08-30', startTime: '10:05',
      awayTeam: '響尾蛇', homeTeam: '巨人',
      // 真實摘要曾出現 hd.favorite=home、但獨贏明確是響尾蛇低賠；排卡應沿用既有獨贏熱門規則。
      markets: {
        ml: { open: { away: 1.80, home: 2.00 } },
        hd: { open: { favorite: 'home', line: 1.5 } },
      },
    },
  } };

  const fallback = odds.oddsPortalAutoGames(summary, '2026-08-30');
  const merged = odds.mergeAutoArrangeGames(titan, fallback);
  assert.deepEqual(merged.map(odds.gStartHHMM), ['04:05', '10:05']);

  const missing = odds.gamesToAdd([
    { type: 'match', away: '響尾蛇', home: '巨人', gameTime: '04:05' },
  ], merged);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'be:rwubIuCG');
  assert.equal(missing[0]._autoFavTeam, '響尾蛇');
});

test('auto arrange uses the official schedule as whitelist and collapses temporary Bet365 duplicates', () => {
  assert.equal(typeof odds.filterAutoArrangeGames, 'function', '尚未把官方賽程設為自動排盤白名單');
  const candidates = [
    { id: 173405, league: 'mlb', awayTeam: '藍鳥', homeTeam: '皇家', startISO: '2026-09-05T08:10:00+08:00' },
    { id: 'b365:200667346', league: 'mlb', awayTeam: '藍鳥', homeTeam: '皇家', startISO: '2026-09-05T08:10:00+08:00' },
    { id: 'be:ghost', league: 'mlb', awayTeam: '紅雀', homeTeam: '道奇', startISO: '2026-09-05T10:10:00+08:00' },
    { id: 'be:wrong-time', league: 'mlb', awayTeam: '運動家', homeTeam: '水手', startISO: '2026-09-05T09:40:00+08:00' },
    { id: 173409, league: 'mlb', awayTeam: '運動家', homeTeam: '水手', startISO: '2026-09-05T10:10:00+08:00' },
    { id: 173410, league: 'mlb', awayTeam: '國民', homeTeam: '道奇', startISO: '2026-09-05T10:10:00+08:00' },
  ];
  const official = [
    { _mlb: true, date: '2026-09-05', time: '08:10', awayTeam: '藍鳥', homeTeam: '皇家' },
    { _mlb: true, date: '2026-09-05', time: '10:10', awayTeam: '運動家', homeTeam: '水手' },
    { _mlb: true, date: '2026-09-05', time: '10:10', awayTeam: '國民', homeTeam: '道奇' },
    // 玩運彩資料若殘留錯場，也不能反過來污染已成功載入的 MLB 官方名單。
    { league: 'MLB', date: '2026-09-05', time: '10:10', awayTeam: '紅雀', homeTeam: '道奇' },
  ];

  const kept = odds.filterAutoArrangeGames(candidates, official, '2026-09-05');

  assert.deepEqual(kept.map(game => game.id), [173405, 173409, 173410]);
});

test('feed dedupe does not collapse two real same-pair games that start within two hours', () => {
  const games = [
    { id: 1, league: 'mlb', awayTeam: '老虎', homeTeam: '守護者', startISO: '2026-09-05T08:10:00+08:00' },
    { id: 2, league: 'mlb', awayTeam: '老虎', homeTeam: '守護者', startISO: '2026-09-05T09:40:00+08:00' },
  ];

  assert.deepEqual(odds.dedupeFeedGames(games).map(game => game.id), [1, 2]);
});

test('schedule-backed healing removes an empty ghost card that is absent from the official MLB slate', () => {
  window.__psFusion = {
    getData: () => [{
      _mlb: true, date: '2026-09-05', time: '10:10',
      awayTeam: '國民', homeTeam: '道奇',
    }],
  };
  global.doc = { activeDate: '2026-09-05' };
  global.state = { items: [{
    id: 99, type: 'match', away: '紅雀', home: '道奇', gameTime: '10:10',
    mlAway: { lights: 0 }, mlHome: { lights: 0 }, hdGive: { lights: 0 },
    hdRecv: { lights: 0 }, over: { lights: 0 }, under: { lights: 0 },
  }] };
  global.leagueOf = () => 'mlb';
  odds._setFeed({ matches: {
    ghost: {
      id: 'be:ghost', league: 'mlb', awayTeam: '紅雀', homeTeam: '道奇',
      startISO: '2026-09-05T10:10:00+08:00',
    },
  } });

  assert.equal(odds.healDupCards(), true);
  assert.deepEqual(global.state.items, []);

  delete window.__psFusion;
  for (const name of ['doc', 'state', 'leagueOf']) delete global[name];
});

test('schedule-backed healing preserves a non-official card once it contains user data', () => {
  window.__psFusion = {
    getData: () => [{
      _mlb: true, date: '2026-09-05', time: '10:10',
      awayTeam: '國民', homeTeam: '道奇',
    }],
  };
  global.doc = { activeDate: '2026-09-05' };
  global.state = { items: [{
    id: 100, type: 'match', away: '紅雀', home: '道奇', gameTime: '10:10',
    mlAway: { lights: 0, bet: true }, mlHome: { lights: 0 }, hdGive: { lights: 0 },
    hdRecv: { lights: 0 }, over: { lights: 0 }, under: { lights: 0 },
  }] };
  global.leagueOf = () => 'mlb';
  odds._setFeed({ matches: {} });

  assert.equal(odds.healDupCards(), false);
  assert.equal(global.state.items.length, 1, '有下注／點燈資料的卡不可自動刪除');

  delete window.__psFusion;
  for (const name of ['doc', 'state', 'leagueOf']) delete global[name];
});

test('new fallback card receives BetExplorer opening odds immediately after auto arrange', () => {
  const summary = {
    games: {
      late: {
        eventId: 'rwubIuCG', league: 'mlb', date: '2026-08-30', startTime: '10:05',
        awayTeam: '響尾蛇', homeTeam: '巨人',
        markets: { ml: { open: { away: 1.80, home: 2.00 } } },
      },
    },
  };
  let appliedAfterAdd = false;
  window.__oddsPortalIntegration = {
    _getFeed: () => summary,
    autoApplyOdds: () => { appliedAfterAdd = global.state.items.some(it => it.gameTime === '10:05'); },
  };
  global.doc = { activeDate: '2026-08-30' };
  global.state = { items: [] };
  global.uid = 1;
  global.LEAGUES = { mlb: { teams: ['響尾蛇', '巨人'], color: '#123' } };
  global.snapshot = () => {};
  global.autoLayout = () => {};
  global.closeMore = () => {};
  global.alert = () => {};
  odds._setFeed({ matches: {} });

  odds.autoArrangeFromFeed(true);

  assert.equal(global.state.items.length, 1);
  assert.equal(global.state.items[0].gameTime, '10:05');
  assert.equal(appliedAfterAdd, true, '新卡建立後應立即呼叫初盤填入');

  delete window.__oddsPortalIntegration;
  for (const name of ['doc', 'state', 'uid', 'LEAGUES', 'snapshot', 'autoLayout', 'closeMore', 'alert']) delete global[name];
});
