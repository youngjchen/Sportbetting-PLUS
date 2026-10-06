/* 全運動單一備份：所有頁面共用同一份可擴充註冊表與備份格式。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.__unifiedBackup = factory({
    storage: root.localStorage,
    storagePressure: root.__storagePressure,
    largeStorage: root.__largeStorage
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function createUnifiedBackup(dependencies) {
  'use strict';

  dependencies = dependencies || {};
  var storage = dependencies.storage || null;
  var storagePressure = dependencies.storagePressure || null;
  var largeStorage = dependencies.largeStorage || null;
  var sports = new Map();

  function isBoardDocument(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value) &&
      value.boards && typeof value.boards === 'object' && !Array.isArray(value.boards));
  }

  function registerSport(definition) {
    if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) {
      throw new Error('運動註冊缺少 id');
    }
    if (typeof definition.docKey !== 'string' || !definition.docKey) {
      throw new Error('運動註冊缺少 docKey');
    }
    var normalized = Object.assign({}, definition, {
      id: definition.id.trim(),
      validateDocument: typeof definition.validateDocument === 'function' ? definition.validateDocument : isBoardDocument,
      ledgers: Array.isArray(definition.ledgers) ? definition.ledgers.map(function (ledger) { return Object.assign({}, ledger); }) : []
    });
    sports.set(normalized.id, normalized);
    return api;
  }

  function listSports() {
    return Array.from(sports.values()).map(function (definition) {
      return Object.assign({}, definition, { ledgers: definition.ledgers.map(function (ledger) { return Object.assign({}, ledger); }) });
    });
  }

  async function decodeStoredDocument(raw) {
    if (raw == null || raw === '') return null;
    if (storagePressure && typeof storagePressure.decodeLegacyPayload === 'function') {
      return await storagePressure.decodeLegacyPayload(raw);
    }
    raw = String(raw);
    if (raw.slice(0, 3) === 'gz:' || raw.slice(0, 5) === 'lz16:') {
      throw new Error('缺少壓縮資料解碼器');
    }
    return JSON.parse(raw);
  }

  function uniqueLedgers() {
    var found = new Map();
    sports.forEach(function (sport) {
      sport.ledgers.forEach(function (ledger) {
        if (!ledger || !ledger.id || found.has(ledger.id)) return;
        found.set(ledger.id, Object.assign({ sportId: sport.id }, ledger));
      });
    });
    return Array.from(found.values());
  }

  async function readLedger(ledger) {
    if (largeStorage && typeof largeStorage.readJSON === 'function') {
      return await largeStorage.readJSON(ledger.storeKey, ledger.legacyKey);
    }
    if (!storage || !ledger.legacyKey) return [];
    var raw = storage.getItem(ledger.legacyKey);
    if (!raw) return [];
    return await decodeStoredDocument(raw);
  }

  async function collectOneLedger(ledger, options) {
    if (options.rescue) {
      return { data: [], source: 'skipped', complete: false, warning: (ledger.label || ledger.id) + '在救援模式暫不讀取。' };
    }
    var readCloud = ledger.cloudReaderOption && typeof options[ledger.cloudReaderOption] === 'function'
      ? options[ledger.cloudReaderOption]
      : null;
    if (storagePressure && typeof storagePressure.salvageLedger === 'function') {
      return await storagePressure.salvageLedger({
        label: ledger.label || ledger.id,
        readLocal: function () { return readLedger(ledger); },
        readCloud: readCloud
      });
    }
    try {
      var data = await readLedger(ledger);
      if (!Array.isArray(data)) throw new Error((ledger.label || ledger.id) + '格式不是陣列');
      return { data: data, source: 'local', complete: true, warning: '' };
    } catch (error) {
      return {
        data: [], source: 'unavailable', complete: false,
        warning: (ledger.label || ledger.id) + '目前無法讀取，已保留其他運動資料。 ' + (error && error.message || error)
      };
    }
  }

  async function collectPayload(options) {
    options = options || {};
    var currentSport = sports.get(options.currentSport);
    if (!currentSport) throw new Error('目前頁面的運動尚未登記：' + (options.currentSport || '未知'));
    if (!currentSport.validateDocument(options.currentDoc)) {
      throw new Error('目前頁面的盤面資料格式不符，已停止下載以免產生空白備份。');
    }

    var documents = {}, ledgers = {}, warnings = [];
    var sources = { documents: {}, ledgers: {} };
    for (var sport of sports.values()) {
      if (sport.id === currentSport.id) {
        documents[sport.id] = options.currentDoc;
        sources.documents[sport.id] = 'live';
        continue;
      }
      try {
        var raw = storage && typeof storage.getItem === 'function' ? storage.getItem(sport.docKey) : null;
        if (raw == null || raw === '') {
          documents[sport.id] = null;
          sources.documents[sport.id] = 'missing';
          continue;
        }
        var decoded = await decodeStoredDocument(raw);
        if (!sport.validateDocument(decoded)) throw new Error('盤面格式不符');
        documents[sport.id] = decoded;
        sources.documents[sport.id] = 'local';
      } catch (error) {
        documents[sport.id] = null;
        sources.documents[sport.id] = 'unavailable';
        warnings.push(sport.id + ' 盤面目前無法讀取，未影響其他運動備份。 ' + (error && error.message || error));
      }
    }

    for (var ledger of uniqueLedgers()) {
      var result;
      try {
        result = await collectOneLedger(ledger, options);
      } catch (error) {
        result = {
          data: [], source: 'unavailable', complete: false,
          warning: (ledger.label || ledger.id) + '目前無法讀取，已保留其他運動資料。 ' + (error && error.message || error)
        };
      }
      ledgers[ledger.id] = Array.isArray(result.data) ? result.data : [];
      sources.ledgers[ledger.id] = result.source || 'unavailable';
      if (result.warning) warnings.push(result.warning);
    }

    var payload = {
      __envelope: 'sbplus-all-sports-backup-v3',
      createdAt: new Date().toISOString(),
      documents: documents,
      ledgers: ledgers,
      sources: sources,
      warnings: warnings.slice()
    };
    return { payload: payload, warnings: warnings, sources: sources };
  }

  function downloadPayload(payload, dateLabel) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
      throw new Error('目前環境無法下載檔案');
    }
    var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    var anchor = document.createElement('a');
    var href = URL.createObjectURL(blob);
    anchor.href = href;
    anchor.download = '全運動排盤備份_' + String(dateLabel || new Date().toISOString().slice(0, 10)) + '.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
    return anchor.download;
  }

  async function exportAll(options) {
    var result = await collectPayload(options);
    result.filename = downloadPayload(result.payload, options && options.dateLabel);
    return result;
  }

  function parseJson(rawText) {
    try { return JSON.parse(String(rawText)); }
    catch (_) { throw new Error('備份檔不是有效的 JSON'); }
  }

  function validateNormalizedImport(normalized) {
    var validDocuments = 0;
    Object.keys(normalized.documents).forEach(function (sportId) {
      var value = normalized.documents[sportId];
      if (value == null) return;
      var definition = sports.get(sportId);
      if (!definition) return;
      if (!definition.validateDocument(value)) throw new Error(sportId + ' 盤面格式不符');
      validDocuments += 1;
    });
    if (!validDocuments) throw new Error('備份檔沒有可還原的有效盤面');
    Object.keys(normalized.ledgers).forEach(function (ledgerId) {
      if (!Array.isArray(normalized.ledgers[ledgerId])) throw new Error(ledgerId + ' 紀錄格式不符');
    });
    return normalized;
  }

  function parseImport(rawText, currentSport) {
    var outer = parseJson(rawText);
    var normalized = { format: '', documents: {}, ledgers: {} };
    if (outer && outer.__envelope === 'sbplus-all-sports-backup-v3') {
      normalized.format = outer.__envelope;
      normalized.documents = Object.assign({}, outer.documents || {});
      normalized.ledgers = Object.assign({}, outer.ledgers || {});
      return validateNormalizedImport(normalized);
    }
    if (outer && (outer.__envelope === 'sbplus-backup-v1' || outer.__envelope === 'sbplus-backup-v2')) {
      normalized.format = outer.__envelope;
      normalized.documents.baseball = outer.doc;
      if (Array.isArray(outer.dvManualCasts)) normalized.ledgers.baseball = outer.dvManualCasts;
      if (Array.isArray(outer.dvManualCastsWnba)) normalized.ledgers.wnba = outer.dvManualCastsWnba;
      return validateNormalizedImport(normalized);
    }
    if (outer && (outer.__envelope === 'sbplus-nba-backup-v1' || outer.__envelope === 'sbplus-nba-backup-v2')) {
      normalized.format = outer.__envelope;
      normalized.documents.basketball = outer.nbaDoc;
      if (Array.isArray(outer.dvManualCastsWnba)) normalized.ledgers.wnba = outer.dvManualCastsWnba;
      return validateNormalizedImport(normalized);
    }
    if (outer && outer.__envelope === 'sbplus-nhl-backup-v1') {
      normalized.format = outer.__envelope;
      normalized.documents.hockey = outer.nhlDoc;
      if (Array.isArray(outer.dvManualCastsNhl)) normalized.ledgers.nhl = outer.dvManualCastsNhl;
      return validateNormalizedImport(normalized);
    }
    normalized.format = 'plain-document';
    normalized.documents[currentSport] = outer;
    return validateNormalizedImport(normalized);
  }

  function mergeLedgersForRestore(current, incoming) {
    current = Array.isArray(current) ? current : [];
    incoming = Array.isArray(incoming) ? incoming : [];
    var keyed = new Map(), unkeyed = [];
    function add(entry) {
      if (!entry || typeof entry !== 'object' || !entry.ts) { unkeyed.push(entry); return; }
      var key = (entry.ts || '') + '|' + (entry.officialId || '') + '|' + (entry.market || '') + '|' + (entry.method || '');
      keyed.set(key, entry);
    }
    current.forEach(add);
    incoming.forEach(add); // 還原檔是使用者指定的版本，同鍵覆蓋瀏覽器舊值。
    var merged = Array.from(keyed.values()).concat(unkeyed);
    merged.sort(function (a, b) {
      var at = a && a.ts || '', bt = b && b.ts || '';
      return at < bt ? 1 : (at > bt ? -1 : 0);
    });
    return merged;
  }

  async function writeDocument(definition, value) {
    var text = JSON.stringify(value);
    if (storagePressure && typeof storagePressure.setCritical === 'function') {
      storagePressure.setCritical(storage, definition.docKey, text);
    } else {
      storage.setItem(definition.docKey, text);
    }
  }

  async function writeLedger(definition, value) {
    if (largeStorage && typeof largeStorage.writeJSON === 'function') {
      await largeStorage.writeJSON(definition.storeKey, value, definition.legacyKey);
      return;
    }
    if (!storage || !definition.legacyKey) throw new Error('沒有可用的紀錄儲存空間');
    var encoded = storagePressure && typeof storagePressure.encodeLegacyPayload === 'function'
      ? await storagePressure.encodeLegacyPayload(value)
      : JSON.stringify(value);
    if (storagePressure && typeof storagePressure.setCritical === 'function') {
      storagePressure.setCritical(storage, definition.legacyKey, encoded);
    } else {
      storage.setItem(definition.legacyKey, encoded);
    }
  }

  async function persistImport(parsed, options) {
    options = options || {};
    validateNormalizedImport(parsed);
    var report = { documents: {}, ledgerCounts: {}, warnings: [] };
    for (var entry of Object.entries(parsed.documents)) {
      var sportId = entry[0], value = entry[1], definition = sports.get(sportId);
      if (!definition || value == null) continue;
      if (sportId === options.currentSport) {
        if (typeof options.setCurrentDoc !== 'function') throw new Error('目前頁面缺少盤面更新函式');
        await options.setCurrentDoc(value);
        report.documents[sportId] = 'live';
        continue;
      }
      try {
        await writeDocument(definition, value);
        report.documents[sportId] = 'local';
      } catch (error) {
        report.documents[sportId] = 'failed';
        report.warnings.push(sportId + ' 盤面寫入失敗，原資料未清除。 ' + (error && error.message || error));
      }
    }

    var ledgerDefinitions = new Map(uniqueLedgers().map(function (ledger) { return [ledger.id, ledger]; }));
    for (var ledgerEntry of Object.entries(parsed.ledgers)) {
      var ledgerId = ledgerEntry[0], incoming = ledgerEntry[1], ledger = ledgerDefinitions.get(ledgerId);
      if (!ledger || !Array.isArray(incoming)) continue;
      try {
        var current = await readLedger(ledger);
        var merged = mergeLedgersForRestore(current, incoming);
        await writeLedger(ledger, merged);
        report.ledgerCounts[ledgerId] = merged.length;
        if (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
          globalThis.dispatchEvent(new globalThis.CustomEvent('sbplus-casts-updated', { detail: { storeKey: ledger.storeKey } }));
        }
      } catch (error) {
        report.ledgerCounts[ledgerId] = null;
        report.warnings.push((ledger.label || ledgerId) + '寫入失敗，原資料未清除。 ' + (error && error.message || error));
      }
    }
    return report;
  }

  var api = {
    registerSport: registerSport,
    listSports: listSports,
    collectPayload: collectPayload,
    downloadPayload: downloadPayload,
    exportAll: exportAll,
    parseImport: parseImport,
    persistImport: persistImport
  };

  registerSport({
    id: 'baseball',
    docKey: 'sportbetting_plus_doc_v2',
    validateDocument: isBoardDocument,
    ledgers: [{ id: 'baseball', label: '棒球卦', storeKey: 'baseball-casts', legacyKey: 'dvManualCasts', cloudReaderOption: 'baseballCloudReader' }]
  });
  registerSport({
    id: 'basketball',
    docKey: 'sportbetting_nba_doc_v1',
    validateDocument: isBoardDocument,
    ledgers: [{ id: 'wnba', label: 'WNBA 卦', storeKey: 'wnba-casts', legacyKey: 'dvManualCastsWnba' }]
  });
  registerSport({
    id: 'hockey',
    docKey: 'sportbetting_nhl_doc_v1',
    validateDocument: isBoardDocument,
    ledgers: [{ id: 'nhl', label: 'NHL 卦', storeKey: 'nhl-casts', legacyKey: 'dvManualCastsNhl' }]
  });

  return api;
});
