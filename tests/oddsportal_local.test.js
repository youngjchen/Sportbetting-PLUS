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
