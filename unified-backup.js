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

  var api = {
    registerSport: registerSport,
    listSports: listSports,
    collectPayload: collectPayload,
    downloadPayload: downloadPayload,
    exportAll: exportAll
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
