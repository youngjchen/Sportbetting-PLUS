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

test('Bet365 lightweight probe is due every 30 minutes', () => {
  const { isBet365ProbeDue, BET365_PROBE_INTERVAL_MS } = loadModule();
  assert.equal(typeof isBet365ProbeDue, 'function');
  assert.equal(BET365_PROBE_INTERVAL_MS, 30 * 60_000);
  const last = Date.parse('2026-09-02T16:00:00+08:00');
  assert.equal(isBet365ProbeDue(last, last + BET365_PROBE_INTERVAL_MS - 1), false);
  assert.equal(isBet365ProbeDue(last, last + BET365_PROBE_INTERVAL_MS), true);
  assert.equal(isBet365ProbeDue(0, last), true);
});

test('BetExplorer lightweight probe requests only Bet365 handicap rows', () => {
  const { betExplorerArgs } = loadModule();
  assert.deepEqual(betExplorerArgs(['mlb', 'npb'], true), [
    'betexplorer_run.py', '--leagues', 'mlb,npb', '--bet365-only',
  ]);
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
  assert.equal(byId['close_asia_2026-08-04_1710'].at, Date.parse('2026-08-04T17:10:00+08:00')); // 17:00 + 10m
  assert.equal(byId['close_asia_2026-08-04_1845'].at, Date.parse('2026-08-04T18:45:00+08:00')); // 18:35 + 10m
  assert.equal(byId['open_mlb_2026-08-05'].at, Date.parse('2026-08-04T07:00:00+08:00'));   // 前一天早上
  assert.equal(byId['flip_mlb_2026-08-05'].at, Date.parse('2026-08-04T23:50:00+08:00'));   // 02:20 - 2.5h
  assert.equal(byId['close_mlb_2026-08-05_0230'].at, Date.parse('2026-08-05T02:30:00+08:00'));  // 02:20 + 10m
  assert.equal(byId['close_mlb_2026-08-05_1020'].at, Date.parse('2026-08-05T10:20:00+08:00'));  // 10:10 + 10m
  assert.equal(byId['flip_mlb_2026-08-05'].refreshUpcoming, true);
  assert.equal(gates.length, 8);
});

test('close gates split a date into nearby-start clusters so early games finalize on time', () => {
  const { computeOddsPortalGates } = loadModule();
  const games = [
    { league: 'mlb', date: '2026-08-24', gameTime: '01:35' },
    { league: 'mlb', date: '2026-08-24', gameTime: '01:40' },
    { league: 'mlb', date: '2026-08-24', gameTime: '02:10' },
    { league: 'mlb', date: '2026-08-24', gameTime: '03:10' },
    { league: 'mlb', date: '2026-08-24', gameTime: '03:15' },
    { league: 'mlb', date: '2026-08-24', gameTime: '07:10' },
  ];

  const closeGates = computeOddsPortalGates(games).filter((gate) => gate.mode === 'close');

  assert.deepEqual(closeGates.map((gate) => gate.id), [
    'close_mlb_2026-08-24_0150',
    'close_mlb_2026-08-24_0220',
    'close_mlb_2026-08-24_0325',
    'close_mlb_2026-08-24_0720',
  ]);
  assert.deepEqual(closeGates.map((gate) => gate.at), [
    Date.parse('2026-08-24T01:50:00+08:00'),
    Date.parse('2026-08-24T02:20:00+08:00'),
    Date.parse('2026-08-24T03:25:00+08:00'),
    Date.parse('2026-08-24T07:20:00+08:00'),
  ]);
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

test('harvest gate fires at fixed slots and silences when all leagues done', () => {
  const { dueHarvestGate, GATE_LOOKBACK_MS } = loadModule();
  // 2026-08-06：班次 4→8（00:35 起每 3 小時），首班之前仍必須靜默
  const first = Date.parse('2026-08-06T00:35:00+08:00');
  const night = Date.parse('2026-08-06T02:35:00+08:00');
  const at = Date.parse('2026-08-06T05:05:00+08:00');
  assert.equal(dueHarvestGate({}, {}, first - 1), null);
  assert.equal(dueHarvestGate({}, {}, first + 60_000).id, 'harvest_2026-08-06_0035');
  assert.equal(dueHarvestGate({}, { 'opg_harvest_2026-08-06_0035': first }, night - 1), null);
  const fired0035 = { 'opg_harvest_2026-08-06_0035': first };
  assert.equal(dueHarvestGate({}, { ...fired0035 }, night + 60_000).id, 'harvest_2026-08-06_0235');
  assert.equal(dueHarvestGate({}, { ...fired0035 }, at + 60_000).id, 'harvest_2026-08-06_0235'); // 夜班未跑先補（6h內）
  assert.equal(dueHarvestGate({}, { ...fired0035, 'opg_harvest_2026-08-06_0235': night }, at + 60_000).id, 'harvest_2026-08-06_0505');
  assert.equal(dueHarvestGate({}, { ...fired0035, 'opg_harvest_2026-08-06_0235': night, 'opg_harvest_2026-08-06_0505': at }, at + 60_000), null);
  // 末班 21:05 也要會發射（8 班全到齊）
  const late = Date.parse('2026-08-06T21:05:00+08:00');
  const allEarlier = {};
  for (const hhmm of ['0035', '0235', '0505', '0805', '1135', '1505', '1805']) allEarlier['opg_harvest_2026-08-06_' + hhmm] = late - 3600e3;
  assert.equal(dueHarvestGate({}, allEarlier, late + 60_000).id, 'harvest_2026-08-06_2105');
  // 過期（>6h）的班永不補跑：把其後各班標成已跑，只剩過期的 00:35 → 靜默
  const expired = Date.parse('2026-08-06T00:35:00+08:00') + GATE_LOOKBACK_MS + 60_000;
  const laterFired = { 'opg_harvest_2026-08-06_0235': expired, 'opg_harvest_2026-08-06_0505': expired };
  assert.equal(dueHarvestGate({}, laterFired, expired), null);
  const done = { mlb: { done: true }, npb: { done: true }, kbo: { done: true }, cpbl: { done: true } };
  assert.equal(dueHarvestGate(done, {}, at + 60_000), null);
});
