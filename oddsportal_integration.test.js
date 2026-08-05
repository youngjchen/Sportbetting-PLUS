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
