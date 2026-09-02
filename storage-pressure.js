/* localStorage 配額救援：主檔／卦永遠優先，可重建的自動備份在高水位時讓位。 */
(function (root, factory) {
  var api = factory();
  if (root) root.__storagePressure = api;
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

  return {
    BACKUP_KEYS: BACKUP_KEYS.slice(),
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    usedBytes: usedBytes,
    cleanup: cleanup,
    setCritical: setCritical,
    setBackup: setBackup,
    encodeEmergency: encodeEmergency,
    decodeEmergency: decodeEmergency
  };
});
