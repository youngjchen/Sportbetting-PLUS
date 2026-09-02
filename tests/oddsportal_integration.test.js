'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const {
  findOddsPortalGame,
  applySettlementDefaults,
} = require('../oddsportal-integration.js');

const feed = {
  source: 'OddsPortal',
  bookmaker: 'Stake.com',
  games: {
    'mlb|2026-08-01|金鶯|費城人|07:05|first': {
      eventId: 'first', league: 'mlb', date: '2026-08-01', startTime: '07:05',
      awayTeam: '金鶯', homeTeam: '費城人',
      handicapSwitch: { ever: true, count: 1, first: { detectedAt: '2026-07-31T20:05:00+08:00' }, last: { detectedAt: '2026-07-31T20:05:00+08:00' } },
      markets: {
        ml: { open: { away: 2, home: 1.82 }, close: { away: 1.97, home: 1.84, final: true } },
        hd: { open: { line: -1.5, away: 2.5, home: 1.53 }, close: { line: 1.5, away: 1.52, home: 2.55, final: true } },
        ou: { open: { line: 8.5, over: 1.91, under: 1.91 }, close: { line: 9, over: 1.87, under: 1.95 } },
      },
    },
    'mlb|2026-08-01|金鶯|費城人|10:05|second': {
      eventId: 'second', league: 'mlb', date: '2026-08-01', startTime: '10:05',
      awayTeam: '金鶯', homeTeam: '費城人', handicapSwitch: { ever: false, count: 0 }, markets: {},
    },
  },
};

test('doubleheader matching uses start time and never picks the wrong game', () => {
  const game = findOddsPortalGame(feed, {
    type: 'match', away: '金鶯', home: '費城人', gameTime: '10:05', league: 'MLB',
  }, '2026-08-01');
  assert.equal(game.eventId, 'second');
});

test('duplicate same-time BetExplorer rows select the newest observation instead of stale swap evidence', () => {
  const duplicateFeed = { games: {
    stale: {
      eventId: 'stale', league: 'mlb', date: '2026-09-02', startTime: '06:40',
      awayTeam: '大都會', homeTeam: '光芒', observedAt: '2026-09-01T07:00:13+08:00',
      bet365: { side: 'home', flipEver: false, observedAt: '2026-09-01T07:00:13+08:00' },
    },
    fresh: {
      eventId: 'fresh', league: 'mlb', date: '2026-09-02', startTime: '06:40',
      awayTeam: '大都會', homeTeam: '光芒', observedAt: '2026-09-02T06:55:08+08:00',
      bet365: { side: 'home', flipEver: true, observedAt: '2026-09-02T06:55:08+08:00' },
    },
  } };

  const game = findOddsPortalGame(duplicateFeed, {
    type: 'match', away: '大都會', home: '光芒', gameTime: '06:40', league: 'MLB',
  }, '2026-09-02');

  assert.equal(game.eventId, 'fresh');
  assert.equal(game.bet365.flipEver, true);
});

test('settlement defaults never touch preGameSwap and copy all three market summaries without changing hdFav', () => {
  const card = { hdFav: 'away', preGameSwap: false };
  const game = feed.games['mlb|2026-08-01|金鶯|費城人|07:05|first'];

  applySettlementDefaults(card, game);

  // 2026-08-05 守門：對調=台彩軸，整合層永不寫 preGameSwap（曾汙染 12 場結算紀錄）
  assert.equal(card.preGameSwap, false);   // 夾具初始 false，整合層不得改動
  assert.equal(card.hdFav, 'away');
  assert.deepEqual(card.oddsPortal, {
    eventId: 'first',
    handicapSwitch: game.handicapSwitch,
    markets: game.markets,
  });
});

test('settlement UI checks the switch box, fills blank moneyline fields, and renders evidence as text', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="settleBody"><div id="settleOddsCalc"></div></div>
    <input id="settlePreSwap" type="checkbox">
    <div id="myHdWrap" style="display:none"></div>
    <input id="openOddsAway"><input id="openOddsHome" value="9.99">
    <input id="closeOddsAway"><input id="closeOddsHome">
  </body>`);
  const browser = {
    document: dom.window.document,
    doc: { activeDate: '2026-08-01' },
    fetch: async () => { throw new Error('not used'); },
    setInterval: () => 0,
  };
  try {
    const api = require('../oddsportal-integration.js').install(browser);
    api._setFeed(feed);
    browser.document.getElementById('settlePreSwap').addEventListener('change', () => {
      browser.document.getElementById('myHdWrap').style.display = 'block';
    });
    api.injectSettlement({
      type: 'match', away: '金鶯', home: '費城人', gameTime: '07:05', league: 'MLB',
    });

    // 2026-08-05 拆除自動打勾：對調勾=台彩軸，OddsPortal 軌永不代點（8/1 三場亂勾案）
    assert.equal(browser.document.getElementById('settlePreSwap').checked, false);
    assert.equal(browser.document.getElementById('myHdWrap').style.display, 'none');
    assert.equal(browser.document.getElementById('openOddsAway').value, '2');
    assert.equal(browser.document.getElementById('openOddsHome').value, '9.99');
    assert.equal(browser.document.getElementById('closeOddsAway').value, '1.97');
    // 2026-08-05 使用者鐵則：未定案（沒開打）的 close 絕不准填收盤欄、不准在證據卡當收盤顯示
    browser.document.getElementById('closeOddsAway').value = '';
    const feed2 = JSON.parse(JSON.stringify(feed));
    delete feed2.games['mlb|2026-08-01|金鶯|費城人|07:05|first'].markets.ml.close.final;
    api._setFeed(feed2);
    api.injectSettlement({ type: 'match', away: '金鶯', home: '費城人', gameTime: '07:05', league: 'MLB' });
    assert.equal(browser.document.getElementById('closeOddsAway').value, '');
    assert.match(browser.document.getElementById('oddsPortalEvidence').textContent, /Stake 初盤／收盤/);
    // 2026-08-05 守門：證據卡不談對調——不得出現任何換邊字樣
    assert.doesNotMatch(browser.document.getElementById('oddsPortalEvidence').textContent, /換邊|對調/);
  } finally {
    dom.window.close();
  }
});

test('asia full-name board cards match short-name oddsportal teams', () => {
  // 2026-08-05 阪神虎@橫濱DeNA 案：初盤在庫但視窗顯示「尚無資料」＝嚴格相等配對之罪
  const asiaFeed = { games: { 'npb|2026-08-05|阪神|橫濱|16:45|jp1': {
    eventId: 'jp1', league: 'npb', date: '2026-08-05', startTime: '16:45',
    awayTeam: '阪神', homeTeam: '橫濱',
    markets: { ml: { open: { away: 2.14, home: 1.66 } } },
  } } };
  const game = findOddsPortalGame(asiaFeed, {
    league: '日職', away: '阪神虎', home: '橫濱DeNA', gameTime: '16:45',
  }, '2026-08-05');
  assert.ok(game, '全名卡必須配上短名摘要');
  assert.equal(game.eventId, 'jp1');
});

test('autoApplyOdds writes open and final close into blank card fields only', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  let saved = 0;
  const browser = {
    document: dom.window.document,
    doc: { activeDate: '2026-08-05', boards: { '2026-08-05': { items: [
      { type: 'match', league: '日職', away: '阪神虎', home: '橫濱DeNA', gameTime: '16:45' },                     // 空白→自動填
      { type: 'match', league: '日職', away: '讀賣巨人', home: '廣島鯉魚', gameTime: '17:00', openOddsAway: 9.9, openOddsHome: 9.8 }, // 手填→不碰
    ] } } },
    fetch: async () => { throw new Error('not used'); },
    setInterval: () => 0,
    save: () => { saved++; },
  };
  try {
    const api = require('../oddsportal-integration.js').install(browser);
    api._setFeed({ source: 'OddsPortal', bookmaker: 'Stake.com', games: {
      'npb|2026-08-05|阪神|橫濱|16:45|a': { eventId: 'a', league: 'npb', date: '2026-08-05', startTime: '16:45',
        awayTeam: '阪神', homeTeam: '橫濱',
        markets: { ml: { open: { away: 2.14, home: 1.66 }, close: { away: 2.3, home: 1.6, final: true } } } },
      'npb|2026-08-05|巨人|廣島|17:00|b': { eventId: 'b', league: 'npb', date: '2026-08-05', startTime: '17:00',
        awayTeam: '巨人', homeTeam: '廣島',
        markets: { ml: { open: { away: 2.02, home: 1.74 } } } },
    } });
    const changed = api.autoApplyOdds();
    const its = browser.doc.boards['2026-08-05'].items;
    assert.equal(its[0].openOddsAway, 2.14);
    assert.equal(its[0].closeOddsHome, 1.6);      // final 收盤一併寫入
    assert.equal(its[0].flipOddsAway, undefined); // 下注賠率永不代填
    assert.equal(its[1].openOddsAway, 9.9);       // 手填值不覆蓋
    assert.ok(changed >= 2 && saved === 1);
  } finally { dom.window.close(); }
});

test('autoApplyOdds backfills final close into settled game history without overwriting manual values', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  let saved = 0;
  const browser = {
    document: dom.window.document,
    doc: {
      activeDate: '2026-08-24',
      boards: { '2026-08-24': { items: [] } },
      games: [
        { date: '2026-08-24', league: 'MLB', awayTeam: '光芒', homeTeam: '金鶯', gameTime: '01:35' },
        { date: '2026-08-24', league: 'MLB', awayTeam: '藍鳥', homeTeam: '洋基', gameTime: '01:35',
          closeOddsAway: 9.9, closeOddsHome: 9.8 },
      ],
    },
    fetch: async () => { throw new Error('not used'); },
    setInterval: () => 0,
    save: () => { saved++; },
  };
  try {
    const api = require('../oddsportal-integration.js').install(browser);
    api._setFeed({ source: 'OddsPortal', bookmaker: 'Stake.com', games: {
      rays: { eventId: 'rays', league: 'mlb', date: '2026-08-24', startTime: '01:35',
        awayTeam: '光芒', homeTeam: '金鶯', markets: { ml: {
          open: { away: 2.05, home: 1.8 }, close: { away: 2.2, home: 1.7, final: true },
        } } },
      jays: { eventId: 'jays', league: 'mlb', date: '2026-08-24', startTime: '01:35',
        awayTeam: '藍鳥', homeTeam: '洋基', markets: { ml: {
          open: { away: 1.9, home: 1.9 }, close: { away: 1.85, home: 1.95, final: true },
        } } },
    } });

    const changed = api.autoApplyOdds();
    const games = browser.doc.games;
    assert.equal(games[0].openOddsAway, 2.05);
    assert.equal(games[0].closeOddsAway, 2.2);
    assert.equal(games[0].closeOddsHome, 1.7);
    assert.equal(games[1].closeOddsAway, 9.9);
    assert.equal(games[1].closeOddsHome, 9.8);
    assert.ok(changed >= 2 && saved === 1);
  } finally { dom.window.close(); }
});

// ── 2026-08-06 回歸：板子的 doc 是 `let doc`（全域語彙變數），不在 window 上。
// autoApplyOdds 若只讀 global.doc 會永遠拿到 undefined → 一格都不寫 → 標籤不變色。
test('autoApplyOdds reads the lexical doc when it is not a property of window', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  const lexicalDoc = { activeDate: '2026-08-06', boards: { '2026-08-06': { items: [
    { type: 'match', league: 'MLB', away: '藍鳥', home: '太空人', gameTime: '02:10' },
  ] } } };
  globalThis.doc = lexicalDoc;                 // Node 的裸識別字＝globalThis，等同瀏覽器的語彙全域
  const browser = {                            // 關鍵：browser 物件上「沒有」doc
    document: dom.window.document,
    fetch: async () => { throw new Error('not used'); },
    setInterval: () => 0,
    save: () => {},
  };
  try {
    const api = require('../oddsportal-integration.js').install(browser);
    api._setFeed({ source: 'OddsPortal', bookmaker: 'Stake.com', games: {
      'mlb|2026-08-06|藍鳥|太空人|02:10|z': { eventId: 'z', league: 'mlb', date: '2026-08-06', startTime: '02:10',
        awayTeam: '藍鳥', homeTeam: '太空人', markets: { ml: { open: { away: 1.86, home: 1.95 } } } },
    } });
    assert.ok(api.autoApplyOdds() >= 1);
    assert.equal(lexicalDoc.boards['2026-08-06'].items[0].openOddsAway, 1.86);
  } finally { delete globalThis.doc; dom.window.close(); }
});

// ── 2026-08-06 回歸：WNBA 隊名不在板子 LEAGUES 表裡 → leagueOf 回 'zz'。
// 'zz' 必須當「未知」，否則永遠配不到 wnba 場次（使用者要求 WNBA 也要初盤/收盤）。
test('unknown league zz is treated as wildcard so WNBA cards match', () => {
  const { normalizeLeague } = require('../oddsportal-integration.js');
  assert.equal(normalizeLeague('zz'), '');
  assert.equal(normalizeLeague('WNBA'), 'wnba');
  const wnbaFeed = { games: { 'wnba|2026-08-06|水星|美夢|07:00|w': {
    eventId: 'w', league: 'wnba', date: '2026-08-06', startTime: '07:00',
    awayTeam: '水星', homeTeam: '美夢', markets: { ml: { open: { away: 2.9, home: 1.4 } } } } } };
  const game = findOddsPortalGame(wnbaFeed, { type: 'match', away: '水星', home: '美夢', gameTime: '07:00', league: 'zz' }, '2026-08-06');
  assert.equal(game && game.eventId, 'w');
});

// 2026-08-13 斗山熊@韓華鷹案：板上「韓華鷹」、feed「華老鷹」互不包含 → 配對斷裂，
// 使用者被迫手動填初收盤。同義橋必須把這對接起來，且不得放寬其他比對。
test('hanwha synonym bridge matches both namings without loosening others', () => {
  const kboFeed = { games: { 'kbo|2026-08-13|華老鷹|斗山熊|18:00|k1': {
    eventId: 'k1', league: 'kbo', date: '2026-08-13', startTime: '18:00',
    awayTeam: '華老鷹', homeTeam: '斗山熊', markets: { ml: { open: { away: 1.62, home: 2.2 } } } } } };
  const hit = findOddsPortalGame(kboFeed, { type: 'match', away: '韓華鷹', home: '斗山熊', gameTime: '18:00', league: 'kbo' }, '2026-08-13');
  assert.equal(hit && hit.eventId, 'k1');
  const missSameLeague = findOddsPortalGame(kboFeed, { type: 'match', away: '樂天巨人', home: '斗山熊', gameTime: '18:00', league: 'kbo' }, '2026-08-13');
  assert.equal(missSameLeague, null);      // 別隊不得被同義橋誤配
});
