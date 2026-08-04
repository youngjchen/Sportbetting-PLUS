'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  try {
    return require('../oddsportal_local.js');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND'
        && String(error.message).includes('oddsportal_local.js')) return {};
    throw error;
  }
}

test('OddsPortal local poll is due at 15 minutes, not before', () => {
  const { isOddsPortalDue } = loadModule();
  assert.equal(typeof isOddsPortalDue, 'function');
  const last = Date.parse('2026-08-01T05:00:00+08:00');
  assert.equal(isOddsPortalDue(last, last + 14 * 60_000 + 59_999), false);
  assert.equal(isOddsPortalDue(last, last + 15 * 60_000), true);
  assert.equal(isOddsPortalDue(0, last), true);
});

test('Python selection prefers the explicit runtime then the user-local runtime', () => {
  const { pythonCandidates } = loadModule();
  assert.equal(typeof pythonCandidates, 'function');
  const values = pythonCandidates({
    ODDSPORTAL_PYTHON: 'D:\\Python\\python.exe',
    LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
  });
  assert.equal(values[0], 'D:\\Python\\python.exe');
  assert.equal(
    values[1],
    path.join('C:\\Users\\Tester\\AppData\\Local', 'Python', 'bin', 'python.exe'),
  );
  assert.equal(new Set(values).size, values.length);
});

test('local runner stages only the OddsPortal summary and compressed history directory', () => {
  const { OUTPUT_PATHS } = loadModule();
  assert.deepEqual(OUTPUT_PATHS, [
    'data/oddsportal_summary.json',
    'data/oddsportal_history',
  ]);
});

// ══ 2026-08-04 新節奏：賽程驅動 6 閘（廢 15 分鐘盯哨）══

test('gates: asia same-day and mlb previous-day open plus flip/close anchors', () => {
  const { computeOddsPortalGates } = loadModule();
  const games = [
    { league: 'npb', date: '2026-08-04', gameTime: '17:00' },
    { league: 'cpbl', date: '2026-08-04', gameTime: '18:35' },
    { league: 'kbo', date: '2026-08-04', time: '17:00' },
    { league: 'mlb', date: '2026-08-05', gameTime: '02:20' },
    { league: 'mlb', date: '2026-08-05', gameTime: '10:10' },
  ];
  const gates = computeOddsPortalGates(games);
  const byId = Object.fromEntries(gates.map((g) => [g.id, g]));
  assert.equal(byId['open_asia_2026-08-04'].at, Date.parse('2026-08-04T03:00:00+08:00'));
  assert.equal(byId['flip_asia_2026-08-04'].at, Date.parse('2026-08-04T14:30:00+08:00')); // 17:00 - 2.5h
  assert.equal(byId['close_asia_2026-08-04'].at, Date.parse('2026-08-04T18:45:00+08:00')); // 18:35 + 10m
  assert.equal(byId['open_mlb_2026-08-05'].at, Date.parse('2026-08-04T07:00:00+08:00'));   // 前一天早上
  assert.equal(byId['flip_mlb_2026-08-05'].at, Date.parse('2026-08-04T23:50:00+08:00'));   // 02:20 - 2.5h
  assert.equal(byId['close_mlb_2026-08-05'].at, Date.parse('2026-08-05T10:20:00+08:00'));  // 10:10 + 10m
  assert.equal(byId['flip_mlb_2026-08-05'].refreshUpcoming, true);
  assert.equal(gates.length, 6);
});

test('dueOddsPortalGate honors fired-state and the 6h expiry', () => {
  const { computeOddsPortalGates, dueOddsPortalGate, GATE_LOOKBACK_MS } = loadModule();
  const games = [{ league: 'npb', date: '2026-08-04', gameTime: '17:00' }];
  const gates = computeOddsPortalGates(games);
  const openAt = Date.parse('2026-08-04T03:00:00+08:00');
  assert.equal(dueOddsPortalGate(gates, {}, openAt - 1), null);                       // 未到點
  assert.equal(dueOddsPortalGate(gates, {}, openAt + 60_000).id, 'open_asia_2026-08-04');
  assert.equal(dueOddsPortalGate(gates, { 'opg_open_asia_2026-08-04': openAt }, openAt + 60_000)?.id,
    undefined);                                                                        // 跑過不重跑
  assert.equal(dueOddsPortalGate(gates, {}, openAt + GATE_LOOKBACK_MS + 60_000), null); // 過期不補
});

test('oddsPortalArgs encodes the gap-driven scraper flags', () => {
  const { oddsPortalArgs, computeOddsPortalGates } = loadModule();
  assert.deepEqual(oddsPortalArgs(null), ['oddsportal_scraper.py']);
  const gate = computeOddsPortalGates([{ league: 'mlb', date: '2026-08-05', gameTime: '02:20' }])
    .find((g) => g.mode === 'flip');
  const args = oddsPortalArgs(gate);
  assert.ok(args.includes('--leagues') && args.includes('mlb'));
  assert.ok(args.includes('--include-started'));
  assert.ok(args.includes('--refresh-upcoming'));
  assert.ok(args.includes('--max-games') && args.includes('40'));
});
