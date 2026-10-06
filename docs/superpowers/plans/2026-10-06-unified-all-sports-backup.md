# 全運動統一備份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓棒球、籃球與 NHL 任一頁面都能匯出、匯入同一份可擴充的全運動備份，未來新增運動只需登記一次。

**Architecture:** 新增 `unified-backup.js`，以註冊表描述運動主檔與 ledger，負責跨頁讀取、v3 信封、下載、解析與持久化。三個 HTML 只傳入目前頁面的即時 `doc`、日期與刷新 callback，所有錯誤隔離、舊格式相容及 ledger 聯集集中在共用模組。

**Tech Stack:** 原生瀏覽器 JavaScript、localStorage、IndexedDB 包裝器 `window.__largeStorage`、Node.js `node:test`、Python Playwright。

**Spec:** `docs/superpowers/specs/2026-10-06-unified-all-sports-backup-design.md`

## Global Constraints

- 匯出格式識別字固定為 `sbplus-all-sports-backup-v3`。
- 目前頁面的記憶體 `doc` 必須優先於 localStorage。
- 任一非當前運動或 ledger 失敗不得阻止其他資料下載。
- 匯入缺少某運動時不得刪除該運動現有資料。
- ledger 去重鍵固定為 `ts|officialId|market|method`，採聯集合併。
- 舊棒球 v1/v2、籃球 v2、NHL v1 與純 doc 格式必須繼續可匯入。
- `unified-backup.js` 修改後，`index.html`、`nba.html`、`nhl.html` 的 `?v=` 必須一致。
- commit 與 push 遵守 `AGENTS.md`：精準 stage、檢查 `git status`／`git show --stat`，push 前 `git pull --rebase origin main`。

---

### Task 1: 建立註冊表與 v3 payload 核心

**Files:**
- Create: `unified-backup.js`
- Create: `tests/unified_backup.test.js`

**Interfaces:**
- Produces: `createUnifiedBackup(options)`（CommonJS 測試匯出與瀏覽器 UMD 工廠）。
- Produces: `registerSport(definition)`、`listSports()`、`collectPayload(options)`、`downloadPayload(payload,dateLabel)`。
- Consumes: `storage`、`storagePressure`、`largeStorage` 依賴注入；瀏覽器預設使用 `localStorage` 與現有全域物件。

- [ ] **Step 1: 寫註冊表與 payload 的失敗測試**

```js
test('collectPayload includes every registered sport and prefers the live document', async () => {
  const api = createUnifiedBackup({ storage, storagePressure, largeStorage });
  api.registerSport({ id:'future', docKey:'future_doc', validateDocument:isBoardDoc });
  storage.setItem('sportbetting_plus_doc_v2', JSON.stringify(baseballStored));
  storage.setItem('sportbetting_nba_doc_v1', JSON.stringify(basketball));
  storage.setItem('sportbetting_nhl_doc_v1', JSON.stringify(hockey));
  storage.setItem('future_doc', JSON.stringify(future));

  const result = await api.collectPayload({ currentSport:'baseball', currentDoc:baseballLive });

  assert.equal(result.payload.__envelope, 'sbplus-all-sports-backup-v3');
  assert.equal(result.payload.documents.baseball, baseballLive);
  assert.deepEqual(Object.keys(result.payload.documents).sort(), ['baseball','basketball','future','hockey']);
});
```

- [ ] **Step 2: 執行測試並確認因模組不存在而失敗**

Run: `node --test tests/unified_backup.test.js`

Expected: FAIL，指出 `../unified-backup.js` 不存在或 `createUnifiedBackup` 未定義。

- [ ] **Step 3: 實作 UMD 工廠與內建註冊表**

```js
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory;
  else root.__unifiedBackup=factory({
    storage:root.localStorage,
    storagePressure:root.__storagePressure,
    largeStorage:root.__largeStorage
  });
})(typeof globalThis!=='undefined'?globalThis:this,function createUnifiedBackup(deps){
  const sports=new Map();
  function registerSport(def){ sports.set(def.id,{...def}); return api; }
  const api={registerSport,listSports:()=>Array.from(sports.values()),collectPayload,downloadPayload};
  registerSport({id:'baseball',docKey:'sportbetting_plus_doc_v2',validateDocument:isBoardDoc,ledgers:[/* baseball */]});
  registerSport({id:'basketball',docKey:'sportbetting_nba_doc_v1',validateDocument:isBoardDoc,ledgers:[/* wnba */]});
  registerSport({id:'hockey',docKey:'sportbetting_nhl_doc_v1',validateDocument:isBoardDoc,ledgers:[/* nhl */]});
  return api;
});
```

`collectPayload` 遍歷 `sports`，目前運動使用 `currentDoc`，其餘呼叫共用解碼器；每個 ledger 各自 `try/catch`，結果放入 `warnings` 與 `sources`。

- [ ] **Step 4: 加入 JSON／gz／lz16 與局部失敗測試**

測試必須斷言：三種棒球存檔都能解碼；未來第四運動自動出現；一個 doc 或 ledger 丟出 `UnknownError` 時仍回傳 v3 payload。

- [ ] **Step 5: 執行核心測試**

Run: `node --test tests/unified_backup.test.js`

Expected: PASS，0 failures。

- [ ] **Step 6: Commit**

```bash
git add unified-backup.js tests/unified_backup.test.js
git commit -m "feat: add extensible unified backup core"
```

---

### Task 2: 建立 v3 匯入與舊格式正規化

**Files:**
- Modify: `unified-backup.js`
- Modify: `tests/unified_backup.test.js`

**Interfaces:**
- Produces: `parseImport(rawText, currentSport)`。
- Produces: `persistImport(parsed,{currentSport,setCurrentDoc})`。
- Consumes: Task 1 的註冊表與依賴注入。

- [ ] **Step 1: 寫 v3 全項目匯入失敗測試**

```js
test('persistImport restores all present sports and unions every ledger', async () => {
  const parsed = api.parseImport(JSON.stringify(v3Payload), 'baseball');
  const report = await api.persistImport(parsed, {
    currentSport:'baseball',
    setCurrentDoc:value => { liveBaseball=value; }
  });
  assert.equal(liveBaseball, v3Payload.documents.baseball);
  assert.deepEqual(JSON.parse(storage.getItem('sportbetting_nba_doc_v1')), v3Payload.documents.basketball);
  assert.deepEqual(JSON.parse(storage.getItem('sportbetting_nhl_doc_v1')), v3Payload.documents.hockey);
  assert.equal(report.ledgerCounts.baseball, 2);
});
```

- [ ] **Step 2: 執行並確認因 API 尚未存在而失敗**

Run: `node --test tests/unified_backup.test.js --test-name-pattern="persistImport"`

Expected: FAIL，`parseImport` 或 `persistImport` 未定義。

- [ ] **Step 3: 實作先驗證後寫入及 ledger 聯集**

`parseImport` 先把 v3、棒球 v1/v2、籃球 v2、NHL v1、純 doc 正規化成：

```js
{
  format,
  documents:{baseball?,basketball?,hockey?},
  ledgers:{baseball?,wnba?,nhl?}
}
```

只有存在且通過註冊驗證器的 document 才能寫入；v3 至少要有一份有效文件。`persistImport` 先完成全部格式驗證，再寫目前頁 doc、其他 localStorage 與 ledger 聯集；單一非當前寫入失敗保留原值並記入 warnings。

- [ ] **Step 4: 加入舊格式不清除其他運動的測試**

分別測試 `sbplus-backup-v2`、`sbplus-nba-backup-v2`、`sbplus-nhl-backup-v1` 與純 doc，斷言未包含的 storage key 維持原值。

- [ ] **Step 5: 執行核心完整測試**

Run: `node --test tests/unified_backup.test.js`

Expected: PASS，0 failures。

- [ ] **Step 6: Commit**

```bash
git add unified-backup.js tests/unified_backup.test.js
git commit -m "feat: restore unified and legacy backups"
```

---

### Task 3: 整合棒球頁匯出、匯入與救援模式

**Files:**
- Modify: `index.html`
- Modify: `tests/backup_envelope.test.js`
- Modify: `tests/backup_salvage_playwright.py`

**Interfaces:**
- Consumes: `window.__unifiedBackup.exportAll`、`parseImport`、`persistImport`。
- Produces: 棒球頁現有 `exportData()` 與 `importData()` 行為保持 UI 相容。

- [ ] **Step 1: 先把來源測試改成期待 v3 與共用模組**

```js
assert.match(indexSource, /unified-backup\.js\?v=/);
assert.match(indexSource, /__unifiedBackup\.exportAll/);
assert.match(indexSource, /sbplus-all-sports-backup-v3|parseImport/);
```

- [ ] **Step 2: 執行並確認仍使用舊 v2 而失敗**

Run: `node --test tests/backup_envelope.test.js`

Expected: FAIL，找不到 `unified-backup.js` 或 `exportAll`。

- [ ] **Step 3: 載入共用模組並替換棒球匯出／匯入內部**

在 `storage-pressure.js` 後加入：

```html
<script src="./unified-backup.js?v=20261006ub1"></script>
```

`exportData(options)` 呼叫：

```js
await window.__unifiedBackup.exportAll({
  currentSport:'baseball',
  currentDoc:doc,
  dateLabel:todayStr(),
  baseballCloudReader:window.__dvSync?.fetchCloudCasts,
  rescue:!!options?.rescue
});
```

匯入完成後沿用現有 `loadActiveBoard()`、`save()`、`render()`、`buildDateBar()`、`applyView()` 與統計補齊。

- [ ] **Step 4: 更新棒球 Playwright 斷言**

下載檔必須為 `全運動排盤備份_YYYY-MM-DD.json`，並斷言 `documents.baseball`、`documents.basketball`、`documents.hockey` 及三種 ledger 欄位存在；永久 IndexedDB 錯誤仍下載。

- [ ] **Step 5: 執行棒球測試**

Run: `node --test tests/backup_envelope.test.js`

Run: `python tests/backup_salvage_playwright.py`

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add index.html tests/backup_envelope.test.js tests/backup_salvage_playwright.py
git commit -m "feat: use unified backups on baseball board"
```

---

### Task 4: 整合籃球與 NHL 頁

**Files:**
- Modify: `nba.html`
- Modify: `nhl.html`
- Create: `tests/unified_backup_playwright.py`

**Interfaces:**
- Consumes: Task 1、2 的共用 API。
- Produces: 三頁相同 v3 匯出與全項目匯入。

- [ ] **Step 1: 寫籃球與 NHL 頁下載 v3 的失敗測試**

在三個獨立 browser context 種入三份 doc 與 ledger，分別開 `nba.html`、`nhl.html`，點擊 `#exportDataBtn` 後解析 JSON：

```python
assert payload["__envelope"] == "sbplus-all-sports-backup-v3"
assert set(payload["documents"]) >= {"baseball", "basketball", "hockey"}
assert set(payload["ledgers"]) >= {"baseball", "wnba", "nhl"}
```

- [ ] **Step 2: 執行並確認舊頁仍輸出專屬格式而失敗**

Run: `python tests/unified_backup_playwright.py`

Expected: FAIL，籃球得到 `sbplus-nba-backup-v2` 或 NHL 得到 `sbplus-nhl-backup-v1`。

- [ ] **Step 3: 三頁使用相同版本的共用腳本**

`nba.html` 傳入 `{currentSport:'basketball',currentDoc:doc,dateLabel:twOffset(0)}`；`nhl.html` 傳入 `{currentSport:'hockey',currentDoc:doc,dateLabel:twOffset(0)}`。兩頁匯入 callback 都必須更新 `doc`、補上 `games`、`bumpGamesVersion()`、`saveDoc(doc)`、`render()`。

- [ ] **Step 4: 加入三頁匯入還原測試**

Playwright 將同一份 v3 檔依序從三頁匯入，讀回三個 localStorage 主檔與三個 ledger，確認值一致；再匯入舊單項檔，確認其他兩項未被刪除。

- [ ] **Step 5: 執行三頁瀏覽器測試**

Run: `python tests/unified_backup_playwright.py`

Expected: PASS，三頁匯出與匯入全部成功。

- [ ] **Step 6: Commit**

```bash
git add nba.html nhl.html tests/unified_backup_playwright.py
git commit -m "feat: unify basketball and hockey backups"
```

---

### Task 5: 全面回歸、快取驗證與部署

**Files:**
- Modify only if a failing regression requires an in-scope correction.

**Interfaces:**
- Verifies: 三頁共用版本、鍵盤／盤面既有功能、備份失敗隔離及 GitHub Pages 實際內容。

- [ ] **Step 1: 驗證三頁腳本版本完全一致**

Run: `rg -n "unified-backup\.js\?v=20261006ub1" index.html nba.html nhl.html`

Expected: exactly 3 matches。

- [ ] **Step 2: 執行 Node 回歸測試**

Run: `node --test tests/unified_backup.test.js tests/backup_envelope.test.js tests/storage_pressure.test.js tests/keyboard_navigation.test.js`

Expected: PASS，0 failures。

- [ ] **Step 3: 執行三頁 Playwright 回歸測試**

Run: `python tests/unified_backup_playwright.py`

Run: `python tests/backup_salvage_playwright.py`

Run: `python tests/keyboard_navigation_playwright.py`

Expected: 全部 exit 0。

- [ ] **Step 4: 檢查提交內容**

Run: `git status --short`

Run: `git show --stat --oneline HEAD`

Expected: 沒有非本任務檔案被 staged 或提交。

- [ ] **Step 5: 依併發安全規則更新並推送**

```bash
git pull --rebase origin main
git push origin HEAD:main
```

Expected: push 輸出包含 `HEAD -> main`，且退出碼為 0。

- [ ] **Step 6: 驗證正式站**

以無快取請求讀取 GitHub Pages 的三頁，確認都含 `unified-backup.js?v=20261006ub1`；再以正式站 Playwright 從棒球與籃球頁各下載一次，解析後均為 `sbplus-all-sports-backup-v3` 且包含所有已註冊運動。
