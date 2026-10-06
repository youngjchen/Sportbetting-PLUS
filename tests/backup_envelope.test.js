'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const indexSource = fs.readFileSync('index.html', 'utf8');
const nbaSource = fs.readFileSync('nba.html', 'utf8');
const nhlSource = fs.readFileSync('nhl.html', 'utf8');
const unifiedSource = fs.readFileSync('unified-backup.js', 'utf8');
const githubSource = fs.readFileSync('github-sync.js', 'utf8');
const divinationSource = fs.readFileSync('divination-addon.js', 'utf8');
const wnbaDivinationSource = fs.readFileSync('wnba-divination-addon.js', 'utf8');

test('baseball uses the all-sports v3 backup module', () => {
  assert.match(indexSource, /unified-backup\.js\?v=20261006ub1/);
  assert.match(indexSource, /__unifiedBackup\.exportAll/);
  assert.match(indexSource, /__unifiedBackup\.parseImport/);
  assert.match(indexSource, /__unifiedBackup\.persistImport/);
  assert.match(indexSource, /備份失敗：無法讀取完整資料/);
  assert.match(unifiedSource, /sbplus-all-sports-backup-v3/);
});

test('baseball backup still downloads the board when persistent IndexedDB errors break a ledger', () => {
  assert.match(indexSource, /fetchCloudCasts/);
  assert.match(unifiedSource, /salvageLedger/);
  assert.match(indexSource, /備份已下載/);
});

test('basketball backup includes WNBA casts while accepting its old plain document format', () => {
  assert.match(nbaSource, /unified-backup\.js\?v=20261006ub1/);
  assert.match(unifiedSource, /sbplus-nba-backup-v2/);
  assert.match(unifiedSource, /plain-document/);
});

test('basketball board backup also survives persistent IndexedDB errors', () => {
  assert.match(nbaSource, /__unifiedBackup\.exportAll/);
  assert.match(nbaSource, /備份已下載/);
});

test('all three sports pages load the exact same unified backup version', () => {
  [indexSource, nbaSource, nhlSource].forEach(source => {
    assert.match(source, /unified-backup\.js\?v=20261006ub1/);
  });
});

test('all cast writers use the same verified large-data store', () => {
  assert.match(divinationSource, /baseball-casts/);
  assert.match(divinationSource, /__largeStorage\.writeJSON/);
  assert.match(wnbaDivinationSource, /wnba-casts/);
  assert.match(wnbaDivinationSource, /__largeStorage\.writeJSON/);
  assert.match(githubSource, /__largeStorage\.readJSON\('baseball-casts'/);
  assert.match(githubSource, /__largeStorage\.writeJSON\('baseball-casts'/);
  assert.doesNotMatch(githubSource, /if \(gained > 0\) \{ try \{ localStorage\.setItem\(CASTS_KEY/);
});

test('storage gauges distinguish localStorage pressure from IndexedDB large-data size', () => {
  assert.match(indexSource, /大型資料（IndexedDB）/);
  assert.match(nbaSource, /大型資料（IndexedDB）/);
});
