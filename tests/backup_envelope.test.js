'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const indexSource = fs.readFileSync('index.html', 'utf8');
const nbaSource = fs.readFileSync('nba.html', 'utf8');
const githubSource = fs.readFileSync('github-sync.js', 'utf8');
const divinationSource = fs.readFileSync('divination-addon.js', 'utf8');
const wnbaDivinationSource = fs.readFileSync('wnba-divination-addon.js', 'utf8');

test('baseball backup v2 contains both manual-cast ledgers and reads them through the large store', () => {
  assert.match(indexSource, /sbplus-backup-v2/);
  assert.match(indexSource, /dvManualCastsWnba/);
  assert.match(indexSource, /__largeStorage\.readJSON/);
  assert.match(indexSource, /__largeStorage\.writeJSON/);
  assert.match(indexSource, /備份失敗：無法讀取完整資料/);
  assert.match(indexSource, /castImportErrors/);
});

test('basketball backup includes WNBA casts while accepting its old plain document format', () => {
  assert.match(nbaSource, /sbplus-nba-backup-v2/);
  assert.match(nbaSource, /wnba-casts/);
  assert.match(nbaSource, /j\.nbaDoc \|\| j/);
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
