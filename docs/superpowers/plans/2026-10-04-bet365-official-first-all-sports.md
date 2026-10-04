# Bet365 Official-First All-Sports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Bet365's official website the primary live odds source for MLB, NPB, KBO, CPBL, NBA, WNBA, and NHL, with BetExplorer used only as an explicitly labelled fallback.

**Architecture:** A shared source-arbitration core normalizes three markets and prevents source changes from being counted as favorite flips. Baseball, basketball, and hockey keep separate collectors and data files so a failure in one sport cannot erase another sport's last valid pregame snapshot. Existing frontends consume the normalized feeds while Titan remains historical-only.

**Tech Stack:** Node.js 20, Cheerio, Scrapling sidecar, JSON data files, GitHub Actions, node:test, jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-bet365-official-first-all-sports-design.md`

## Global Constraints

- Primary source: Bet365 official website.
- Fallback source: BetExplorer Bet365 bookmaker row only.
- Titan is excluded from live favorite, line, odds, and flip decisions.
- Reject observations recorded less than 30 seconds before start or after start.
- A provider change is `source-change`, never `favorite-flip`.
- A line-only change with the same favorite is not a flip.
- Failed or incomplete fetches preserve the previous valid file.
- Each workflow stages only its own data file and keeps `cancel-in-progress: false`.
- Workflow YAML files must be UTF-8 without BOM.
- Add-on JavaScript changes require matching `?v=` cache bumps in their HTML entry point.

---

### Task 1: Shared Bet365 Market and Source-Arbitration Core

**Files:**
- Create: `bet365_official_core.js`
- Create: `tests/bet365_official_core.test.js`

**Interfaces:**
- Produces: `normalizeMarketObservation(raw, context) -> NormalizedObservation`
- Produces: `mergeProviderObservation(previous, observation, observedAt) -> StoredMatch|null`
- Produces: `resolveMarket(officialMarket, fallbackMarket, frozenOfficialMarket) -> ResolvedMarket|null`
- Produces: `resolveGameSources(officialGame, fallbackGame, frozenOfficialGame) -> ResolvedGame`
- Produces: `isPregameObservation(startTime, observedAt, cutoffMs=30000) -> boolean`

- [ ] **Step 1: Write failing source-transition and cutoff tests**

```js
test('provider change never becomes a favorite flip', () => {
  const first = mergeProviderObservation(null, sample('bet365-official', 'home', 1.5), T1);
  const second = mergeProviderObservation(first, sample('betexplorer', 'away', 1.5), T2);
  assert.equal(second.favoriteFlipCount, 0);
  assert.equal(second.events[0].type, 'source-change');
});

test('same provider line move is not a favorite flip', () => {
  const first = mergeProviderObservation(null, sample('bet365-official', 'home', 4.5), T1);
  const second = mergeProviderObservation(first, sample('bet365-official', 'home', 1.5), T2);
  assert.equal(second.favoriteFlipCount, 0);
  assert.equal(second.events[0].type, 'handicap-line');
});

test('last thirty seconds and post-start observations are rejected', () => {
  assert.equal(isPregameObservation(START, START - 30001), true);
  assert.equal(isPregameObservation(START, START - 30000), false);
  assert.equal(isPregameObservation(START, START + 1), false);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test tests/bet365_official_core.test.js`

Expected: FAIL because `bet365_official_core.js` does not exist.

- [ ] **Step 3: Implement the normalized contract and per-market priority**

```js
const PRE_START_CUTOFF_MS = 30000;

function resolveMarket(official, fallback, frozenOfficial) {
  if (official) return { ...official, provider: 'bet365-official', stale: false };
  if (fallback) return { ...fallback, provider: 'betexplorer', stale: false };
  if (frozenOfficial) return { ...frozenOfficial, provider: 'bet365-official', stale: true };
  return null;
}
```

Store `history`, `providerHistories`, `events`, and `favoriteFlipCount`; compare favorite transitions only against the most recent history row from the same provider.

- [ ] **Step 4: Run the shared tests and verify GREEN**

Run: `node --test tests/bet365_official_core.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit the shared core**

```bash
git add bet365_official_core.js tests/bet365_official_core.test.js
git commit -m "feat: add bet365 official source arbitration"
```

### Task 2: Bet365 Official Page Transport and Event Detail Extraction

**Files:**
- Modify: `fetch_sidecar.py`
- Modify: `sidecar_client.js`
- Create: `bet365_official_transport.js`
- Create: `tests/bet365_official_transport.test.js`

**Interfaces:**
- Consumes: existing `sidecar.fetchText(url, headers, timeoutMs)`.
- Produces: `sidecar.fetchRendered(url, { waitMs, waitSelector, capturePatterns }, timeoutMs)`.
- Produces: `fetchBet365Page(url, options) -> { html, finalUrl, captured }`.

- [ ] **Step 1: Write protocol and challenge-page tests**

```js
test('rendered request includes bounded wait and capture patterns', () => {
  assert.deepEqual(makeSidecarRequest(7, URL, {}, 90000, {
    rendered: true, waitMs: 8000, capturePatterns: ['bet365.com']
  }).rendered, true);
});

test('official transport rejects the sportsbook unavailable shell', async () => {
  await assert.rejects(
    () => fetchBet365Page(URL, { fetchRendered: async () => ({ html: '無法顯示此內容' }) }),
    /Bet365 official content unavailable/
  );
});
```

- [ ] **Step 2: Run the transport tests and verify RED**

Run: `node --test tests/bet365_official_transport.test.js`

Expected: FAIL because rendered transport is not implemented.

- [ ] **Step 3: Extend the sidecar without changing existing fetch semantics**

Add optional request fields only. Existing JSON and HTML callers continue through the old path. Rendered requests wait a bounded number of milliseconds, return final DOM plus final URL, and capture only responses whose URL matches an allowlisted Bet365 pattern. Challenge, preloader-only, and unavailable shells throw rather than returning an empty event list.

- [ ] **Step 4: Run sidecar regression and transport tests**

Run: `node --test tests/fetch_sidecar.test.js tests/sidecar_client.test.js tests/bet365_official_transport.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit the transport**

```bash
git add fetch_sidecar.py sidecar_client.js bet365_official_transport.js tests/bet365_official_transport.test.js
git commit -m "feat: add rendered bet365 official transport"
```

### Task 3: Four-League Baseball Bet365 Official Collector

**Files:**
- Create: `baseball_bet365_odds.js`
- Create: `data/baseball_bet365_odds.json`
- Create: `tests/baseball_bet365_odds.test.js`
- Add fixture: `tests/fixtures/bet365-baseball-markets.html`
- Modify: `bet365_fallback.js`

**Interfaces:**
- Consumes: `buildOfficialGames()` compatible rows from `data/pregame_data.json`.
- Consumes: `mergeProviderObservation()` from Task 1.
- Produces: `collectBaseballBet365Odds(options) -> { schemaVersion, provider, updated, leagues, matches }`.
- Produces: `parseBet365BaseballPage(html) -> ParsedFixture[]`.

- [ ] **Step 1: Write failing parser, matching, and fallback tests**

```js
test('combines moneyline, run line, and total fixture ids by teams and start', () => {
  const games = parseBet365BaseballPage(fixtureHtml);
  assert.deepEqual(games[0].markets.hd, {
    favorite: 'home', line: 1.5,
    away: 1.84, home: 1.98
  });
  assert.equal(games[0].markets.total.line, 7.5);
});

test('supports MLB NPB KBO and CPBL team aliases', () => {
  for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) {
    assert.ok(matchOfficialGame(sampleFixture(league), officialRows));
  }
});

test('official data wins over BetExplorer market by market', () => {
  const resolved = resolveBaseballGame(officialMlOnly, fallbackAllMarkets, null);
  assert.equal(resolved.ml.provider, 'bet365-official');
  assert.equal(resolved.hd.provider, 'betexplorer');
});
```

- [ ] **Step 2: Run baseball tests and verify RED**

Run: `node --test tests/baseball_bet365_odds.test.js`

Expected: FAIL because the collector does not exist.

- [ ] **Step 3: Implement all-league discovery and normalization**

Reuse the proven MLB Hub parser for available events, then use the official rendered sportsbook/event-detail transport for NPB, KBO, CPBL and missing markets. Match only against official schedule rows. Import BetExplorer rows solely through a fallback adapter; never use them to create a game absent from the official schedule.

- [ ] **Step 4: Run baseball collector regressions**

Run: `node --test tests/bet365_fallback.test.js tests/baseball_bet365_odds.test.js tests/bet365_official_core.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit the baseball collector**

```bash
git add baseball_bet365_odds.js bet365_fallback.js data/baseball_bet365_odds.json tests/baseball_bet365_odds.test.js tests/fixtures/bet365-baseball-markets.html
git commit -m "feat: collect official bet365 baseball odds"
```

### Task 4: NBA and WNBA Bet365 Official Collector

**Files:**
- Modify: `nba_bet365_odds.js`
- Modify: `data/nba_bet365_odds.json`
- Create: `tests/fixtures/bet365-basketball-markets.html`
- Modify: `tests/nba_collectors.test.js`

**Interfaces:**
- Consumes: `data/nba_pregame.json` and `data/wnba_pregame.json`.
- Produces: `collectBet365BasketballOdds(options)` with `leagues.NBA`, `leagues.WNBA`, and matches keyed by official id.
- Produces: `parseBet365BasketballPage(html) -> ParsedFixture[]`.

- [ ] **Step 1: Replace Titan expectations with official-source tests**

```js
test('basketball parser reads moneyline point spread and total', () => {
  const game = parseBet365BasketballPage(html)[0];
  assert.equal(game.provider, 'bet365-official');
  assert.equal(game.markets.hd.favorite, 'away');
  assert.equal(game.markets.total.line, 229.5);
});

test('NBA and WNBA use separate official schedule namespaces', async () => {
  const feed = await collectBet365BasketballOdds(options);
  assert.equal(feed.leagues.NBA.status, 'ok');
  assert.equal(feed.leagues.WNBA.status, 'ok');
});
```

- [ ] **Step 2: Run NBA collector tests and verify RED**

Run: `node --test tests/nba_collectors.test.js`

Expected: FAIL because the current provider is `bet365-via-titan-company-8`.

- [ ] **Step 3: Replace live Titan collection with Bet365 official collection**

Keep old Titan parsing exports only where historical tests require them, but do not call Titan from `main()` or from `collectBet365BasketballOdds()`. Use NBA and WNBA official Hub pages for discovery and rendered event details for missing spread/total markets. Apply BetExplorer only per missing market.

- [ ] **Step 4: Run NBA/WNBA tests**

Run: `node --test tests/nba_collectors.test.js tests/nba_odds_core.test.js tests/nba_three_source_frontend.test.js`

Expected: all tests pass and no live provider string contains `titan`.

- [ ] **Step 5: Commit basketball migration**

```bash
git add nba_bet365_odds.js data/nba_bet365_odds.json tests/nba_collectors.test.js tests/fixtures/bet365-basketball-markets.html
git commit -m "feat: switch basketball bet365 odds to official site"
```

### Task 5: NHL Official Totals and BetExplorer Fallback

**Files:**
- Modify: `nhl_bet365_odds.js`
- Modify: `nhl_bet365_core.js`
- Modify: `data/nhl_bet365_odds.json`
- Modify: `tests/nhl_bet365_odds.test.js`
- Modify: `tests/nhl_bet365_core.test.js`
- Add fixture: `tests/fixtures/bet365-nhl-markets.html`

**Interfaces:**
- Consumes: Task 1 source arbitration.
- Produces: NHL `ml`, `hd`, and `total` markets with per-market source metadata.

- [ ] **Step 1: Write failing total-market and source-switch tests**

```js
test('NHL event detail reads game total', () => {
  const game = parseBet365NhlPage(html)[0];
  assert.deepEqual(game.total, { line: 6.5, over: 1.91, under: 1.91 });
});

test('NHL official to fallback transition does not create a favorite flip', () => {
  const merged = mergeBet365Game(officialGame, fallbackGame, AT);
  assert.equal(merged.events.some(event => event.type === 'favorite-flip'), false);
});
```

- [ ] **Step 2: Run NHL tests and verify RED**

Run: `node --test tests/nhl_bet365_odds.test.js tests/nhl_bet365_core.test.js`

Expected: FAIL because totals and provider-aware merging are absent.

- [ ] **Step 3: Add official totals and fallback arbitration**

Preserve current official Money Line and Puck Line parser. Add event-detail Game Totals parsing and use BetExplorer only when an official market is missing. Expose total line and odds to the existing card model.

- [ ] **Step 4: Run NHL regressions**

Run: `node --test tests/nhl_bet365_odds.test.js tests/nhl_bet365_core.test.js tests/nhl_bet365_frontend.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit NHL completion**

```bash
git add nhl_bet365_odds.js nhl_bet365_core.js data/nhl_bet365_odds.json tests/nhl_bet365_odds.test.js tests/nhl_bet365_core.test.js tests/fixtures/bet365-nhl-markets.html
git commit -m "feat: add official bet365 nhl totals"
```

### Task 6: Switch Baseball, Basketball, and Hockey Frontends to Official-First Resolution

**Files:**
- Create: `baseball-bet365-integration.js`
- Modify: `index.html`
- Modify: `oddsportal-integration.js`
- Modify: `nba-odds-integration.js`
- Modify: `nba.html`
- Modify: `nhl.html`
- Create: `tests/baseball_bet365_frontend.test.js`
- Modify: `tests/nba_three_source_frontend.test.js`
- Modify: `tests/nhl_bet365_frontend.test.js`

**Interfaces:**
- Consumes: normalized feeds from Tasks 3–5.
- Produces: card helpers returning `{ market, provider, stale, observedAt }`.

- [ ] **Step 1: Write failing warning and source-label tests**

```js
test('CPBL official odds suppress BetExplorer missing warning', () => {
  assert.doesNotMatch(renderCard(cpblOfficial, emptyBetExplorer), /抓不到|未開盤/);
  assert.match(renderCard(cpblOfficial, emptyBetExplorer), /BET365 官網/);
});

test('fallback is explicitly labelled and does not create a flip', () => {
  const text = renderHistory([officialHome, fallbackAway]);
  assert.match(text, /BetExplorer 備援/);
  assert.doesNotMatch(text, /曾對調/);
});
```

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `node --test tests/baseball_bet365_frontend.test.js tests/nba_three_source_frontend.test.js tests/nhl_bet365_frontend.test.js`

Expected: FAIL because baseball still reads BetExplorer as the current Bet365 authority.

- [ ] **Step 3: Implement per-market labels and warning rules**

Load `data/baseball_bet365_odds.json` in the baseball page. Change current Bet365 direction, line, prices, history, and flip warning to the new feed. Keep `oddsportal_summary.json` only as fallback input. Basketball and NHL use the same labels: `BET365 官網`, `BetExplorer 備援`, or `舊快照 HH:mm`. Only show no-data warning when both current sources are absent.

- [ ] **Step 4: Bump cache versions and run frontend tests**

Run: `node --test tests/baseball_bet365_frontend.test.js tests/intl_verdict_freshness.test.js tests/nba_three_source_frontend.test.js tests/nhl_bet365_frontend.test.js`

Expected: all tests pass. Confirm each modified add-on has a new `?v=` in its HTML entry point.

- [ ] **Step 5: Commit frontend migration**

```bash
git add baseball-bet365-integration.js index.html oddsportal-integration.js nba-odds-integration.js nba.html nhl.html tests/baseball_bet365_frontend.test.js tests/nba_three_source_frontend.test.js tests/nhl_bet365_frontend.test.js
git commit -m "feat: show official-first bet365 odds across sports"
```

### Task 7: Workflows, Watchdog, and Local Failover

**Files:**
- Create: `.github/workflows/baseball-bet365-odds.yml`
- Modify: `.github/workflows/nba-bet365-odds.yml`
- Modify: `.github/workflows/nhl-bet365-odds.yml`
- Modify: `.github/workflows/pipeline-watchdog.yml`
- Modify: `local_failover.js`
- Modify: `local_failover_workspace.js`
- Create: `tests/bet365_official_workflows.test.js`

**Interfaces:**
- Produces one five-minute long-loop workflow per sport.
- Local failover stages only the three official Bet365 output files it owns.

- [ ] **Step 1: Write failing workflow contract tests**

```js
test('all official bet365 workflows use long loops and isolated outputs', () => {
  for (const spec of workflows) {
    const yaml = read(spec.file);
    assert.match(yaml, /cancel-in-progress:\s*false/);
    assert.match(yaml, /while \[ "\$SECONDS" -lt "\$END" \]/);
    assert.match(yaml, new RegExp(escape(spec.output)));
  }
});
```

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test tests/bet365_official_workflows.test.js`

Expected: FAIL because the baseball workflow is absent and NBA still describes Titan.

- [ ] **Step 3: Add isolated loops and watchdog checks**

Each loop resets to `origin/main`, runs its collector with a timeout, stages only its own JSON, commits only on change, retries push with rebase, and self-dispatches via `WORKFLOW_PAT`. Add all three outputs to watchdog freshness checks. Extend local failover ownership and execution for official-site failures on GitHub runners.

- [ ] **Step 4: Validate YAML and BOM**

Run: `node --test tests/bet365_official_workflows.test.js tests/nba_workflows.test.js tests/nhl_official_workflows.test.js tests/local_failover_workspace.test.js`

Run: `python -c "from pathlib import Path; files=list(Path('.github/workflows').glob('*bet365*.yml')); assert all(p.read_bytes()[:3] != b'\\xef\\xbb\\xbf' for p in files)"`

Expected: tests pass and BOM assertion exits 0.

- [ ] **Step 5: Commit automation**

```bash
git add .github/workflows/baseball-bet365-odds.yml .github/workflows/nba-bet365-odds.yml .github/workflows/nhl-bet365-odds.yml .github/workflows/pipeline-watchdog.yml local_failover.js local_failover_workspace.js tests/bet365_official_workflows.test.js
git commit -m "ci: run official bet365 collectors across sports"
```

### Task 8: Live Verification, Browser Verification, and Deployment

**Files:**
- Modify only files required by failures found in verification.

**Interfaces:**
- Consumes all outputs from Tasks 1–7.
- Produces verified live data and deployed GitHub Pages code.

- [ ] **Step 1: Run the complete focused test suite**

Run:

```bash
node --test tests/bet365_official_core.test.js tests/bet365_official_transport.test.js tests/baseball_bet365_odds.test.js tests/baseball_bet365_frontend.test.js tests/nba_collectors.test.js tests/nba_three_source_frontend.test.js tests/nhl_bet365_odds.test.js tests/nhl_bet365_core.test.js tests/nhl_bet365_frontend.test.js tests/bet365_official_workflows.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Run each collector against the live official site without overwriting tracked data**

Run each collector with an explicit temporary output option and inspect health, provider, match count, market count, timestamps, and CPBL matching. Every live market marked `bet365-official` must originate from Bet365 content; fallback markets must say `betexplorer`.

- [ ] **Step 3: Run browser tests**

Run: `python tests/baseball_stake_ui.py && python tests/nba_page_playwright.py && python tests/nhl_ui.py`

Expected: desktop and mobile cards render; no click target shifts; CPBL official data suppresses the missing warning; source changes do not show a flip.

- [ ] **Step 4: Review the branch and verify staged scope**

Run: `git status --short`, `git diff --check`, and the repository's focused regression suite. Do not stage root `test_*.js` files or `test-results/`.

- [ ] **Step 5: Rebase and deploy safely**

Run:

```bash
git pull --rebase origin main
git status --short
git push origin HEAD:main
git show --stat --oneline -1
```

Success requires the push output to contain `main -> main`. After dispatch, verify actual new timestamps and non-empty market data before declaring the pipelines repaired.
