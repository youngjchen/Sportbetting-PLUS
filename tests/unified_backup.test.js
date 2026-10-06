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

test('persistImport restores all present sports and unions every ledger', async () => {
  const oldBasketball = boardDoc('old-basketball');
  const storage = memoryStorage({ sportbetting_nba_doc_v1: JSON.stringify(oldBasketball) });
  const oldBaseballCast = { ts: '2026-10-05T01:00:00Z', officialId: 'A', market: 'ml', method: 'coin', old: true };
  const replacementCast = { ts: '2026-10-05T01:00:00Z', officialId: 'A', market: 'ml', method: 'coin', restored: true };
  const secondCast = { ts: '2026-10-06T01:00:00Z', officialId: 'B', market: 'spread', method: 'coin' };
  const largeStorage = fakeLargeStorage({
    'baseball-casts': [oldBaseballCast],
    'wnba-casts': [],
    'nhl-casts': []
  });
  const api = createUnifiedBackup({ storage, storagePressure, largeStorage });
  const payload = {
    __envelope: 'sbplus-all-sports-backup-v3',
    documents: {
      baseball: boardDoc('restored-baseball'),
      basketball: boardDoc('restored-basketball'),
      hockey: boardDoc('restored-hockey')
    },
    ledgers: {
      baseball: [replacementCast, secondCast],
      wnba: [{ ts: '2026-10-06T02:00:00Z', officialId: 'W', market: 'total', method: 'coin' }],
      nhl: [{ ts: '2026-10-06T03:00:00Z', officialId: 'H', market: 'ml', method: 'coin' }]
    }
  };
  let liveBaseball = null;

  const parsed = api.parseImport(JSON.stringify(payload), 'baseball');
  const report = await api.persistImport(parsed, {
    currentSport: 'baseball',
    setCurrentDoc(value) { liveBaseball = value; }
  });

  assert.deepEqual(liveBaseball, payload.documents.baseball);
  assert.deepEqual(JSON.parse(storage.getItem('sportbetting_nba_doc_v1')), payload.documents.basketball);
  assert.deepEqual(JSON.parse(storage.getItem('sportbetting_nhl_doc_v1')), payload.documents.hockey);
  assert.equal(report.ledgerCounts.baseball, 2);
  assert.equal(largeStorage.value('baseball-casts')[0].restored, undefined);
  assert.equal(largeStorage.value('baseball-casts')[1].restored, true);
  assert.equal(largeStorage.value('wnba-casts').length, 1);
  assert.equal(largeStorage.value('nhl-casts').length, 1);
});

test('legacy single-sport backups restore only their own sport', async () => {
  const cases = [
    {
      currentSport: 'baseball',
      payload: { __envelope: 'sbplus-backup-v2', doc: boardDoc('legacy-baseball'), dvManualCasts: [] },
      expected: 'legacy-baseball'
    },
    {
      currentSport: 'basketball',
      payload: { __envelope: 'sbplus-nba-backup-v2', nbaDoc: boardDoc('legacy-basketball'), dvManualCastsWnba: [] },
      expected: 'legacy-basketball'
    },
    {
      currentSport: 'hockey',
      payload: { __envelope: 'sbplus-nhl-backup-v1', nhlDoc: boardDoc('legacy-hockey'), dvManualCastsNhl: [] },
      expected: 'legacy-hockey'
    },
    {
      currentSport: 'baseball',
      payload: boardDoc('plain-baseball'),
      expected: 'plain-baseball'
    }
  ];

  for (const entry of cases) {
    const basketballBefore = boardDoc('basketball-before');
    const hockeyBefore = boardDoc('hockey-before');
    const storage = memoryStorage({
      sportbetting_nba_doc_v1: JSON.stringify(basketballBefore),
      sportbetting_nhl_doc_v1: JSON.stringify(hockeyBefore)
    });
    const api = createUnifiedBackup({ storage, storagePressure, largeStorage: fakeLargeStorage() });
    let liveDoc = null;
    const parsed = api.parseImport(JSON.stringify(entry.payload), entry.currentSport);
    await api.persistImport(parsed, { currentSport: entry.currentSport, setCurrentDoc(value) { liveDoc = value; } });
    assert.equal(liveDoc.boards['2026-10-06'].label, entry.expected);
    if (entry.currentSport !== 'basketball') {
      assert.deepEqual(JSON.parse(storage.getItem('sportbetting_nba_doc_v1')), basketballBefore);
    }
    if (entry.currentSport !== 'hockey') {
      assert.deepEqual(JSON.parse(storage.getItem('sportbetting_nhl_doc_v1')), hockeyBefore);
    }
  }
});

test('parseImport rejects a v3 file before writing when any supplied document is invalid', async () => {
  const storage = memoryStorage({ sportbetting_nba_doc_v1: JSON.stringify(boardDoc('untouched')) });
  const api = createUnifiedBackup({ storage, storagePressure, largeStorage: fakeLargeStorage() });
  assert.throws(() => api.parseImport(JSON.stringify({
    __envelope: 'sbplus-all-sports-backup-v3',
    documents: { baseball: boardDoc('valid'), basketball: { games: [] } },
    ledgers: {}
  }), 'baseball'), /basketball.*格式不符/);
  assert.equal(JSON.parse(storage.getItem('sportbetting_nba_doc_v1')).boards['2026-10-06'].label, 'untouched');
});
