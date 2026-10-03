# Four-League Baseball Stake Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有棒球大頁面直接監控 MLB、NPB、KBO、CPBL 的 Stake 讓分方、換邊歷史及大小分，並安全自動填入卡片。

**Architecture:** 新增純函式核心處理官方賽程撮合、30 秒凍結、MLB ±1 標準化與歷史合併；收集器沿用官方 Stake 排程與 Scrapling 傳輸，輸出一份四聯盟 JSON。前端 add-on 只讀這份標準化資料，直接在現有卡片顯示並以持久化自動擁有權保護人工修改。

**Tech Stack:** Node.js 20、Cheerio、Node `--test`、既有 Scrapling sidecar、GitHub Actions、原生瀏覽器 JavaScript/JSDOM。

**Spec:** `docs/superpowers/specs/2026-10-03-baseball-stake-monitor-design.md`

## Global Constraints

- OddsPortal 不得作為即時來源。
- Bet365 不得補成 Stake 賠率。
- MLB Stake 原始讓分為 ±1 時，方向取 Stake 官方，標準盤為 ±1.5，賠率只取 BetExplorer `Stake.com` 列。
- `observedAt <= scheduledStart - 30 秒` 才能寫入；其後凍結。
- 單場或單聯盟失敗保留上一份有效資料，不得清空其他資料。
- 人工對調或人工編輯大小分後，自動同步不得覆寫。
- 根目錄 `test_*.js` 與 `test-results/` 不提交。

---

### Task 1: 賽程撮合、標準化與歷史核心

**Files:**
- Create: `baseball_stake_core.js`
- Create: `tests/baseball_stake_core.test.js`

**Interfaces:**
- Produces: `normalizeLeague(value)`, `normalizeTeam(value)`, `buildOfficialGames(rows, now)`, `matchOfficialGame(fixture, officialGames)`, `normalizeBaseballMarkets(markets, fallbackGame)`, `mergeBaseballObservation(previous, observation)`, `buildBaseballFeed(previous, officialRows, leagueResults, observedAt)`.

- [ ] **Step 1: Write failing tests** covering official whitelist rejection of futures, exact four-league matching, doubleheader time separation, 30-second rejection, MLB ±1 canonicalization, missing Stake.com fallback preservation, unchanged-observation dedupe, and favorite flip counting.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/baseball_stake_core.test.js`

Expected: FAIL because `baseball_stake_core.js` does not exist.

- [ ] **Step 3: Implement pure core** with concrete normalized observation shape:

```js
{
  officialId, league, scheduledStart, away, home,
  favorite, rawLine, canonicalLine,
  handicapOdds: { away, home },
  total: { line, over, under },
  sources, observedAt, frozenAt, favoriteFlipCount, history
}
```

`mergeBaseballObservation` must reject observations newer than `scheduledStart - 30000`, keep previous valid values on partial data, and append history only when monitored values change.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/baseball_stake_core.test.js`

Expected: all Task 1 tests PASS.

### Task 2: 四聯盟 Stake 官方收集器

**Files:**
- Create: `baseball_stake_odds.js`
- Create: `tests/baseball_stake_odds.test.js`
- Create: `tests/fixtures/stake-baseball-event.html`

**Interfaces:**
- Consumes: Task 1 core functions; `sidecar_client.fetchText(url, headers, timeoutMs)`.
- Produces: `flattenSchedule(payload)`, `parseStakeBaseballPage(html, fixture)`, `collectLeague(config, context)`, `collectBaseballStakeOdds(options)`, `saveAtomic(file, value)`.

- [ ] **Step 1: Write failing parser and collector tests** for moneyline/run line/total parsing, official API/page fallback, independent league errors, futures rejection through official schedule matching, and no-empty-overwrite behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/baseball_stake_odds.test.js`

Expected: FAIL because the collector module does not exist.

- [ ] **Step 3: Implement collector** using these routes:

```js
const LEAGUES = {
  MLB:  { schedule: '/schedule/sport/baseball/usa/tournament/mlb', page: '/sports/baseball/usa/mlb/' },
  NPB:  { schedule: '/schedule/sport/baseball/japan/tournament/npb', page: '/sports/baseball/japan/npb/' },
  KBO:  { schedule: '/schedule/sport/baseball/republic-of-korea/tournament/kbo-league', page: '/sports/baseball/republic-of-korea/kbo-league/' },
  CPBL: { schedule: '/schedule/sport/baseball/chinese-taipei/tournament/cpbl', page: '/sports/baseball/chinese-taipei/cpbl/' }
};
```

Read `data/pregame_data.json` and `data/oddsportal_summary.json`; the latter may only provide BetExplorer `Stake.com` ±1.5 fallback values. Write `data/baseball_stake_odds.json` atomically only when at least one league succeeds or previous valid matches exist.

- [ ] **Step 4: Run collector tests**

Run: `node --test tests/baseball_stake_core.test.js tests/baseball_stake_odds.test.js`

Expected: all Task 1–2 tests PASS.

### Task 3: 大頁面卡片整合與人工鎖定

**Files:**
- Create: `baseball-stake-integration.js`
- Create: `tests/baseball_stake_frontend.test.js`
- Modify: `index.html` around card styles, `normMatch`, both favorite swap handlers, total input handler, `renderCardB`, and final script tags.

**Interfaces:**
- Consumes: `data/baseball_stake_odds.json` and existing global lexical bindings `doc`, `state`, `save`, `render`, `leagueOf`.
- Produces: `window.__baseballStakeIntegration` with `refresh()`, `findGame(feed, card, date)`, `applyToCard(card, game)`, `statusText(game, now)`, `restoreAuto(card, field)`.

- [ ] **Step 1: Write failing pure and JSDOM tests** proving direct card status rendering, automatic favorite/total fill, old nonblank card protection, manual swap lock, manual total lock, restore-auto behavior, and stale/partial/frozen labels.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/baseball_stake_frontend.test.js`

Expected: FAIL because the integration module and card hooks do not exist.

- [ ] **Step 3: Implement add-on and card hooks**. New/blank cards may set `stakeAutoHandicap=true` and `stakeAutoTotal=true`; existing nonblank unmarked cards initialize both flags to `false`. Both swap buttons set `stakeAutoHandicap=false`; the total input sets `stakeAutoTotal=false`. The compact row shows current favorite, odds, total, flip count, latest transition, source and health without requiring a click.

- [ ] **Step 4: Run frontend tests**

Run: `node --test tests/baseball_stake_frontend.test.js`

Expected: all Task 3 tests PASS.

### Task 4: GitHub Actions 持續收集

**Files:**
- Create: `.github/workflows/baseball-stake-odds.yml`
- Modify: `.github/workflows/pipeline-watchdog.yml`
- Create: `tests/baseball_stake_workflow.test.js`

**Interfaces:**
- Consumes: `baseball_stake_odds.js`, `fetch_sidecar.py`, `sidecar_client.js`, `requirements-scraping.txt`.
- Produces: five-minute loop that commits only `data/baseball_stake_odds.json`, preserves running jobs, self-dispatches with `WORKFLOW_PAT`, and watchdog recovery after 25 minutes.

- [ ] **Step 1: Write failing static workflow test** checking triggers, concurrency `cancel-in-progress: false`, 300-second cadence, 30-second collector semantics reference, exact staged data file, self-dispatch, watchdog entry, and no UTF-8 BOM.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/baseball_stake_workflow.test.js`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 3: Add workflow and watchdog entry** following the existing five-hour NHL loop, but invoking `node baseball_stake_odds.js` and staging only the baseball feed.

- [ ] **Step 4: Run workflow tests**

Run: `node --test tests/baseball_stake_workflow.test.js`

Expected: all Task 4 tests PASS.

### Task 5: 全套驗證、實盤探測與部署

**Files:**
- Modify only if a failing verification reveals an in-scope defect.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified code and deployed main branch.

- [ ] **Step 1: Run focused tests**

Run: `node --test tests/baseball_stake_core.test.js tests/baseball_stake_odds.test.js tests/baseball_stake_frontend.test.js tests/baseball_stake_workflow.test.js`

Expected: 0 failures.

- [ ] **Step 2: Run related regression tests**

Run: `node --test tests/oddsportal_integration.test.js tests/nhl_stake_core.test.js tests/nhl_stake_frontend.test.js tests/data_overwrite_guards.test.js`

Expected: 0 failures.

- [ ] **Step 3: Run a bounded live probe**

Run: `node baseball_stake_odds.js --probe`

Expected: each reachable league reports discovered fixture count and no candidate outside `pregame_data.json` is written as a match.

- [ ] **Step 4: Verify repository safety**

Run: `git diff --check`, inspect workflow first three bytes, `git status --short`, and `git diff --stat`.

- [ ] **Step 5: Commit and deploy**

Stage only planned production files, tests, spec/plan and generated feed if valid. Run `git pull --rebase origin main`, re-run focused verification after rebase, then `git push origin HEAD:main` and confirm output contains `HEAD -> main`.
