'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WF = path.join(ROOT, '.github', 'workflows');

function workflow(name) {
  const file = path.join(WF, name);
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 不可有 BOM`);
  return bytes.toString('utf8');
}

test('baseball Bet365 official-first pipeline is a safe five-minute self-handoff loop', () => {
  const text = workflow('baseball-bet365-odds.yml');
  assert.match(text, /name:\s*baseball-bet365-odds/);
  assert.match(text, /group:\s*baseball-bet365-odds/);
  assert.match(text, /cancel-in-progress:\s*false/);
  assert.match(text, /END=\$\(\( SECONDS \+ 18600 \)\)/);
  assert.match(text, /timeout 420 node baseball_bet365_odds\.js/);
  assert.match(text, /git add data\/baseball_bet365_odds\.json/);
  assert.match(text, /300 - EL/);
  assert.match(text, /gh workflow run baseball-bet365-odds\.yml/);
  assert.match(text, /scrapling install --force/);
});

test('all Bet365 workflows describe official-first transport and watch transport changes', () => {
  for (const name of ['baseball-bet365-odds.yml', 'nba-bet365-odds.yml', 'nhl-bet365-odds.yml']) {
    const text = workflow(name);
    assert.match(text, /bet365_official_transport\.js/);
    assert.match(text, /fetch_sidecar\.py/);
    assert.match(text, /sidecar_client\.js/);
    assert.doesNotMatch(text, /以 Titan .*主|Titan companyId=8 的公開盤口歷史取開賽前資料/);
  }
});

test('watchdog covers every Bet365 official-first output', () => {
  const text = workflow('pipeline-watchdog.yml');
  assert.match(text, /check "data\/baseball_bet365_odds\.json" "baseball-bet365-odds\.yml" 25/);
  assert.match(text, /check "data\/nba_bet365_odds\.json" "nba-bet365-odds\.yml" 25/);
  assert.match(text, /check "data\/nhl_bet365_odds\.json" "nhl-bet365-odds\.yml" 25/);
});
