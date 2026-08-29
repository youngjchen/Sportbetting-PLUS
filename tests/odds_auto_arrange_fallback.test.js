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
