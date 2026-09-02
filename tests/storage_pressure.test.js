'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let pressure = {};
try { pressure = require('../storage-pressure.js'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const MB = 1024 * 1024;

function fakeStorage(limitBytes, entries) {
  const data = new Map(Object.entries(entries || {}));
  function usedBytes(nextKey, nextValue) {
    let total = 0;
    const merged = new Map(data);
    if (nextKey != null) merged.set(String(nextKey), String(nextValue));
    for (const [key, value] of merged) total += (key.length + value.length) * 2;
    return total;
  }
  return {
    get length() { return data.size; },
    key(index) { return Array.from(data.keys())[index] ?? null; },
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    removeItem(key) { data.delete(String(key)); },
    setItem(key, value) {
      if (usedBytes(key, value) > limitBytes) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      data.set(String(key), String(value));
    },
  };
}

function charsForMB(mb) { return 'x'.repeat(Math.floor(mb * MB / 2)); }

test('critical data save frees only rebuildable backup copies when the 5MB quota is full', () => {
  assert.equal(typeof pressure.setCritical, 'function', '尚未提供容量救援寫入');
  const storage = fakeStorage(5 * MB, {
    sportbetting_plus_doc_v2: charsForMB(1.13),
    dvManualCasts: charsForMB(1.28),
    dvManualCastsWnba: charsForMB(0.59),
    sportbetting_nba_doc_v1: charsForMB(0.38),
    sportbetting_plus_autobackup: charsForMB(1.13),
    sportbetting_nba_doc_v1_auto: charsForMB(0.38),
  });

  const result = pressure.setCritical(storage, 'dvManualCasts', charsForMB(1.45));

  assert.equal(result.ok, true);
  assert.deepEqual(result.removed.sort(), [
    'sportbetting_nba_doc_v1_auto',
    'sportbetting_plus_autobackup',
  ]);
  assert.equal(storage.getItem('sportbetting_plus_doc_v2') !== null, true, '棒球主檔不可刪');
  assert.equal(storage.getItem('dvManualCasts') !== null, true, '卜卦主檔不可刪');
});

test('rebuildable backup is skipped when it would push storage above 80 percent', () => {
  assert.equal(typeof pressure.setBackup, 'function', '尚未提供備份容量守門');
  const storage = fakeStorage(5 * MB, {
    sportbetting_plus_doc_v2: charsForMB(1.13),
    dvManualCasts: charsForMB(1.28),
    dvManualCastsWnba: charsForMB(0.59),
    sportbetting_nba_doc_v1: charsForMB(0.38),
  });

  const saved = pressure.setBackup(storage, 'sportbetting_plus_autobackup', charsForMB(1.13));

  assert.equal(saved, false);
  assert.equal(storage.getItem('sportbetting_plus_autobackup'), null);
  assert.equal(storage.getItem('sportbetting_plus_doc_v2') !== null, true);
});
