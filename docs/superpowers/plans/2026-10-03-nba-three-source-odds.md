# NBA Three-Source Odds Implementation Plan

> **For agentic workers:** Execute inline with test-driven development; every production behavior first receives a failing test.

**Goal:** Render NBA games in `nba.html` with STAKE, Bet365, and Taiwan Sports Lottery markets, STAKE history monitoring, and automatic line filling, while making NPB/CPBL STAKE status explicit.

**Architecture:** Keep WNBA untouched at the data-source boundary. Add independent NBA collectors and a small browser integration module; make the existing basketball renderer league-aware. Extend the baseball integration only at its display/status boundary.

**Tech Stack:** Node.js, Cheerio, vanilla browser JavaScript, GitHub Actions, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-nba-three-source-odds-design.md`

## Global Constraints

- STAKE is the only automatic handicap/total authority for NBA cards.
- Reject observations completed inside the final 30 seconds and all in-play observations.
- Missing bookmaker data remains visibly missing; never substitute another bookmaker under the wrong label.
- NBA, WNBA, NHL, and baseball data files and workflow concurrency groups remain isolated.
- Modified add-on script tags receive a new `?v=` value.

---

### Task 1: NBA parser and STAKE core

**Files:**
- Create: `nba_odds_core.js`
- Create: `tests/nba_odds_core.test.js`
- Create: `tests/nba_scraper.test.js`

- [ ] Write failing tests for the Heat PlaySport three-market row, both STAKE tournament schedules, balanced spread/total selection, team orientation, history dedupe, partial preservation, and the 30-second cutoff.
- [ ] Run the tests and confirm failures are caused by missing production interfaces.
- [ ] Implement the minimal pure parsing and merge functions.
- [ ] Run the focused tests to green.

### Task 2: NBA collectors and data

**Files:**
- Create: `nba_scraper.js`
- Create: `nba_stake_odds.js`
- Create: `nba_bet365_odds.js`
- Create: `data/nba_pregame.json`
- Create: `data/nba_lottery_series.json`
- Create: `data/nba_stake_odds.json`
- Create: `data/nba_bet365_odds.json`

- [ ] Write failing collector contract tests for output shape, no-empty overwrite, preseason inclusion, pregame-only filtering, and source labels.
- [ ] Run the contract tests red.
- [ ] Implement each independent collector with atomic writes and previous-valid preservation.
- [ ] Run live collectors and validate the Heat fixture plus JSON invariants.

### Task 3: Basketball page and three-source integration

**Files:**
- Create: `nba-odds-integration.js`
- Modify: `nba.html`
- Create: `tests/nba_three_source_frontend.test.js`
- Create: `tests/nba_three_source_ui.py`

- [ ] Write failing tests proving NBA is rendered, all three source rows are present, STAKE auto-fill works, manual locks persist, and restore buttons work.
- [ ] Run the tests red.
- [ ] Make pregame loading and rendering league-aware; install the versioned integration add-on.
- [ ] Add compact three-source rows and lazy STAKE history.
- [ ] Run unit and Playwright tests green.

### Task 4: Baseball NPB/CPBL visibility

**Files:**
- Modify: `baseball-stake-integration.js`
- Modify: `index.html`
- Modify: `tests/baseball_stake_frontend.test.js`

- [ ] Write failing tests for complete NPB three-market text and CPBL official-no-offer text.
- [ ] Run red, implement status-row fallback, then run green.
- [ ] Bump the baseball integration cache version.

### Task 5: Workflows, deployment, and verification

**Files:**
- Create: `.github/workflows/nba-scrape.yml`
- Create: `.github/workflows/nba-stake-odds.yml`
- Create: `.github/workflows/nba-bet365-odds.yml`
- Modify: `.github/workflows/pipeline-watchdog.yml`
- Create: `tests/nba_workflows.test.js`

- [ ] Write workflow contract tests for loop cadence, concurrency, staged paths, self-handoff, watchdog entries, and BOM.
- [ ] Implement workflows and run tests.
- [ ] Run all focused and related regressions, syntax checks, JSON validation, and browser tests.
- [ ] Inspect staged files, commit only scoped files, rebase on `origin/main`, push, then verify Actions starts and fresh NBA data reaches main.
