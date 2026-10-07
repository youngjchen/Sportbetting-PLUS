'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const zlib = require('node:zlib');

function loadRecoveryState() {
  const compressed = fs.readFileSync('state/board_state.json.gz');
  return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
}

function cardCount(doc, date) {
  const board = doc.boards?.[date];
  return Array.isArray(board?.items)
    ? board.items.filter(item => item?.type === 'match').length
    : 0;
}

function gameCount(doc, date) {
  return (doc.games || []).filter(game => game?.date === date).length;
}

test('cloud recovery state contains the rescued Oct 3-6 boards and history', () => {
  const doc = loadRecoveryState();

  assert.equal(cardCount(doc, '2026-10-03'), 13);
  assert.equal(cardCount(doc, '2026-10-04'), 15);
  assert.equal(cardCount(doc, '2026-10-05'), 10);
  assert.equal(cardCount(doc, '2026-10-06'), 10);

  assert.equal(gameCount(doc, '2026-10-03'), 9);
  assert.equal(gameCount(doc, '2026-10-04'), 15);
  assert.equal(gameCount(doc, '2026-10-05'), 10);
  assert.equal(gameCount(doc, '2026-10-06'), 2);
});
