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

test('KBO auto arrange canonicalizes source aliases before whitelist and dedupe', () => {
  const aliases = {
    '雙子': 'LG雙子', '巫師': 'KT巫師', '登陸者': 'SSG登陸者',
    '恐龍': 'NC恐龍', '樂天': '樂天巨人', '華老鷹': '韓華鷹', '培證': '培證英雄',
  };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  const titan = [
    { id: 175993, league: 'kbo', awayTeam: '斗山熊', homeTeam: 'SSG登陸者', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 175994, league: 'kbo', awayTeam: '韓華鷹', homeTeam: '樂天巨人', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 175995, league: 'kbo', awayTeam: '三星獅', homeTeam: 'LG雙子', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 175996, league: 'kbo', awayTeam: 'NC恐龍', homeTeam: '培證英雄', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 175997, league: 'kbo', awayTeam: 'KT巫師', homeTeam: '起亞虎', startISO: '2026-09-05T16:00:00+08:00' },
  ];
  const portal = [
    { id: 'be:2XvdaKWi', league: 'kbo', awayTeam: '斗山熊', homeTeam: '登陸者', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 'be:zow4cb14', league: 'kbo', awayTeam: '華老鷹', homeTeam: '樂天', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 'be:lhc9yHvo', league: 'kbo', awayTeam: '三星獅', homeTeam: '雙子', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 'be:vwzLgG0T', league: 'kbo', awayTeam: '恐龍', homeTeam: '培證', startISO: '2026-09-05T16:00:00+08:00' },
    { id: 'be:WCWCexWG', league: 'kbo', awayTeam: '巫師', homeTeam: '起亞虎', startISO: '2026-09-05T16:00:00+08:00' },
  ];
  const schedule = [
    { league: 'KBO', date: '2026-09-05', time: '16:00', awayTeam: '斗山熊', homeTeam: '登陸者' },
    { league: 'KBO', date: '2026-09-05', time: '16:00', awayTeam: '華老鷹', homeTeam: '樂天' },
    { league: 'KBO', date: '2026-09-05', time: '16:00', awayTeam: '三星獅', homeTeam: '雙子' },
    { league: 'KBO', date: '2026-09-05', time: '16:00', awayTeam: '恐龍', homeTeam: '培證' },
    { league: 'KBO', date: '2026-09-05', time: '16:00', awayTeam: '巫師', homeTeam: '起亞虎' },
  ];

  try {
    const merged = odds.mergeAutoArrangeGames(titan, portal);
    const kept = odds.filterAutoArrangeGames(merged, schedule, '2026-09-05');
    assert.deepEqual(kept.map(game => game.id), [175993, 175994, 175995, 175996, 175997]);
    assert.deepEqual(kept.map(game => `${game.awayTeam}@${game.homeTeam}`), [
      '斗山熊@SSG登陸者', '韓華鷹@樂天巨人', '三星獅@LG雙子',
      'NC恐龍@培證英雄', 'KT巫師@起亞虎',
    ]);
  } finally {
    delete global.canonicalTeamName;
  }
});

test('KBO fallback favorite follows the canonicalized team name', () => {
  const aliases = { '華老鷹': '韓華鷹', '樂天': '樂天巨人' };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  try {
    const kept = odds.filterAutoArrangeGames([{
      id: 'be:zow4cb14', league: 'kbo', awayTeam: '華老鷹', homeTeam: '樂天',
      startISO: '2026-09-05T16:00:00+08:00', _autoFavTeam: '華老鷹',
    }], [{
      league: 'KBO', date: '2026-09-05', time: '16:00', awayTeam: '華老鷹', homeTeam: '樂天',
    }], '2026-09-05');
    assert.equal(kept[0]._autoFavTeam, '韓華鷹');
  } finally {
    delete global.canonicalTeamName;
  }
});

test('sole official matchup time overrides a five-hour KBO odds-source error', () => {
  const aliases = { '恐龍': 'NC恐龍', '培證': '培證英雄' };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  window.__psFusion = { getData: () => [{
    league: 'KBO', date: '2026-09-06', time: '13:00', awayTeam: '恐龍', homeTeam: '培證',
  }] };
  try {
    const sourceGame = {
      id: 176001, league: 'kbo', awayTeam: 'NC恐龍', homeTeam: '培證英雄',
      startISO: '2026-09-06T18:00:00+08:00',
    };
    assert.equal(odds.authTimeFor(sourceGame, '2026-09-06'), '13:00');
  } finally {
    delete window.__psFusion;
    delete global.canonicalTeamName;
  }
});

test('auto arrange keeps a sole official KBO matchup despite a five-hour odds-source error', () => {
  const aliases = { '恐龍': 'NC恐龍', '培證': '培證英雄' };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  try {
    const kept = odds.filterAutoArrangeGames([{
      id: 176001, league: 'kbo', awayTeam: 'NC恐龍', homeTeam: '培證英雄',
      startISO: '2026-09-06T18:00:00+08:00',
    }], [{
      league: 'KBO', date: '2026-09-06', time: '13:00', awayTeam: '恐龍', homeTeam: '培證',
    }], '2026-09-06');

    assert.deepEqual(kept.map(game => game.id), [176001]);
  } finally {
    delete global.canonicalTeamName;
  }
});

test('sole official matchup collapses disagreeing wrong-time odds sources to one card candidate', () => {
  const aliases = { '恐龍': 'NC恐龍', '培證': '培證英雄' };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  try {
    const kept = odds.filterAutoArrangeGames([
      {
        id: 176001, league: 'kbo', awayTeam: 'NC恐龍', homeTeam: '培證英雄',
        startISO: '2026-09-06T18:00:00+08:00',
      },
      {
        id: 'be:wrong-time', league: 'kbo', awayTeam: '恐龍', homeTeam: '培證',
        startISO: '2026-09-06T17:30:00+08:00',
      },
    ], [{
      league: 'KBO', date: '2026-09-06', time: '13:00', awayTeam: '恐龍', homeTeam: '培證',
    }], '2026-09-06');

    assert.deepEqual(kept.map(game => game.id), [176001]);
  } finally {
    delete global.canonicalTeamName;
  }
});

test('schedule healing moves an existing KBO card from a wrong source time to the sole official time', () => {
  const aliases = { '恐龍': 'NC恐龍', '培證': '培證英雄' };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  window.__psFusion = { getData: () => [{
    league: 'KBO', date: '2026-09-06', time: '13:00', awayTeam: '恐龍', homeTeam: '培證',
  }] };
  global.doc = { activeDate: '2026-09-06' };
  global.state = { items: [{
    id: 1, type: 'match', league: 'kbo', away: 'NC恐龍', home: '培證英雄',
    gameTime: '18:00', oddsId: 176001,
    mlAway: { lights: 0 }, mlHome: { lights: 0 }, hdGive: { lights: 0 },
    hdRecv: { lights: 0 }, over: { lights: 0 }, under: { lights: 0 },
  }] };
  odds._setFeed({ matches: { 176001: {
    id: 176001, league: 'kbo', awayTeam: 'NC恐龍', homeTeam: '培證英雄',
    startISO: '2026-09-06T18:00:00+08:00',
  } } });

  try {
    assert.equal(odds.healDupCards(), true);
    assert.equal(global.state.items[0].gameTime, '13:00');
    assert.equal(global.state.items[0].oddsId, 176001);
  } finally {
    delete window.__psFusion;
    for (const name of ['canonicalTeamName', 'doc', 'state']) delete global[name];
  }
});

test('auto arrange recognizes an existing corrected-time card when the sole odds source still has the wrong time', () => {
  const aliases = { '恐龍': 'NC恐龍', '培證': '培證英雄' };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  window.__psFusion = { getData: () => [{
    league: 'KBO', date: '2026-09-06', time: '13:00', awayTeam: '恐龍', homeTeam: '培證',
  }] };
  try {
    const missing = odds.gamesToAdd([{
      id: 1, type: 'match', league: 'kbo', away: 'NC恐龍', home: '培證英雄', gameTime: '13:00',
    }], [{
      id: 176001, league: 'kbo', awayTeam: 'NC恐龍', homeTeam: '培證英雄',
      startISO: '2026-09-06T18:00:00+08:00',
    }]);

    assert.deepEqual(missing, []);
  } finally {
    delete window.__psFusion;
    delete global.canonicalTeamName;
  }
});

test('schedule healing folds an existing short-name KBO duplicate into one canonical card', () => {
  const aliases = { '華老鷹': '韓華鷹', '樂天': '樂天巨人' };
  global.canonicalTeamName = (league, name) => league === 'kbo' ? (aliases[name] || name) : name;
  global.leagueOf = card => card.away === '韓華鷹' || card.home === '樂天巨人' ? 'kbo' : 'zz';
  window.__psFusion = { getData: () => [{
    league: 'KBO', date: '2026-09-05', time: '16:00', awayTeam: '華老鷹', homeTeam: '樂天',
  }] };
  window.__oddsPortalIntegration = { _getFeed: () => ({ games: { kbo: {
    eventId: 'zow4cb14', league: 'kbo', date: '2026-09-05', startTime: '16:00',
    awayTeam: '華老鷹', homeTeam: '樂天',
  } } }) };
  global.doc = { activeDate: '2026-09-05' };
  global.state = { items: [
    { id: 1, type: 'match', away: '韓華鷹', home: '樂天巨人', gameTime: '16:00', oddsId: 175994,
      mlAway: { lights: 0 }, mlHome: { lights: 0 }, hdGive: { lights: 0 }, hdRecv: { lights: 0 }, over: { lights: 0 }, under: { lights: 0 } },
    { id: 2, type: 'match', away: '華老鷹', home: '樂天', gameTime: '16:00', oddsId: 'be:zow4cb14',
      mlAway: { lights: 0 }, mlHome: { lights: 0 }, hdGive: { lights: 0 }, hdRecv: { lights: 0 }, over: { lights: 0 }, under: { lights: 0 } },
  ] };
  odds._setFeed({ matches: { 175994: {
    id: 175994, league: 'kbo', awayTeam: '韓華鷹', homeTeam: '樂天巨人',
    startISO: '2026-09-05T16:00:00+08:00',
  } } });

  try {
    assert.equal(odds.healDupCards(), true);
    assert.equal(global.state.items.length, 1);
    assert.equal(global.state.items[0].away, '韓華鷹');
    assert.equal(global.state.items[0].home, '樂天巨人');
  } finally {
    delete window.__psFusion;
    delete window.__oddsPortalIntegration;
    for (const name of ['canonicalTeamName', 'leagueOf', 'doc', 'state']) delete global[name];
  }
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
