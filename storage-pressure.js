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

  return {
    BACKUP_KEYS: BACKUP_KEYS.slice(),
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    usedBytes: usedBytes,
    cleanup: cleanup,
    setCritical: setCritical,
    setBackup: setBackup
  };
});
