# NHL Official-Only Odds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修復 2026-10-01 三場 NHL 盤口，並把 NHL 卡片及自動更新永久切換到 Stake／Bet365 官方賽前資料。

**Architecture:** `stake_api_odds.js` 使用 Stake 官方賽程 API；有金鑰時讀官方賠率 API，沒有金鑰時透過既有 Scrapling sidecar 讀官方賽事頁。`nhl_bet365_odds.js` 維持獨立備援，兩條管線共同遵守開賽前硬閘；前端逐市場採 Stake 優先、Bet365 補缺。

**Tech Stack:** Node.js 20、Cheerio、Scrapling sidecar、GitHub Actions、原生瀏覽器 JavaScript、Node test runner、jsdom。

**Spec:** `docs/superpowers/specs/2026-10-01-nhl-official-only-odds.md`

## Global Constraints

- NHL 賠率只允許 Stake 與 Bet365 官方來源。
- `observedAt >= startTime` 的快照永遠不得寫入。
- 官方來源失敗時保留舊檔；不得回退聚合商或走地盤。
- Stake 逐市場優先，Bet365 只補 Stake 缺少的市場。
- workflow YAML 必須是無 BOM UTF-8。
- 既有根目錄 `test_*.js` 與 `test-results/` 不納入提交。

---

### Task 1: Stake 官方頁解析與賽前硬閘

**Files:**
- Modify: `stake_api_odds.js`
- Modify: `nhl_core.js`
- Create: `tests/stake_official_odds.test.js`
- Create: `tests/fixtures/stake-nhl-event.html`

**Interfaces:**
- Produces: `parseStakeOfficialPage(html, fixture)`, `selectFixtures(fixtures, now, fromHours, toHours, maxFixtures)`, `collectStakeOdds(options)`。
- `parseStakeOfficialPage` 回傳 `{ ml, hd, tot }`，市場沿用 `nhl_core.js` 的 `{ market, line?, outcomes }` 格式。
- `collectStakeOdds` 接受注入的 `request`（API JSON）與 `fetchPage`（官方 HTML），輸出前端相容的 `markets.ml/hd/ou`。

- [ ] **Step 1: 寫官方頁與時間閘失敗測試**

```js
test('selectFixtures rejects a fixture exactly at or before now', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const selected = selectFixtures([
    { slug:'live', date:now, preMatchEnabled:true },
    { slug:'past', date:now-1, preMatchEnabled:true },
    { slug:'future', date:now+1, preMatchEnabled:true },
  ], now, 0, 96, 60);
  assert.deepEqual(selected.map(x => x.slug), ['future']);
});

test('official page selects balanced main handicap and total, not alternate lines', () => {
  const markets = parseStakeOfficialPage(html, fixture);
  assert.equal(markets.hd.line, 1.5);
  assert.equal(markets.hd.favSide, 'home');
  assert.equal(markets.tot.line, 6);
});

test('collector never requests or updates a started fixture', async () => {
  const requested = [];
  const out = await collectStakeOdds({ now, previous, request:scheduleRequest, fetchPage:async slug => {
    requested.push(slug); return html;
  }});
  assert.deepEqual(requested, ['future-game']);
  assert.deepEqual(out.games['started-game'], previous.games['started-game']);
});
```

- [ ] **Step 2: 執行測試確認因缺少解析器與硬閘而失敗**

Run: `node --test tests/stake_official_odds.test.js`

Expected: FAIL，指出 `parseStakeOfficialPage` 未匯出及開賽場仍被選入。

- [ ] **Step 3: 實作官方頁解析與 API／官方頁雙路徑**

實作規則：從標題為 `Winner/Total/Handicap (Incl. Overtime and Penalties)` 的 `secondary-accordion` 讀取 `button[data-testid="fixture-outcome"]`；讓分及大小分依相同 line 配對，使用兩邊賠率差最小的一組作主盤。`selectFixtures` 強制 `start > now`。API 有有效 `groups` 就使用 API，否則呼叫 `fetchPage` 讀官方頁。

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test tests/stake_official_odds.test.js tests/nhl_core.test.js`

Expected: PASS，且測試輸出沒有警告。

### Task 2: Bet365 賽前凍結與今日資料修復

**Files:**
- Modify: `nhl_bet365_odds.js`
- Modify: `data/stake_api_odds.json`
- Modify: `tests/nhl_bet365_odds.test.js`
- Test: `tests/stake_official_odds.test.js`

**Interfaces:**
- `collectBet365NhlOdds({ now, previous, fetchText })` 只合併 `game.startTime > now` 的解析結果。
- 修復資料沿用前端相容的 `markets.{ml,hd,ou}.{open,active}` 格式。

- [ ] **Step 1: 寫 Bet365 開賽後不覆蓋的失敗測試**

```js
test('started Bet365 fixtures keep their last pregame snapshot', async () => {
  const out = await collectBet365NhlOdds({ now:startTime+1, previous, fetchText:async()=>changedHtml });
  assert.deepEqual(out.games[key], previous.games[key]);
});
```

- [ ] **Step 2: 執行測試確認目前會把走地值合併而失敗**

Run: `node --test tests/nhl_bet365_odds.test.js`

Expected: FAIL，started fixture 被新頁值覆蓋。

- [ ] **Step 3: 加入 Bet365 時間閘並寫回三場修復資料**

只處理 `startTime > now` 的 parsed game；已開始賽事由 `previous` 原樣保留。`data/stake_api_odds.json` 寫入規格列出的三場最後賽前 Stake 快照，島人＠楓葉不製造 Stake 讓分欄位，讓前端自然使用 Bet365 補位。

- [ ] **Step 4: 執行測試及 JSON 驗證**

Run: `node --test tests/nhl_bet365_odds.test.js tests/stake_official_odds.test.js`

Run: `node -e "const x=require('./data/stake_api_odds.json'); if(x.provider!=='stake-official'||Object.keys(x.games).length<3) process.exit(1)"`

Expected: PASS，JSON 可載入且至少包含三場修復資料。

### Task 3: 前端切換官方資料並停用 NHL 聚合來源

**Files:**
- Modify: `nhl.html`
- Modify: `nhl_stake_core.js`
- Modify: `oddsportal_local.js`
- Modify: `.github/workflows/oddsportal-scrape.yml`
- Modify: `tests/nhl_stake_core.test.js`
- Modify: `tests/nhl_stake_frontend.test.js`
- Modify: `tests/oddsportal_local.test.js`

**Interfaces:**
- `nhl.html` 只請求 `data/stake_api_odds.json` 與 `data/nhl_bet365_odds.json`。
- `NhlStake.findStakeGame` 保持回傳 `{ game, ml, hd, ou, open }`。
- `computeOddsPortalGates` 對 NHL 賽程回傳零個 NHL gate。

- [ ] **Step 1: 修改測試為官方來源契約並先確認失敗**

```js
test('NHL page loads official feeds and never OddsPortal', () => {
  assert.match(html, /data\/stake_api_odds\.json/);
  assert.match(html, /data\/nhl_bet365_odds\.json/);
  assert.doesNotMatch(html, /nhl_oddsportal_stake/);
});

test('OddsPortal scheduler creates no NHL gates', () => {
  const gates = computeOddsPortalGates([{ league:'nhl', date:'2026-10-02', gameTime:'07:30' }], now);
  assert.deepEqual(gates, []);
});
```

Run: `node --test tests/nhl_stake_core.test.js tests/nhl_stake_frontend.test.js tests/oddsportal_local.test.js`

Expected: FAIL，頁面仍讀舊檔且排程仍建立 NHL gate。

- [ ] **Step 2: 切換前端、文字與快取版本**

把 feed URL 改為 `stake_api_odds.json`，來源文字改為「STAKE 官方」，移除 `OddsPortal` 顯示；保留 Stake 逐市場優先、Bet365 補缺及手動 `hdFavOverride` 最高優先。修改 `nhl_stake_core.js` 後同步 bump `nhl.html` 的 `?v=`。

- [ ] **Step 3: 排除 OddsPortal 的 NHL gate 與提交檔**

`computeOddsPortalGates` 忽略 `league === 'nhl'`；`OUTPUT_PATHS` 與 workflow 的 `git add`、衝突檢查移除 `data/nhl_oddsportal_stake.json`；手動 workflow 執行 scraper 時明確傳入 `mlb,npb,kbo,cpbl,wnba`。

- [ ] **Step 4: 執行前端與排程測試**

Run: `node --test tests/nhl_stake_core.test.js tests/nhl_stake_frontend.test.js tests/oddsportal_local.test.js`

Expected: PASS，jsdom 無錯誤，NHL gate 為空。

### Task 4: 官方工作流、實站與整體驗證

**Files:**
- Modify: `.github/workflows/stake-api-odds.yml`
- Modify: `.github/workflows/nhl-bet365-odds.yml`
- Create: `tests/nhl_official_workflows.test.js`

**Interfaces:**
- Stake workflow 無 key 時仍執行 `stake_api_odds.js` 官方頁模式。
- 兩條 workflow 各自只提交自己的 JSON，維持五分鐘長迴圈與自我接棒。

- [ ] **Step 1: 寫 workflow 契約失敗測試**

```js
test('Stake workflow runs without an API key and commits only official feed', () => {
  assert.doesNotMatch(yaml, /無 STAKE key，不接棒|尚未設定 STAKE_ODDS_API_KEY/);
  assert.match(yaml, /node stake_api_odds\.js/);
  assert.match(yaml, /git add data\/stake_api_odds\.json/);
});
```

Run: `node --test tests/nhl_official_workflows.test.js`

Expected: FAIL，舊 workflow 仍在無 key 時提前退出。

- [ ] **Step 2: 更新 workflow 並驗證 BOM**

移除無 key 退出與不接棒條件；保留 `STAKE_ODDS_API_KEY` 作可選 API 升級。Bet365 workflow 不改來源，只透過新版 collector 套用時間閘。

Run: `node --test tests/nhl_official_workflows.test.js tests/nhl_bet365_workflow.test.js`

Run: `node -e "for(const f of ['.github/workflows/stake-api-odds.yml','.github/workflows/nhl-bet365-odds.yml']){const b=require('fs').readFileSync(f);if(b[0]===239&&b[1]===187&&b[2]===191)process.exit(1)}"`

Expected: PASS 且無 BOM。

- [ ] **Step 3: 實站抓取官方 Stake 頁**

Run: `$env:EP_TRANSPORT='sidecar'; node stake_api_odds.js`

Expected: exit 0，輸出 `provider: stake-official`，至少一場未開賽賽事同時有 `ml`、`hd`、`ou`，所有 history 時間早於 startTime。

- [ ] **Step 4: 執行完整 NHL 回歸測試**

Run: `node --test tests/nhl_*.test.js tests/stake_official_odds.test.js tests/oddsportal_local.test.js`

Run: `git diff --check origin/main...HEAD`

Expected: 全部 PASS，無 whitespace error。

- [ ] **Step 5: 瀏覽器驗證與部署**

啟動本機 HTTP server，確認今日三場不再顯示 1.22／4.25、讓分換邊或 -4.5→-1.5；確認明日場顯示「STAKE 官方」。完成後依 `AGENTS.md` 先 `git status`、commit、`git show --stat`，再 `git pull --rebase origin main`、重跑測試、推送 `HEAD:main`，最後核對 GitHub Pages 資料時間與內容。

