'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/baseball-stake-odds.yml');
const WATCHDOG = path.join(ROOT, '.github/workflows/pipeline-watchdog.yml');

test('baseball Stake workflow is a five-minute self-handoff loop with safe concurrency', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(text, /name:\s*baseball-stake-odds/);
  assert.match(text, /group:\s*baseball-stake-odds/);
  assert.match(text, /cancel-in-progress:\s*false/);
  assert.match(text, /END=\$\(\( SECONDS \+ 18600 \)\)/);
  assert.match(text, /timeout 420 node baseball_stake_odds\.js/);
  assert.match(text, /git add data\/baseball_stake_odds\.json/);
  assert.match(text, /300 - EL/);
  assert.match(text, /gh workflow run baseball-stake-odds\.yml/);
  assert.deepEqual(Array.from(text.matchAll(/git add\s+(data\/[^\s]+)/g), (match) => match[1]), [
    'data/baseball_stake_odds.json',
  ]);
});

test('workflow is UTF-8 without BOM and the watchdog monitors its data freshness', () => {
  const bytes = fs.readFileSync(WORKFLOW);
  assert.notDeepEqual(Array.from(bytes.subarray(0, 3)), [0xEF, 0xBB, 0xBF]);
  const watchdog = fs.readFileSync(WATCHDOG, 'utf8');
  assert.match(watchdog, /check "data\/baseball_stake_odds\.json" "baseball-stake-odds\.yml" 25/);
});
