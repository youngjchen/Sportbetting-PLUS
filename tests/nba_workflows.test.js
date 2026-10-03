'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const WF = path.join(ROOT, '.github/workflows');

const expected = [
  ['nba-scrape.yml', 'nba-scrape', /node nba_scraper\.js/, /data\/nba_pregame\.json data\/nba_lottery_series\.json/],
  ['nba-stake-odds.yml', 'nba-stake-odds', /node nba_stake_odds\.js/, /data\/nba_stake_odds\.json/],
  ['nba-bet365-odds.yml', 'nba-bet365-odds', /node nba_bet365_odds\.js/, /data\/nba_bet365_odds\.json/],
];

for (const [file, name, command, data] of expected) {
  test(`${name} 是五分鐘長迴圈、自我接棒且不取消執行中工作`, () => {
    const bytes = fs.readFileSync(path.join(WF, file));
    assert.notDeepEqual(Array.from(bytes.subarray(0, 3)), [0xEF, 0xBB, 0xBF]);
    const text = bytes.toString('utf8');
    assert.match(text, new RegExp(`name:\\s*${name}`));
    assert.match(text, new RegExp(`group:\\s*${name}`));
    assert.match(text, /cancel-in-progress:\s*false/);
    assert.match(text, /END=\$\(\( SECONDS \+ 18600 \)\)/);
    assert.match(text, command);
    assert.match(text, data);
    assert.match(text, /300 - EL/);
    assert.match(text, new RegExp(`gh workflow run ${file.replace('.', '\\.')} `));
  });
}

test('看門狗涵蓋 NBA 三條資料管線', () => {
  const text = fs.readFileSync(path.join(WF, 'pipeline-watchdog.yml'), 'utf8');
  assert.match(text, /check "data\/nba_pregame\.json" "nba-scrape\.yml" 25/);
  assert.match(text, /check "data\/nba_stake_odds\.json" "nba-stake-odds\.yml" 25/);
  assert.match(text, /check "data\/nba_bet365_odds\.json" "nba-bet365-odds\.yml" 25/);
});
