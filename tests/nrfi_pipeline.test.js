'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const pregame = require('../pregame-integration.js');
const scraper = require('../playsport_scraper.js');

test('逐局比分轉成結算卡四狀態，缺首局時保持待補而不猜測', () => {
  assert.equal(typeof pregame.firstInningResult, 'function');
  assert.deepEqual(
    pregame.firstInningResult({
      officialId: 'MLB_1', status: 'finished',
      lineScore: { away: ['0', '1'], home: ['0', '2'] },
    }),
    { status: 'nrfi', nrfi: true, awayFirst: 0, homeFirst: 0, officialId: 'MLB_1' },
  );
  assert.deepEqual(
    pregame.firstInningResult({
      officialId: 'NPB_1', status: 'finished',
      lineScore: { away: ['1'], home: ['0'] },
    }),
    { status: 'yrfi', nrfi: false, awayFirst: 1, homeFirst: 0, officialId: 'NPB_1' },
  );
  assert.deepEqual(
    pregame.firstInningResult({ officialId: 'KBO_1', status: 'finished', lineScore: null }),
    { status: 'pending', nrfi: null, awayFirst: null, homeFirst: null, officialId: 'KBO_1' },
  );
});

test('NRFI 工作流結果只增不減，完賽首局會以 officialId 永久累積', () => {
  assert.equal(typeof scraper.mergeNrfiStore, 'function');
  const oldStore = {
    updatedAt: '2026-08-01T00:00:00.000Z',
    games: {
      OLD: { officialId: 'OLD', league: 'MLB', date: '2026-07-01', status: 'nrfi', nrfi: true },
    },
  };
  const games = [{
    officialId: 'NEW', league: 'NPB', date: '2026-08-24', time: '17:00',
    awayTeam: '西武獅', homeTeam: '樂天金鷲', status: 'finished',
    lineScore: { away: ['0', '1'], home: ['0', '0'] },
  }];
  const merged = scraper.mergeNrfiStore(oldStore, games, '2026-08-24T12:00:00.000Z');
  assert.deepEqual(Object.keys(merged.games).sort(), ['NEW', 'OLD']);
  assert.deepEqual(merged.games.NEW, {
    officialId: 'NEW', league: 'NPB', date: '2026-08-24', time: '17:00',
    awayTeam: '西武獅', homeTeam: '樂天金鷲', status: 'nrfi', nrfi: true,
    awayFirst: 0, homeFirst: 0, source: 'playsport', updatedAt: '2026-08-24T12:00:00.000Z',
  });
});

test('首局內容沒有變化時保留原時間，不讓工作流每五分鐘產生空轉 commit', () => {
  const oldAt = '2026-08-24T12:00:00.000Z';
  const existing = {
    updatedAt: oldAt,
    games: {
      SAME: {
        officialId: 'SAME', league: 'MLB', date: '2026-08-24', time: '07:10',
        awayTeam: '勇士', homeTeam: '釀酒人', status: 'nrfi', nrfi: true,
        awayFirst: 0, homeFirst: 0, source: 'playsport', updatedAt: oldAt,
      },
    },
  };
  const merged = scraper.mergeNrfiStore(existing, [{
    officialId: 'SAME', league: 'MLB', date: '2026-08-24', time: '07:10',
    awayTeam: '勇士', homeTeam: '釀酒人', status: 'finished',
    lineScore: { away: ['0'], home: ['0'] },
  }], '2026-08-24T12:05:00.000Z');
  assert.deepEqual(merged, existing);
});

test('工作流將 NRFI 結果真正寫入累積檔，舊場不會被下一輪清掉', () => {
  assert.equal(typeof scraper.persistNrfiResults, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrfi-pipeline-'));
  const file = path.join(dir, 'nrfi_results.json');
  fs.writeFileSync(file, JSON.stringify({ games: { OLD: { officialId: 'OLD', nrfi: true } } }));
  scraper.persistNrfiResults([{
    officialId: 'NEW', league: 'MLB', date: '2026-08-24', time: '07:10',
    awayTeam: '勇士', homeTeam: '釀酒人', status: 'finished',
    lineScore: { away: ['0'], home: ['0'] },
  }], file, '2026-08-24T12:00:00.000Z');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.games).sort(), ['NEW', 'OLD']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('工作流重新啟動時從 data 主檔接續，不能只留下最近五天', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrfi-restart-'));
  const output = path.join(dir, 'nrfi_results.json');
  const seed = path.join(dir, 'data', 'nrfi_results.json');
  fs.mkdirSync(path.dirname(seed));
  fs.writeFileSync(seed, JSON.stringify({ games: { HISTORIC: { officialId: 'HISTORIC', nrfi: false } } }));
  scraper.persistNrfiResults([{
    officialId: 'RECENT', league: 'MLB', date: '2026-08-24', time: '07:10',
    awayTeam: '勇士', homeTeam: '釀酒人', status: 'finished',
    lineScore: { away: ['0'], home: ['0'] },
  }], output, '2026-08-24T12:00:00.000Z', seed);
  const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(Object.keys(saved.games).sort(), ['HISTORIC', 'RECENT']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('自動首局結果填入結算卡，但已由使用者手動選擇時絕不覆蓋', () => {
  assert.equal(typeof pregame.applyNrfiResultToControls, 'function');
  const dom = new JSDOM('<select id="settleNrfiStatus" data-source="pending"><option value="pending">待補</option><option value="nrfi">NRFI</option><option value="yrfi">YRFI</option><option value="canceled">取消</option></select><span id="settleNrfiEvidence"></span>');
  const doc = dom.window.document;
  pregame.applyNrfiResultToControls(doc, {
    status: 'nrfi', nrfi: true, awayFirst: 0, homeFirst: 0, officialId: 'MLB_1', source: 'playsport',
  });
  const select = doc.getElementById('settleNrfiStatus');
  assert.equal(select.value, 'nrfi');
  assert.equal(select.dataset.source, 'playsport');
  assert.equal(select.dataset.officialId, 'MLB_1');
  assert.match(doc.getElementById('settleNrfiEvidence').textContent, /自動.*0-0/);

  select.value = 'yrfi';
  select.dataset.source = 'manual';
  pregame.applyNrfiResultToControls(doc, {
    status: 'nrfi', nrfi: true, awayFirst: 0, homeFirst: 0, officialId: 'MLB_1', source: 'playsport',
  });
  assert.equal(select.value, 'yrfi');
  assert.equal(select.dataset.source, 'manual');
});
