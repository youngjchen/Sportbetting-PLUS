/* localStorage 配額救援：主檔／卦永遠優先，可重建的自動備份在高水位時讓位。 */
(function (root, factory) {
  var api = factory();
  if (root) {
    root.__storagePressure = api;
    root.__largeStorage = api.createLargeJsonStore({
      storage: root.localStorage,
      adapter: api.createIndexedDbAdapter(root.indexedDB)
    });
    // 兩頁共用同一個 origin；開任一頁都搬走兩份成長型 ledger，立即釋放 5 MB 小型區。
    Promise.all([
      root.__largeStorage.migrate('baseball-casts', 'dvManualCasts'),
      root.__largeStorage.migrate('wnba-casts', 'dvManualCastsWnba')
    ]).catch(function () {});
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEFAULT_LIMIT = 5 * 1024 * 1024;
  var BACKUP_KEYS = ['sportbetting_plus_autobackup', 'sportbetting_nba_doc_v1_auto'];

  function usedBytes(storage) {
    var total = 0;
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (key != null) total += (String(key).length + String(storage.getItem(key) || '').length) * 2;
    }
    return total;
  }

  function entryBytes(key, value) {
    return (String(key).length + String(value || '').length) * 2;
  }

  function cleanup(storage, force, limitBytes) {
    var limit = limitBytes || DEFAULT_LIMIT;
    var before = usedBytes(storage), removed = [];
    if (!force && before < limit * 0.85) return { before: before, after: before, removed: removed };
    BACKUP_KEYS.forEach(function (key) {
      if (storage.getItem(key) == null) return;
      storage.removeItem(key);
      removed.push(key);
    });
    return { before: before, after: usedBytes(storage), removed: removed };
  }

  function setCritical(storage, key, value, limitBytes) {
    try {
      storage.setItem(key, value);
      return { ok: true, removed: [] };
    } catch (firstError) {
      var relief = cleanup(storage, true, limitBytes);
      try {
        storage.setItem(key, value);
        return { ok: true, removed: relief.removed };
      } catch (finalError) {
        finalError.storageRelief = relief;
        throw finalError;
      }
    }
  }

  function setBackup(storage, key, value, maxRatio, limitBytes) {
    var limit = limitBytes || DEFAULT_LIMIT;
    var ratio = maxRatio == null ? 0.80 : maxRatio;
    var old = storage.getItem(key);
    var projected = usedBytes(storage) - (old == null ? 0 : entryBytes(key, old)) + entryBytes(key, value);
    if (projected > limit * ratio) {
      storage.removeItem(key);
      return false;
    }
    try {
      storage.setItem(key, value);
      return true;
    } catch (error) {
      storage.removeItem(key);
      return false;
    }
  }

  /* pagehide 無法等待 CompressionStream，所以用同步 LZW 只保住最後一次尚未落地的變更。
     平常存檔仍走 gzip；這個 lz16: 格式只是關頁保命路徑。 */
  function lzwCompress(text) {
    var bytes = new TextEncoder().encode(String(text));
    if (!bytes.length) return '';
    var dict = new Map(), nextCode = 257, prefix = bytes[0], codes = [];
    for (var i = 1; i < bytes.length; i++) {
      var byte = bytes[i], key = prefix * 256 + byte, found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      codes.push(prefix);
      if (nextCode < 65535) dict.set(key, nextCode++);
      else {
        codes.push(256);                 // clear code：壓縮與解壓同時重置字典
        dict = new Map();
        nextCode = 257;
      }
      prefix = byte;
    }
    codes.push(prefix);
    var chunks = [];
    for (var j = 0; j < codes.length; j += 8192) {
      chunks.push(String.fromCharCode.apply(null, codes.slice(j, j + 8192)));
    }
    return chunks.join('');
  }

  function lzwDecompress(compressed) {
    if (!compressed) return '';
    var dict = [], nextCode = 257, previous = null, chunks = [];
    for (var i = 0; i < compressed.length; i++) {
      var code = compressed.charCodeAt(i);
      if (code === 256) {
        dict = [];
        nextCode = 257;
        previous = null;
        continue;
      }
      var entry;
      if (code < 256) entry = String.fromCharCode(code);
      else if (dict[code] !== undefined) entry = dict[code];
      else if (code === nextCode && previous !== null) entry = previous + previous.charAt(0);
      else throw new Error('緊急存檔的壓縮字典已損壞');
      chunks.push(entry);
      if (previous !== null && nextCode < 65535) dict[nextCode++] = previous + entry.charAt(0);
      previous = entry;
    }
    var binary = chunks.join(''), bytes = new Uint8Array(binary.length);
    for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
    return new TextDecoder().decode(bytes);
  }

  function encodeEmergency(text) {
    return 'lz16:' + lzwCompress(text);
  }

  function decodeEmergency(payload) {
    payload = String(payload || '');
    if (payload.slice(0, 5) !== 'lz16:') throw new Error('不是 lz16 緊急存檔');
    return lzwDecompress(payload.slice(5));
  }

  function checksum(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  async function decodeLegacyPayload(raw) {
    raw = String(raw || '');
    if (!raw) return [];
    if (raw.slice(0, 3) === 'gz:') {
      if (typeof DecompressionStream !== 'function') throw new Error('瀏覽器不支援 gzip 解壓');
      var bin = atob(raw.slice(3)), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      return JSON.parse(text) || [];
    }
    if (raw.slice(0, 5) === 'lz16:') return JSON.parse(decodeEmergency(raw)) || [];
    return JSON.parse(raw) || [];
  }

  async function encodeLegacyPayload(value) {
    var text = JSON.stringify(value);
    if (typeof CompressionStream !== 'function') return text;
    var bytes = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    var chunks = [];
    for (var i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    return 'gz:' + btoa(chunks.join(''));
  }

  function envelopeFor(value) {
    var text = JSON.stringify(value);
    return {
      version: 1,
      data: value,
      count: Array.isArray(value) ? value.length : null,
      jsonLength: text.length,
      checksum: checksum(text),
      updatedAt: new Date().toISOString()
    };
  }

  function validEnvelope(envelope) {
    if (!envelope || envelope.version !== 1 || !Object.prototype.hasOwnProperty.call(envelope, 'data')) return false;
    var text = JSON.stringify(envelope.data);
    return envelope.jsonLength === text.length && envelope.checksum === checksum(text) &&
      (envelope.count == null || (Array.isArray(envelope.data) && envelope.count === envelope.data.length));
  }

  function mergeCastLedgers(current, legacy) {
    if (!Array.isArray(current) || !Array.isArray(legacy)) return legacy;
    var keyed = new Map(), unkeyed = [];
    function add(entry) {
      if (!entry || typeof entry !== 'object') { unkeyed.push(entry); return; }
      var key = (entry.ts || '') + '|' + (entry.officialId || '') + '|' + (entry.market || '') + '|' + (entry.method || '');
      if (entry.ts) keyed.set(key, entry);
      else unkeyed.push(entry);
    }
    legacy.forEach(add);   // IndexedDB 是較新的主檔，同鍵由 current 覆蓋 legacy
    current.forEach(add);
    var merged = Array.from(keyed.values()).concat(unkeyed);
    merged.sort(function (a, b) { return (a && a.ts || '') < (b && b.ts || '') ? 1 : ((a && a.ts || '') > (b && b.ts || '') ? -1 : 0); });
    return merged;
  }

  function createIndexedDbAdapter(indexedDB) {
    if (!indexedDB || typeof indexedDB.open !== 'function') return null;
    var opened = null;
    function db() {
      if (opened) return opened;
      opened = new Promise(function (resolve, reject) {
        var request = indexedDB.open('sportbetting_plus_large_v1', 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains('payloads')) request.result.createObjectStore('payloads');
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('IndexedDB 開啟失敗')); };
      });
      return opened;
    }
    function request(mode, action) {
      return db().then(function (database) {
        return new Promise(function (resolve, reject) {
          var tx = database.transaction('payloads', mode);
          var store = tx.objectStore('payloads');
          var req = action(store);
          req.onsuccess = function () { resolve(req.result == null ? null : req.result); };
          req.onerror = function () { reject(req.error || new Error('IndexedDB 操作失敗')); };
        });
      });
    }
    return {
      get: function (key) { return request('readonly', function (store) { return store.get(key); }); },
      put: function (key, value) { return request('readwrite', function (store) { return store.put(value, key); }); },
      delete: function (key) { return request('readwrite', function (store) { return store.delete(key); }); },
      list: function () { return request('readonly', function (store) { return store.getAll(); }).then(function (rows) { return rows || []; }); }
    };
  }

  function createLargeJsonStore(options) {
    options = options || {};
    var storage = options.storage || null;
    var adapter = options.adapter || null;

    async function writeIndexed(key, value) {
      if (!adapter) throw new Error('IndexedDB 不可用');
      var envelope = envelopeFor(value);
      await adapter.put(key, envelope);
      var verified = await adapter.get(key);
      if (!validEnvelope(verified) || verified.checksum !== envelope.checksum) throw new Error('IndexedDB 寫入驗證失敗');
      return envelope;
    }

    async function readJSON(key, legacyKey) {
      var idbError = null;
      if (adapter) {
        try {
          var stored = await adapter.get(key);
          if (validEnvelope(stored)) return stored.data;
          if (stored != null) idbError = new Error('IndexedDB 資料驗證失敗');
        } catch (error) { idbError = error; }
      }
      var legacyRaw = storage && legacyKey ? storage.getItem(legacyKey) : null;
      if (legacyRaw) return await decodeLegacyPayload(legacyRaw);
      if (idbError) throw idbError;
      return [];
    }

    async function writeJSON(key, value, legacyKey) {
      try {
        var envelope = await writeIndexed(key, value);
        if (storage && legacyKey) storage.removeItem(legacyKey);
        return { backend: 'indexeddb', count: envelope.count, bytes: envelope.jsonLength * 2 };
      } catch (error) {
        if (!storage || !legacyKey) throw error;
        var payload = await encodeLegacyPayload(value);
        if (typeof setCritical === 'function') setCritical(storage, legacyKey, payload);
        else storage.setItem(legacyKey, payload);
        return { backend: 'localstorage', count: Array.isArray(value) ? value.length : null, bytes: payload.length * 2, error: error };
      }
    }

    async function migrate(key, legacyKey) {
      if (!storage || !legacyKey) return { backend: adapter ? 'indexeddb' : 'localstorage', migrated: false };
      var raw = storage.getItem(legacyKey);
      if (!raw) return { backend: adapter ? 'indexeddb' : 'localstorage', migrated: false };
      var value;
      try { value = await decodeLegacyPayload(raw); }
      catch (error) { return { backend: 'localstorage', migrated: false, error: error }; }
      try {
        var current = await adapter.get(key);
        if (current != null && !validEnvelope(current)) throw new Error('IndexedDB 資料驗證失敗');
        if (validEnvelope(current)) value = mergeCastLedgers(current.data, value);
        var envelope = await writeIndexed(key, value);
        storage.removeItem(legacyKey);
        return { backend: 'indexeddb', migrated: true, count: envelope.count, bytes: envelope.jsonLength * 2 };
      } catch (error) {
        // 驗證失敗時不改寫、不移除舊資料，讓使用者仍保有原始可復原副本。
        return { backend: 'localstorage', migrated: false, count: Array.isArray(value) ? value.length : null, error: error };
      }
    }

    async function clearJSON(key, legacyKey) {
      if (adapter) try { await adapter.delete(key); } catch (_) {}
      if (storage && legacyKey) storage.removeItem(legacyKey);
    }

    async function stats() {
      if (!adapter || typeof adapter.list !== 'function') return { backend: 'localstorage', bytes: 0, entries: 0 };
      try {
        var rows = await adapter.list(), bytes = 0, entries = 0;
        rows.forEach(function (row) { if (validEnvelope(row)) { bytes += row.jsonLength * 2; entries += 1; } });
        return { backend: 'indexeddb', bytes: bytes, entries: entries };
      } catch (_) { return { backend: 'localstorage', bytes: 0, entries: 0 }; }
    }

    return { readJSON: readJSON, writeJSON: writeJSON, migrate: migrate, clearJSON: clearJSON, stats: stats };
  }

  return {
    BACKUP_KEYS: BACKUP_KEYS.slice(),
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    usedBytes: usedBytes,
    cleanup: cleanup,
    setCritical: setCritical,
    setBackup: setBackup,
    encodeEmergency: encodeEmergency,
    decodeEmergency: decodeEmergency,
    decodeLegacyPayload: decodeLegacyPayload,
    encodeLegacyPayload: encodeLegacyPayload,
    createIndexedDbAdapter: createIndexedDbAdapter,
    createLargeJsonStore: createLargeJsonStore,
    mergeCastLedgers: mergeCastLedgers
  };
});
