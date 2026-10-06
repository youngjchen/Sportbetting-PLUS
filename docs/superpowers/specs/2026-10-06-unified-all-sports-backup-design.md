# 全運動統一備份設計

## 目標

將目前分散在棒球、籃球與冰球頁面的備份功能整合成同一套機制。使用者從 `index.html`、`nba.html` 或 `nhl.html` 任一頁按下備份，都必須取得內容一致的全運動備份檔；匯入該檔案時，也能一次還原所有運動資料。

## 範圍

統一備份包含：

- 棒球主檔：`sportbetting_plus_doc_v2`，涵蓋 MLB、日職、韓職、中職的盤面、結算、統計與比賽紀錄。
- 籃球主檔：`sportbetting_nba_doc_v1`，涵蓋 NBA、WNBA 的盤面、結算、統計與比賽紀錄。
- 冰球主檔：`sportbetting_nhl_doc_v1`，涵蓋 NHL 的盤面、結算、統計與比賽紀錄。
- 棒球卜卦：IndexedDB `baseball-casts`／舊鍵 `dvManualCasts`。
- WNBA 卜卦：IndexedDB `wnba-casts`／舊鍵 `dvManualCastsWnba`。
- NHL 卜卦：IndexedDB `nhl-casts`／舊鍵 `dvManualCastsNhl`。

本次不新增新的雲端資料庫、不改變各運動盤面本身的資料結構，也不把賠率爬蟲的原始歷史檔塞進瀏覽器備份。

## 架構

新增 `unified-backup.js` 作為唯一的備份核心，掛載為 `window.__unifiedBackup`。三個頁面只負責提供「目前頁面的即時 `doc`」及匯入後如何刷新當前畫面；跨頁文件讀取、附屬紀錄讀取、統一格式、下載與其他運動文件的持久化都由共用模組處理。

三個 HTML 都載入同一版本的 `unified-backup.js`。修改該檔時，三頁的 `?v=` 必須同步更新，避免其中一頁吃到舊快取。

### 公開介面

```js
window.__unifiedBackup.exportAll({
  currentSport: 'baseball' | 'basketball' | 'hockey',
  currentDoc: Object,
  dateLabel: 'YYYY-MM-DD',
  baseballCloudReader?: () => Promise<Array>
}) => Promise<{ payload, filename, warnings }>

window.__unifiedBackup.parseImport(rawText) => {
  format: 'unified-v3' | 'legacy-baseball' | 'legacy-basketball' | 'legacy-hockey' | 'legacy-doc',
  documents: { baseball?, basketball?, hockey? },
  ledgers: { baseball?, wnba?, nhl? }
}

window.__unifiedBackup.persistImport(parsed, {
  currentSport,
  setCurrentDoc: (doc) => void
}) => Promise<{ importedSports, ledgerCounts, warnings }>
```

`exportAll` 直接觸發下載，檔名固定為 `全運動排盤備份_YYYY-MM-DD.json`。回傳值供測試與頁面顯示警告使用。

## 統一備份格式

新格式識別字為 `sbplus-all-sports-backup-v3`：

```json
{
  "__envelope": "sbplus-all-sports-backup-v3",
  "createdAt": "2026-10-06T10:30:00.000Z",
  "documents": {
    "baseball": {},
    "basketball": {},
    "hockey": {}
  },
  "ledgers": {
    "baseball": [],
    "wnba": [],
    "nhl": []
  },
  "sources": {
    "documents": {
      "baseball": "live|local|unavailable",
      "basketball": "live|local|unavailable",
      "hockey": "live|local|unavailable"
    },
    "ledgers": {
      "baseball": "local|cloud|unavailable",
      "wnba": "local|unavailable",
      "nhl": "local|unavailable"
    }
  },
  "warnings": []
}
```

規則：

- `currentSport` 對應的文件一律使用頁面記憶體中的 `currentDoc`，避免只備份到尚未落盤的舊版本。
- 另外兩個運動文件從各自的 localStorage 鍵讀取。
- 棒球文件可能是純 JSON、`gz:` 或 `lz16:`；共用模組使用 `storage-pressure.js` 現有解碼器讀取。
- 缺少某個運動文件時，該欄位為 `null`、來源標為 `unavailable`，並加入警告；不得因此阻止其他資料下載。
- 三種卜卦紀錄分別讀取，單一 IndexedDB 失敗不得阻止整份備份。
- 棒球卜卦可使用既有 GitHub 雲端讀取器作備援；WNBA 與 NHL 沒有雲端備援時標記缺失。
- `warnings` 必須存進檔案；頁面只在有警告時以簡短訊息提醒，細節保留在備份內容。

## 匯入與相容性

匯入統一 v3 檔案時：

1. 先完整解析並驗證，至少要有一個 `documents.*` 具備 `boards`；驗證失敗時不得寫入任何資料。
2. 當前頁面的文件透過 `setCurrentDoc` 更新並立即刷新。
3. 其他運動文件寫回各自 localStorage 鍵；若寫入容量不足，使用 `storage-pressure.js` 的關鍵資料寫入策略，失敗時保留原資料並回報警告。
4. 卜卦紀錄採聯集合併，不覆寫成較短陣列，也不刪除備份檔中沒有的既有紀錄。
5. 缺少某個運動時不清除該運動現有資料。

舊格式繼續支援：

- `sbplus-backup-v1`、`sbplus-backup-v2`：匯入棒球文件與其中附帶的棒球／WNBA 卜卦。
- `sbplus-nba-backup-v2`：匯入籃球文件與 WNBA 卜卦。
- `sbplus-nhl-backup-v1`：匯入 NHL 文件與 NHL 卜卦。
- 舊純文件：依目前所在頁面匯入該運動，不碰其他運動。

舊格式只更新檔案內存在的運動；不得因匯入舊棒球檔而清除籃球或 NHL。

## 頁面整合

### 棒球 `index.html`

- 保留現有 `exportData()` 名稱與備份提醒入口，但內部改呼叫 `exportAll`。
- 匯入改用 `parseImport`／`persistImport`，完成後沿用現有 `loadActiveBoard()`、`save()`、`render()`、`buildDateBar()` 與統計回填流程。
- 現有 `?rescueBackup=1` 仍可產生救援檔，但救援模式也使用 v3 格式；讀不到的項目寫警告，不阻擋盤面主檔下載。

### 籃球 `nba.html`

- 備份按鈕改呼叫同一個 `exportAll`，以目前籃球 `doc` 作為即時資料。
- 匯入統一檔後刷新籃球畫面；棒球與 NHL 寫入儲存，等使用者開啟其頁面時載入。

### 冰球 `nhl.html`

- 與籃球頁相同，使用目前 NHL `doc` 作為即時資料。
- 雖然使用者明確要求棒球與籃球頁可備份全部項目，NHL 頁也採相同行為，避免第三種分歧格式繼續存在。

## 錯誤處理

- 匯出採「盡可能完整」：任何單一非當前運動或附屬紀錄失敗，都下載其餘資料並記錄警告。
- 當前頁面 `currentDoc` 無效時停止匯出，因為這代表連使用者正在看的核心資料都無法保證。
- 匯入採「先驗證、後寫入」；格式錯誤不做部分寫入。
- 多運動寫入途中若單一非當前運動失敗，保留該運動原資料、繼續其他安全寫入，最後彙整警告。
- 所有 Object URL 在點擊下載後延遲釋放，避免瀏覽器還沒開始讀取就被撤銷。

## 測試標準

### 單元測試

- 從棒球、籃球、NHL 三種 `currentSport` 建立 payload，均含三份文件與三種 ledger。
- 當前頁文件一定優先於 localStorage 同名舊資料。
- 純 JSON、`gz:`、`lz16:` 棒球主檔均能讀取。
- 任一非當前運動或 ledger 讀取失敗時仍產生 v3 payload，且警告、來源正確。
- v3 匯入一次持久化所有存在的運動與 ledger。
- v1/v2 舊備份只更新其包含的運動，不刪除其他運動。
- ledger 聯集去重鍵沿用 `ts|officialId|market|method`。

### 瀏覽器整合測試

- 在棒球頁種入三份不同文件與三種 ledger，按備份後解析下載檔，確認三項齊全。
- 在籃球頁執行相同測試，確認 payload 結構與棒球頁一致，且籃球採頁面即時 `doc`。
- 在 NHL 頁執行相同測試。
- 將 v3 檔分別從三頁匯入，重新讀取三個 localStorage 鍵與三個 IndexedDB ledger，確認全部可還原。
- 模擬一個 IndexedDB 永久 `UnknownError: Internal error`，確認仍會下載且其他資料存在。

## 完成條件

- 三頁備份按鈕均下載 `sbplus-all-sports-backup-v3`。
- 從任一頁下載的檔案都包含所有可讀取的運動文件與附屬紀錄。
- 從任一頁匯入 v3 可還原全部運動，且舊備份仍相容。
- 自動化測試涵蓋三頁匯出、三頁匯入、舊格式與局部讀取失敗。
- `index.html`、`nba.html`、`nhl.html` 對 `unified-backup.js` 的版本參數一致。
