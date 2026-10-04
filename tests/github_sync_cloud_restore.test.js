'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const DOC_KEY = 'sportbetting_plus_doc_v2';

function bytesResponse(value, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function statusResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() { return new ArrayBuffer(0); },
    async text() { return ''; },
  };
}

function loadSync({ localDoc = null, casts = [], fetchImpl, scheduledTimers = null }) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://youngjchen.github.io/Sportbetting-PLUS/',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.TextEncoder = TextEncoder;
  win.TextDecoder = TextDecoder;
  win.CompressionStream = undefined;
  win.DecompressionStream = undefined;
  win.fetch = fetchImpl;
  win.setTimeout = scheduledTimers
    ? (fn, ms) => { scheduledTimers.push({ fn, ms }); return scheduledTimers.length; }
    : () => 0;
  win.clearTimeout = () => {};
  win.alert = () => {};
  win.confirm = () => false;
  win.prompt = () => null;
  if (localDoc) win.localStorage.setItem(DOC_KEY, JSON.stringify(localDoc));

  let storedCasts = casts;
  win.__largeStorage = {
    async readJSON() { return storedCasts; },
    async writeJSON(_storeKey, value) { storedCasts = value; return true; },
  };
  win.eval(fs.readFileSync('github-sync.js', 'utf8'));
  return { dom, win, readStoredCasts: () => storedCasts };
}

test('fresh browser restores divination casts from public state and refreshes the visible cache', async () => {
  const calls = [];
  const cloud = [
    { ts: '2026-10-01T01:00:00+08:00', officialId: 'A', market: 'ml', method: 'liuyao' },
    { ts: '2026-10-01T02:00:00+08:00', officialId: 'B', market: 'hd', method: 'qiuqian' },
  ];
  const ctx = loadSync({
    fetchImpl: async url => { calls.push(String(url)); return bytesResponse(cloud); },
  });
  let updates = 0;
  ctx.win.addEventListener('sbplus-casts-updated', event => {
    updates++;
    assert.equal(event.detail.storeKey, 'baseball-casts');
  });

  try {
    const result = await ctx.win.__dvSync.pull(true);
    assert.equal(result.ok, true);
    assert.equal(ctx.readStoredCasts().length, 2);
    assert.equal(updates, 1);
    assert.equal(calls.some(url => url.includes('api.github.com')), false);
    assert.equal(calls[0].includes('/Sportbetting-PLUS/state/dv_casts.json.gz'), true);
  } finally {
    ctx.dom.window.close();
  }
});

test('cast backup aborts when the authenticated latest-state read fails instead of merging stale public data', async () => {
  const calls = [];
  let puts = 0;
  const local = [{ ts: '2026-10-05T01:00:00+08:00', officialId: 'LOCAL', market: 'ml', method: 'liuyao' }];
  const stalePublic = [{ ts: '2026-10-04T01:00:00+08:00', officialId: 'STALE', market: 'ml', method: 'liuyao' }];
  const ctx = loadSync({
    casts: local,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (options.method === 'PUT') { puts++; return statusResponse(200); }
      if (String(url).includes('api.github.com')) return statusResponse(500);
      return bytesResponse(stalePublic);
    },
  });
  ctx.win.localStorage.setItem('gh_sync_pat', 'test-token');

  try {
    const result = await ctx.win.__dvSync.push(true);
    assert.equal(result.ok, false);
    assert.equal(puts, 0);
    assert.equal(calls.some(call => call.url.includes('raw.githubusercontent.com')), false);
    assert.equal(calls.some(call => call.url.includes('/state/dv_casts.json.gz') && !call.url.includes('api.github.com')), false);
  } finally {
    ctx.dom.window.close();
  }
});

test('an empty board shell bootstraps the populated public board state', async () => {
  const calls = [];
  const cloudDoc = {
    version: 2,
    activeDate: '2026-10-01',
    boards: { '2026-10-01': { items: [{ type: 'match', away: 'A', home: 'B' }] } },
    games: [{ sid: 'restored-game', date: '2026-10-01' }],
  };
  const emptyShell = {
    version: 2,
    activeDate: '2026-10-05',
    boards: { '2026-10-05': { items: [] } },
    games: [],
  };
  const ctx = loadSync({
    localDoc: emptyShell,
    fetchImpl: async url => { calls.push(String(url)); return bytesResponse(cloudDoc); },
  });

  try {
    assert.equal(typeof ctx.win.__ghSync.restoreEmptyBoardFromCloud, 'function');
    assert.equal(await ctx.win.__ghSync.restoreEmptyBoardFromCloud(), true);
    const restored = JSON.parse(ctx.win.localStorage.getItem(DOC_KEY));
    assert.equal(restored.games.length, 1);
    assert.equal(restored.games[0].sid, 'restored-game');
    assert.equal(calls.some(url => url.includes('api.github.com')), false);
    assert.equal(calls[0].includes('/Sportbetting-PLUS/state/board_state.json.gz'), true);
  } finally {
    ctx.dom.window.close();
  }
});

test('automatic board restore never overwrites meaningful local data', async () => {
  let fetches = 0;
  const localDoc = {
    version: 2,
    activeDate: '2026-10-05',
    boards: { '2026-10-05': { items: [{ type: 'match', away: 'Local', home: 'Only' }] } },
    games: [],
  };
  const ctx = loadSync({
    localDoc,
    fetchImpl: async () => { fetches++; return bytesResponse({ boards: {} }); },
  });

  try {
    assert.equal(await ctx.win.__ghSync.restoreEmptyBoardFromCloud(), false);
    assert.equal(fetches, 0);
    assert.equal(JSON.parse(ctx.win.localStorage.getItem(DOC_KEY)).boards['2026-10-05'].items[0].away, 'Local');
  } finally {
    ctx.dom.window.close();
  }
});

test('automatic board restore never overwrites a meaningful unsaved in-memory board', async () => {
  let fetches = 0;
  const emptyShell = {
    version: 2,
    activeDate: '2026-10-05',
    boards: { '2026-10-05': { items: [] } },
    games: [],
  };
  const ctx = loadSync({
    localDoc: emptyShell,
    fetchImpl: async () => {
      fetches++;
      return bytesResponse({
        version: 2,
        boards: { '2026-10-04': { items: [{ type: 'match', away: 'Cloud', home: 'Only' }] } },
        games: [],
      });
    },
  });
  ctx.win.__boardMemoryHasMeaningfulData = () => true;

  try {
    assert.equal(await ctx.win.__ghSync.restoreEmptyBoardFromCloud(), false);
    assert.equal(fetches, 0);
    assert.equal(ctx.win.__boardCloudRestorePending, undefined);
  } finally {
    ctx.dom.window.close();
  }
});

test('automatic board restore rechecks memory after the cloud fetch finishes', async () => {
  let resolveFetch;
  let memoryHasData = false;
  const ctx = loadSync({
    localDoc: {
      version: 2,
      activeDate: '2026-10-05',
      boards: { '2026-10-05': { items: [] } },
      games: [],
    },
    fetchImpl: () => new Promise(resolve => {
      resolveFetch = () => resolve(bytesResponse({
        version: 2,
        boards: { '2026-10-04': { items: [{ type: 'match', away: 'Cloud', home: 'Only' }] } },
        games: [],
      }));
    }),
  });
  ctx.win.__boardMemoryHasMeaningfulData = () => memoryHasData;

  try {
    const restoring = ctx.win.__ghSync.restoreEmptyBoardFromCloud();
    while (!resolveFetch) await new Promise(resolve => setTimeout(resolve, 0));
    memoryHasData = true;
    resolveFetch();
    assert.equal(await restoring, false);
    assert.equal(ctx.win.__boardCloudRestorePending, undefined);
  } finally {
    ctx.dom.window.close();
  }
});

test('automatic board union repairs missing history and dates without replacing local cards', async () => {
  const localDoc = {
    version: 2,
    activeDate: '2026-10-05',
    boards: {
      '2026-10-05': { items: [{ type: 'match', away: 'Local', home: 'Only', gameTime: '12:00' }] },
    },
    games: [],
  };
  const cloudDoc = {
    version: 2,
    activeDate: '2026-10-04',
    boards: {
      '2026-10-04': { items: [{ type: 'match', away: 'Cloud', home: 'Recovered', gameTime: '08:00' }] },
    },
    games: [{ sid: 'cloud-history', date: '2026-10-04', awayTeam: 'Cloud', homeTeam: 'Recovered', gameTime: '08:00' }],
  };
  const ctx = loadSync({
    localDoc,
    fetchImpl: async () => bytesResponse(cloudDoc),
  });
  ctx.win.__boardMemoryHasMeaningfulData = () => true;
  ctx.win.__installCloudBoardUnion = (payload, expectedRaw) => {
    assert.equal(ctx.win.localStorage.getItem(DOC_KEY), expectedRaw);
    ctx.win.localStorage.setItem(DOC_KEY, payload);
    return true;
  };

  try {
    assert.equal(typeof ctx.win.__ghSync.mergeMissingBoardDataFromCloud, 'function');
    assert.equal(await ctx.win.__ghSync.mergeMissingBoardDataFromCloud(), true);
    const restored = JSON.parse(ctx.win.localStorage.getItem(DOC_KEY));
    assert.equal(restored.games.length, 1);
    assert.equal(restored.games[0].sid, 'cloud-history');
    assert.equal(restored.boards['2026-10-04'].items[0].away, 'Cloud');
    assert.equal(restored.boards['2026-10-05'].items[0].away, 'Local');
  } finally {
    ctx.dom.window.close();
  }
});

test('automatic board union never resurrects cards deleted from an existing local date', async () => {
  const localDoc = {
    version: 2,
    activeDate: '2026-10-05',
    boards: {
      '2026-10-04': { items: [] },
      '2026-10-05': { items: [{ type: 'match', away: 'Local', home: 'Card', gameTime: '12:00' }] },
    },
    games: [],
  };
  const cloudDoc = {
    version: 2,
    activeDate: '2026-10-04',
    boards: {
      '2026-10-04': { items: [{ type: 'match', away: 'Deleted', home: 'Must Stay Deleted', gameTime: '08:00' }] },
    },
    games: [{ sid: 'history-still-restored', date: '2026-10-04', awayTeam: 'Deleted', homeTeam: 'Must Stay Deleted', gameTime: '08:00' }],
  };
  const ctx = loadSync({ localDoc, fetchImpl: async () => bytesResponse(cloudDoc) });
  ctx.win.__boardMemoryHasMeaningfulData = () => true;
  ctx.win.__installCloudBoardUnion = (payload) => {
    ctx.win.localStorage.setItem(DOC_KEY, payload);
    return true;
  };

  try {
    assert.equal(await ctx.win.__ghSync.mergeMissingBoardDataFromCloud(), true);
    const restored = JSON.parse(ctx.win.localStorage.getItem(DOC_KEY));
    assert.equal(restored.games.length, 1);
    assert.deepEqual(restored.boards['2026-10-04'].items, []);
  } finally {
    ctx.dom.window.close();
  }
});

test('automatic board restore schedules a bounded retry after an atomic install race', async () => {
  const scheduled = [];
  const localDoc = {
    version: 2,
    activeDate: '2026-10-05',
    boards: { '2026-10-05': { items: [{ type: 'match', away: 'Local', home: 'Card', gameTime: '12:00' }] } },
    games: [],
  };
  const cloudDoc = {
    version: 2,
    activeDate: '2026-10-04',
    boards: { '2026-10-04': { items: [{ type: 'match', away: 'Cloud', home: 'Recovered', gameTime: '08:00' }] } },
    games: [],
  };
  const ctx = loadSync({ localDoc, fetchImpl: async () => bytesResponse(cloudDoc), scheduledTimers: scheduled });
  ctx.win.__boardMemoryHasMeaningfulData = () => true;
  ctx.win.__installCloudBoardUnion = () => {
    ctx.win.__boardCloudUnionRetryNeeded = true;
    return false;
  };

  try {
    const initial = scheduled.find(timer => timer.ms === 1200);
    assert.ok(initial, 'initial board auto-restore timer should exist');
    const beforeRetry = scheduled.length;
    await initial.fn();
    assert.equal(scheduled.length, beforeRetry + 1);
    assert.equal(scheduled.at(-1).ms, 2000);
  } finally {
    ctx.dom.window.close();
  }
});
