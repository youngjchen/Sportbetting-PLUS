'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const {
  findGame,
  applyToCard,
  markManual,
  restoreAuto,
  statusText,
  renderCardStatus,
} = require('../baseball-stake-integration.js');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-10-03T14:10:00.000Z');

function game(overrides = {}) {
  return {
    league: 'NPB', officialId: 'NPB_20261004_Tigers@DeNA_1700',
    scheduledStart: '2026-10-04T09:00:00.000Z', away: '阪神', home: '橫濱',
    favorite: 'away', rawLine: 1.5, canonicalLine: 1.5,
    handicapOdds: { away: 2.32, home: 1.52 },
    total: { line: 7.5, over: 1.89, under: 1.79 },
    observedAt: '2026-10-03T14:05:00.000Z', frozenAt: null, partial: false,
    favoriteFlipCount: 1,
    favoriteTransitions: [{ at: '2026-10-03T13:50:00.000Z', from: 'home', to: 'away' }],
    sources: { direction: 'stake-official', handicapOdds: 'stake-official', total: 'stake-official' },
    ...overrides,
  };
}

function blankCard(overrides = {}) {
  return {
    type: 'match', officialId: 'NPB_20261004_Tigers@DeNA_1700', league: 'npb',
    away: '阪神', home: '橫濱', gameTime: '17:00', hdFav: 'home', hdVal: '', totVal: '',
    ...overrides,
  };
}

test('finds a four-league monitor game by officialId without opening a match page', () => {
  const monitored = game();
  const found = findGame({ matches: { [monitored.officialId]: monitored } }, blankCard(), '2026-10-04');
  assert.equal(found, monitored);
});

test('blank card is auto-owned and receives Stake favorite, line, and total', () => {
  const card = blankCard();
  const changed = applyToCard(card, game(), NOW);
  assert.equal(changed, true);
  assert.equal(card.hdFav, 'away');
  assert.equal(card.hdVal, 1.5);
  assert.equal(card.totVal, 7.5);
  assert.equal(card.stakeAutoHandicap, true);
  assert.equal(card.stakeAutoTotal, true);
});

test('existing nonblank values are treated as manual and never overwritten', () => {
  const card = blankCard({ hdFav: 'home', hdVal: 2.5, totVal: 9.5 });
  applyToCard(card, game(), NOW);
  assert.equal(card.hdFav, 'home');
  assert.equal(card.hdVal, 2.5);
  assert.equal(card.totVal, 9.5);
  assert.equal(card.stakeAutoHandicap, false);
  assert.equal(card.stakeAutoTotal, false);
});

test('manual favorite swap and total edit lock only their own automatic fields', () => {
  const card = blankCard();
  applyToCard(card, game(), NOW);
  markManual(card, 'handicap');
  markManual(card, 'total');
  card.hdFav = 'home';
  card.totVal = 8.5;
  applyToCard(card, game({ favorite: 'away', total: { line: 6.5, over: 1.9, under: 1.9 } }), NOW);
  assert.equal(card.hdFav, 'home');
  assert.equal(card.totVal, 8.5);
  assert.equal(card.stakeAutoHandicap, false);
  assert.equal(card.stakeAutoTotal, false);
});

test('restore auto immediately reapplies only the selected field', () => {
  const card = blankCard({ hdVal: 2.5, totVal: 9.5, stakeAutoHandicap: false, stakeAutoTotal: false });
  restoreAuto(card, 'total', game(), NOW);
  assert.equal(card.hdVal, 2.5);
  assert.equal(card.totVal, 7.5);
  assert.equal(card.stakeAutoHandicap, false);
  assert.equal(card.stakeAutoTotal, true);
});

test('stale live data is visible but does not overwrite the card; frozen data remains usable', () => {
  const stale = game({ observedAt: '2026-10-03T13:00:00.000Z' });
  const card = blankCard();
  assert.equal(applyToCard(card, stale, NOW), false);
  assert.match(statusText(stale, NOW), /已過期/);

  const frozen = game({ observedAt: '2026-10-03T13:00:00.000Z', frozenAt: '2026-10-04T08:59:30.000Z' });
  assert.equal(applyToCard(card, frozen, NOW), true);
  assert.match(statusText(frozen, NOW), /已凍結/);
});

test('card row directly shows favorite, odds, total, flip direction, and health', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const monitored = game({
    partial: true,
    history: [
      {
        observedAt: '2026-10-03T13:40:00.000Z', favorite: 'home', canonicalLine: 1.5,
        handicapOdds: { away: 1.55, home: 2.25 }, total: { line: 7.5, over: 1.9, under: 1.8 },
      },
      {
        observedAt: '2026-10-03T13:50:00.000Z', favorite: 'away', canonicalLine: 1.5,
        handicapOdds: { away: 2.32, home: 1.52 }, total: { line: 7.5, over: 1.89, under: 1.79 },
      },
    ],
  });
  const row = renderCardStatus(blankCard(), monitored, NOW, dom.window.document);
  assert.equal(row.classList.contains('bstake-monitor'), true);
  assert.match(row.textContent, /Stake：阪神讓 1.5（2.32）/);
  assert.match(row.textContent, /大小 7.5/);
  assert.match(row.textContent, /橫濱→阪神/);
  assert.match(row.textContent, /部分缺漏/);
  row.querySelector('.bstake-history-toggle').click();
  const history = row.querySelector('.bstake-history');
  assert.ok(history);
  assert.match(history.textContent, /21:40 橫濱讓 1.5/);
  assert.match(history.textContent, /21:50 阪神讓 1.5/);
});

test('index hooks both favorite swap and total input, and loads versioned integration add-on', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /stakeAutoHandicap\s*=\s*false/g);
  assert.match(html, /stakeAutoTotal\s*=\s*false/);
  assert.match(html, /baseball-stake-integration\.js\?v=\d+/);
  assert.match(html, /renderCardStatus\(it/);
});
