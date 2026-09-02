'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const pressure = require('../storage-pressure.js');

const MB = 1024 * 1024;

function quotaStorage(limitBytes, entries) {
  const data = new Map(Object.entries(entries || {}));
  function bytesWith(key, value) {
    const next = new Map(data);
    if (key != null) next.set(String(key), String(value));
    let total = 0;
    for (const [k, v] of next) total += (k.length + v.length) * 2;
    return total;
  }
  return {
    get length() { return data.size; },
    key(index) { return Array.from(data.keys())[index] ?? null; },
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    removeItem(key) { data.delete(String(key)); },
    setItem(key, value) {
      if (bytesWith(key, value) > limitBytes) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      data.set(String(key), String(value));
    },
  };
}

test('pagehide saves the newest oversized board in a synchronously readable compressed format', async () => {
  const today = new Date().toLocaleDateString('sv-SE');
  const initialDoc = {
    version: 2,
    activeDate: today,
    boards: { [today]: { items: [] } },
    games: [],
    padding: '老虎雙城台彩讓分'.repeat(220000),
    testRevision: 'before',
  };
  const storage = quotaStorage(5 * MB, {
    sportbetting_plus_doc_v2: pressure.encodeEmergency(JSON.stringify(initialDoc)),
    dvManualCasts: 'x'.repeat(Math.floor(1.28 * MB / 2)),
    dvManualCastsWnba: 'x'.repeat(Math.floor(0.59 * MB / 2)),
    sportbetting_nba_doc_v1: 'x'.repeat(Math.floor(0.38 * MB / 2)),
  });

  let html = fs.readFileSync('index.html', 'utf8');
  html = html.replace(/<script\s+src=[^>]*><\/script>/g, '');
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: 'https://x.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(win) {
      Object.defineProperty(win, 'localStorage', { value: storage, configurable: true });
      win.__storagePressure = pressure;
      win.TextEncoder = TextEncoder;
      win.TextDecoder = TextDecoder;
      // 這裡只測 pagehide 的同步保命路徑；關掉原生 gzip，避免開機自動備份在背景開壓大檔。
      win.CompressionStream = undefined;
      win.DecompressionStream = undefined;
      win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.HTMLCanvasElement.prototype.getContext = () => null;
      win.fetch = () => Promise.reject(new Error('offline-test'));
      win.scrollTo = () => {};
      win.alert = () => {};
      win.confirm = () => false;
      win.prompt = () => null;
      Object.defineProperty(win, 'innerWidth', { value: 1300, configurable: true });
    },
  });

  try {
    await new Promise(resolve => setTimeout(resolve, 350));
    dom.window.eval('doc.testRevision = "after-pagehide"; save();');
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));

    const stored = storage.getItem('sportbetting_plus_doc_v2');
    assert.equal(stored.startsWith('lz16:'), true);
    const savedDoc = JSON.parse(pressure.decodeEmergency(stored));
    assert.equal(savedDoc.testRevision, 'after-pagehide');
    assert.equal(savedDoc.padding, initialDoc.padding);

    dom.window.eval(fs.readFileSync('github-sync.js', 'utf8'));
    const syncDoc = JSON.parse(await dom.window.__ghSync.localDocPlain());
    assert.equal(syncDoc.testRevision, 'after-pagehide', '雲端同步也必須讀得懂緊急存檔');
  } finally {
    dom.window.close();
  }
});
