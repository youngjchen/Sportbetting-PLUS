'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const {
  findMatch,
  applyStakeToItem,
  markManual,
  restoreAuto,
  sourceText,
  renderMonitor,
} = require('../nba-odds-integration.js');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-10-03T15:58:00.000Z');
const model = {
  officialId: 'NBA_20261004_MIA@TOR', league: 'NBA', date: '2026-10-04', time: '07:00',
  away: '熱火', home: '暴龍', hdFav: 'home', hdVal: 3.5, totLine: 229.5,
  taiwan: {
    ml: { away: 2, home: 1.48 },
    hd: { favorite: 'home', line: 3.5, away: 1.72, home: 1.72 },
    ou: { line: 229.5, over: 1.7, under: 1.73 },
  },
};
const stake = {
  officialId: model.officialId, away: '熱火', home: '暴龍', observedAt: '2026-10-03T15:57:05.999Z',
  moneyline: { away: 2.25, home: 1.58 }, favorite: 'home', line: 3.5,
  handicapOdds: { away: 1.85, home: 1.85 }, total: { line: 229.5, over: 1.81, under: 1.89 },
  history: [{ observedAt: '2026-10-03T15:57:05.999Z', favorite: 'home', line: 3.5,
    moneyline: { away: 2.25, home: 1.58 }, handicapOdds: { away: 1.85, home: 1.85 },
    total: { line: 229.5, over: 1.81, under: 1.89 } }],
};

test('NBA feed 依官方 ID 找到熱火季前賽', () => {
  assert.equal(findMatch({ matches: { [model.officialId]: stake } }, model), stake);
});

test('官方 ID 尚未補上時仍以台灣日期與主客隊配對，不受 UTC 跨日影響', () => {
  const fallback = { ...stake, officialId: 'temporary', scheduledStart: '2026-10-03T23:00:00.000Z' };
  assert.equal(findMatch({ matches: { temporary: fallback } }, model), fallback);
});

test('STAKE 自動填入讓分方、讓分與大小基準線', () => {
  const item = {};
  assert.equal(applyStakeToItem(item, model, stake, NOW), true);
  assert.equal(item.hdFav, 'home');
  assert.equal(item.hdVal, 3.5);
  assert.equal(item.totVal, 229.5);
  assert.equal(item.stakeAutoHandicap, true);
  assert.equal(item.stakeAutoTotal, true);
});

test('手動換讓分方或改大小後不被下一輪 STAKE 覆蓋，恢復按鈕可重新接管', () => {
  const item = {};
  applyStakeToItem(item, model, stake, NOW);
  markManual(item, 'handicap', 'away');
  markManual(item, 'total');
  item.totVal = 231.5;
  applyStakeToItem(item, model, { ...stake, favorite: 'home', line: 5.5, total: { line: 227.5, over: 1.9, under: 1.8 } }, NOW);
  assert.equal(item.hdFavOverride, 'away');
  assert.equal(item.hdVal, 3.5);
  assert.equal(item.totVal, 231.5);
  restoreAuto(item, 'handicap', stake, model, NOW);
  restoreAuto(item, 'total', stake, model, NOW);
  assert.equal(item.hdFavOverride, undefined);
  assert.equal(item.hdFav, 'home');
  assert.equal(item.totVal, 229.5);
});

test('三方盤口列顯示獨贏、讓分、大小與雙邊賠率', () => {
  assert.match(sourceText('STAKE', stake, model), /獨贏 客 熱火 2\.25／主 暴龍 1\.58/);
  assert.match(sourceText('STAKE', stake, model), /讓 暴龍 -3\.5 1\.85／受讓 熱火 \+3\.5 1\.85/);
  assert.match(sourceText('STAKE', stake, model), /大 229\.5 1\.81／小 229\.5 1\.89/);
  assert.match(sourceText('台彩', model.taiwan, model), /獨贏 客 熱火 2／主 暴龍 1\.48/);
  assert.equal(sourceText('BET365', null, model), 'BET365：未開盤');
});

test('卡片監控區同時呈現三方，並可展開 STAKE 歷史', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const row = renderMonitor(model, {}, { stake, bet365: null }, NOW, dom.window.document);
  assert.match(row.textContent, /STAKE：/);
  assert.match(row.textContent, /BET365：未開盤/);
  assert.match(row.textContent, /台彩：/);
  row.querySelector('.nba-odds-history-toggle').click();
  assert.match(row.querySelector('.nba-odds-history').textContent, /23:57/);
});

test('nba.html 不再把 NBA 分支鎖成空白，並載入版本化三方監控', () => {
  const html = fs.readFileSync(path.join(ROOT, 'nba.html'), 'utf8');
  assert.doesNotMatch(html, /if\(doc\.activeLeague!=="WNBA"\) return \[\]/);
  assert.match(html, /g\.league===doc\.activeLeague/);
  assert.match(html, /nba-odds-integration\.js\?v=\d+/);
  assert.match(html, /data\/nba_pregame\.json/);
});
