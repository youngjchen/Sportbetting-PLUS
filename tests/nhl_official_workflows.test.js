'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function loadWorkflow(name) {
  const file = path.join(ROOT, '.github', 'workflows', name);
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 不可含 UTF-8 BOM`);
  const python = spawnSync('python', ['-c', [
    'import json, sys, yaml',
    'doc = yaml.load(sys.stdin.read(), Loader=yaml.BaseLoader)',
    'print(json.dumps(doc))',
  ].join('; ')], {
    input: bytes,
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  assert.equal(python.status, 0, python.stderr);
  return JSON.parse(python.stdout);
}

test('Stake official workflow runs the page transport even when the optional API key is empty', () => {
  const workflow = loadWorkflow('stake-api-odds.yml');
  assert.deepEqual(workflow.on.push.paths, [
    'stake_api_odds.js',
    'nhl_core.js',
    'fetch_sidecar.py',
    'sidecar_client.js',
    'requirements-scraping.txt',
    '.github/workflows/stake-api-odds.yml',
  ]);
  assert.equal(workflow.jobs.loop.env.EP_TRANSPORT, 'sidecar');
  assert.equal(workflow.jobs.loop.env.STAKE_ODDS_API_KEY, '${{ secrets.STAKE_ODDS_API_KEY }}');
  const steps = workflow.jobs.loop.steps;
  const install = steps.find((step) => String(step.name || '').includes('Scrapling'));
  assert.match(install.run, /pip -q install -r requirements-scraping\.txt/);
  assert.match(install.run, /scrapling install --force/);
  const loop = steps.find((step) => String(step.name || '').includes('5h10m'));
  assert.match(loop.run, /timeout 420 node stake_api_odds\.js/);
  assert.match(loop.run, /git add data\/stake_api_odds\.json/);
  assert.match(loop.run, /FAIL_STREAK=0/);
  assert.match(loop.run, /FAIL_STREAK=\$\(\( FAIL_STREAK \+ 1 \)\)/);
  assert.match(loop.run, /if \[ "\$FAIL_STREAK" -ge 3 \]; then exit 1; fi/);
  assert.doesNotMatch(loop.run, /尚未設定 STAKE_ODDS_API_KEY|exit 0[\s\S]*STAKE_ODDS_API_KEY/);
  const handoff = steps.find((step) => step.name === '自我接棒');
  assert.doesNotMatch(handoff.run, /STAKE_ODDS_API_KEY/);
});

test('the two official workflows stay isolated to their own data files', () => {
  const stake = loadWorkflow('stake-api-odds.yml');
  const bet365 = loadWorkflow('nhl-bet365-odds.yml');
  const stakeLoop = stake.jobs.loop.steps.find((step) => String(step.name || '').includes('5h10m')).run;
  const betLoop = bet365.jobs.loop.steps.find((step) => String(step.name || '').includes('5h10m')).run;
  assert.doesNotMatch(stakeLoop, /nhl_bet365_odds|nhl_oddsportal_stake/);
  assert.doesNotMatch(betLoop, /stake_api_odds|nhl_oddsportal_stake/);
});
