'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const WORKFLOW = path.resolve(__dirname, '..', '.github', 'workflows', 'nhl-bet365-odds.yml');

function loadWorkflow() {
  const bytes = fs.readFileSync(WORKFLOW);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'workflow 不可含 UTF-8 BOM');
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

test('defines an isolated non-cancelling NHL Bet365 workflow', () => {
  const workflow = loadWorkflow();
  assert.equal(workflow.name, 'nhl-bet365-odds');
  assert.ok(workflow.on.workflow_dispatch);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.push.paths, [
    'nhl_bet365_odds.js',
    'nhl_bet365_core.js',
    'bet365_official_transport.js',
    'fetch_sidecar.py',
    'sidecar_client.js',
    'requirements-scraping.txt',
    '.github/workflows/nhl-bet365-odds.yml',
  ]);
  assert.equal(workflow.concurrency.group, 'nhl-bet365-odds');
  assert.equal(workflow.concurrency['cancel-in-progress'], 'false');
  assert.equal(workflow.jobs.loop['timeout-minutes'], '350');
  assert.equal(workflow.jobs.loop.env.EP_TRANSPORT, 'sidecar');
});

test('installs the browser transport and refreshes only the NHL Bet365 file every five minutes', () => {
  const workflow = loadWorkflow();
  const steps = workflow.jobs.loop.steps;
  assert.ok(steps.some((step) => step.uses === 'actions/setup-python@v5'));
  const install = steps.find((step) => String(step.name || '').includes('Scrapling'));
  assert.match(install.run, /pip -q install -r requirements-scraping\.txt/);
  assert.match(install.run, /scrapling install --force/);

  const loop = steps.find((step) => String(step.name || '').includes('5h10m'));
  assert.match(loop.run, /SECONDS \+ 18600/);
  assert.match(loop.run, /timeout 240 node nhl_bet365_odds\.js/);
  assert.match(loop.run, /git add data\/nhl_bet365_odds\.json/);
  assert.match(loop.run, /300 - EL/);
  assert.doesNotMatch(loop.run, /stake_api_odds|odds_log\.json|pregame_data\.json/i);
});

test('hands off to the same workflow with WORKFLOW_PAT', () => {
  const workflow = loadWorkflow();
  const steps = workflow.jobs.loop.steps;
  const handoff = steps.find((step) => step.name === '自我接棒');
  assert.equal(handoff.env.GH_TOKEN, '${{ secrets.WORKFLOW_PAT }}');
  assert.match(handoff.run, /gh workflow run nhl-bet365-odds\.yml/);
});
