const test = require('node:test');
const assert = require('node:assert/strict');
const storagePressure = require('../storage-pressure.js');
const createUnifiedBackup = require('../unified-backup.js');

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); }
  };
}

function boardDoc(label) {
  return { activeDate: '2026-10-06', boards: { '2026-10-06': { label, items: [] } }, games: [] };
}

function isBoardDoc(value) {
  return !!(value && typeof value === 'object' && value.boards && typeof value.boards === 'object');
}

function fakeLargeStorage(seed = {}, failures = {}) {
  const values = new Map(Object.entries(seed));
  return {
    async readJSON(key) {
      if (failures.read === key) throw new Error('UnknownError');
      return values.has(key) ? values.get(key) : [];
    },
    async writeJSON(key, value) {
      if (failures.write === key) throw new Error('write failed');
      values.set(key, value);
    },
    value(key) { return values.get(key); }
  };
}

test('collectPayload includes every registered sport and prefers the live document', async () => {
  const baseballStored = boardDoc('baseball-stored');
  const baseballLive = boardDoc('baseball-live');
  const basketball = boardDoc('basketball');
  const hockey = boardDoc('hockey');
  const future = boardDoc('future');
  const storage = memoryStorage({
    sportbetting_plus_doc_v2: JSON.stringify(baseballStored),
    sportbetting_nba_doc_v1: JSON.stringify(basketball),
    sportbetting_nhl_doc_v1: JSON.stringify(hockey),
    future_doc: JSON.stringify(future)
  });
  const api = createUnifiedBackup({ storage, storagePressure, largeStorage: fakeLargeStorage() });
  api.registerSport({ id: 'future', docKey: 'future_doc', validateDocument: isBoardDoc });

  const result = await api.collectPayload({ currentSport: 'baseball', currentDoc: baseballLive });

  assert.equal(result.payload.__envelope, 'sbplus-all-sports-backup-v3');
  assert.equal(result.payload.documents.baseball, baseballLive);
  assert.deepEqual(Object.keys(result.payload.documents).sort(), ['baseball', 'basketball', 'future', 'hockey']);
  assert.deepEqual(result.payload.documents.future, future);
});

test('collectPayload decodes plain JSON, gzip and emergency documents', async () => {
  const originalCompression = globalThis.CompressionStream;
  const originalDecompression = globalThis.DecompressionStream;
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') {
    test.skip('Node runtime has no CompressionStream support');
    return;
  }
  const baseball = boardDoc('baseball-gzip');
  const basketball = boardDoc('basketball-lz16');
  const hockey = boardDoc('hockey-json');
  const storage = memoryStorage({
    sportbetting_plus_doc_v2: await storagePressure.encodeLegacyPayload(baseball),
    sportbetting_nba_doc_v1: storagePressure.encodeEmergency(JSON.stringify(basketball)),
    sportbetting_nhl_doc_v1: JSON.stringify(hockey)
  });
  const api = createUnifiedBackup({ storage, storagePressure, largeStorage: fakeLargeStorage() });

  const result = await api.collectPayload({ currentSport: 'hockey', currentDoc: hockey });

  assert.deepEqual(result.payload.documents.baseball, baseball);
  assert.deepEqual(result.payload.documents.basketball, basketball);
  assert.deepEqual(result.payload.documents.hockey, hockey);
  globalThis.CompressionStream = originalCompression;
  globalThis.DecompressionStream = originalDecompression;
});

test('a broken secondary document or ledger does not block the backup', async () => {
  const storage = memoryStorage({
    sportbetting_plus_doc_v2: JSON.stringify(boardDoc('baseball')),
    sportbetting_nba_doc_v1: '{broken',
    sportbetting_nhl_doc_v1: JSON.stringify(boardDoc('hockey'))
  });
  const largeStorage = fakeLargeStorage({ 'baseball-casts': [{ ts: '1' }] }, { read: 'wnba-casts' });
  const api = createUnifiedBackup({ storage, storagePressure, largeStorage });

  const result = await api.collectPayload({ currentSport: 'baseball', currentDoc: boardDoc('live') });

  assert.deepEqual(result.payload.documents.basketball, null);
  assert.deepEqual(result.payload.ledgers.wnba, []);
  assert.ok(result.payload.warnings.some(message => message.includes('basketball')));
  assert.ok(result.payload.warnings.some(message => message.includes('WNBA')));
  assert.equal(result.payload.sources.documents.basketball, 'unavailable');
  assert.equal(result.payload.sources.ledgers.wnba, 'unavailable');
});

test('an invalid current document blocks downloading an empty-looking backup', async () => {
  const api = createUnifiedBackup({ storage: memoryStorage(), storagePressure, largeStorage: fakeLargeStorage() });
  await assert.rejects(
    api.collectPayload({ currentSport: 'baseball', currentDoc: { games: [] } }),
    /目前頁面的盤面資料格式不符/
  );
});
