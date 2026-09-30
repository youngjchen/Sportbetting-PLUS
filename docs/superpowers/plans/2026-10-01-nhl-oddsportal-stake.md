# NHL OddsPortal Stake Primary Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OddsPortal's Stake.com NHL moneyline, puck-line, and totals prices the board's primary odds source while retaining Bet365 as an explicitly secondary reference/fallback.

**Architecture:** Extend the existing cross-sport OddsPortal scraper instead of introducing another browser stack. Persist the full history in the existing summary and publish a dedicated compact NHL projection consumed through a small `nhl_stake_core.js` adapter; `nhl.html` then applies manual values, Stake, Bet365, and defaults in that order.

**Tech Stack:** Python 3.12+, Scrapling/Playwright browser fetcher, vanilla JavaScript, Node test runner/JSDOM, GitHub Actions, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-01-nhl-oddsportal-stake.md`

## Global Constraints

- Stake.com is authoritative for NHL ML/HD/OU whenever that market is present.
- Bet365 is reference-only except as a missing-market fallback.
- Manual card overrides remain authoritative.
- Empty or challenged scrapes retain the last valid feed.
- Workflow YAML must be UTF-8 without BOM.
- Changes to add-on JavaScript require a version bump in `nhl.html`.
- Root `test_*.js` files are local test artifacts and must not be committed.

---

### Task 1: Register NHL in the shared OddsPortal scraper

**Files:**
- Modify: `tests/test_oddsportal_scraper.py`
- Modify: `oddsportal_scraper.py`

**Interfaces:**
- Consumes: `data/nhl_pregame.json` object with `games[]` rows containing `date`, `time`, `away`, `home`, and `officialId`.
- Produces: normalized NHL schedule rows and `LEAGUE_URLS["nhl"]` using `/hockey/usa/nhl/`.

- [ ] **Step 1: Write failing tests** for all 32 NHL team aliases, NHL league registration, main-line selection, and merging `nhl_pregame.json` into `_load_schedule`.
- [ ] **Step 2: Run `python -m unittest tests.test_oddsportal_scraper.NhlSupportTests -v`** and confirm failures are caused by missing NHL support.
- [ ] **Step 3: Add the NHL URL, team aliases, main-line league flag, and schedule normalization** in `oddsportal_scraper.py`.
- [ ] **Step 4: Re-run the focused Python tests** and confirm they pass.

### Task 2: Publish a compact NHL Stake feed

**Files:**
- Modify: `tests/test_oddsportal_scraper.py`
- Modify: `oddsportal_scraper.py`
- Modify: `.github/workflows/oddsportal-scrape.yml`
- Create: `data/nhl_oddsportal_stake.json`

**Interfaces:**
- Consumes: the merged `oddsportal_summary.json` schema.
- Produces: `_project_league_summary(summary, "nhl") -> dict` and atomically written `data/nhl_oddsportal_stake.json`.

- [ ] **Step 1: Write a failing projection test** proving only NHL games are retained and the source/bookmaker/health metadata remains available.
- [ ] **Step 2: Run the focused test** and observe the missing projection failure.
- [ ] **Step 3: Implement the projection and CLI output path**, writing it only after at least one valid scrape result.
- [ ] **Step 4: Update the workflow paths, conflict check, and staged files** for the compact NHL feed.
- [ ] **Step 5: Verify workflow BOM bytes and run the Python suite**.

### Task 3: Add the Stake feed adapter and source precedence

**Files:**
- Create: `tests/nhl_stake_core.test.js`
- Create: `nhl_stake_core.js`
- Modify: `nhl.html`

**Interfaces:**
- Consumes: compact OddsPortal game objects and existing `NhlBet365` matches.
- Produces: `findStakeGame`, `marketSnapshot`, `marketOutcome`, and `applyOddsToPregame` on `window.NhlStake`/CommonJS.

- [ ] **Step 1: Write failing Node tests** for exact NHL matching, a 12-hour safety window, Stake market normalization, manual override priority, Stake-over-Bet365 priority, and Bet365 fallback.
- [ ] **Step 2: Run `node --test tests/nhl_stake_core.test.js`** and confirm the module/API is missing.
- [ ] **Step 3: Implement `nhl_stake_core.js` minimally** to satisfy the precedence contract.
- [ ] **Step 4: Re-run the focused core tests** and confirm they pass.
- [ ] **Step 5: Load the compact Stake feed in `nhl.html`**, pass both matches through the adapter, and bump the script query version.

### Task 4: Render Stake as primary and Bet365 as reference

**Files:**
- Create: `tests/nhl_stake_frontend.test.js`
- Modify: `nhl.html`

**Interfaces:**
- Consumes: `model.stake`, `model.bet365`, `model.hdFav`, `model.hdVal`, and `model.totLine`.
- Produces: card text and controls showing Stake prices/lines first and Bet365 inside the reference details.

- [ ] **Step 1: Write a failing JSDOM test** with conflicting Stake and Bet365 lines, asserting the card uses Stake ML/HD/OU, labels Bet365 as reference, and preserves manual swap/total overrides.
- [ ] **Step 2: Run the focused frontend test** and confirm it fails on Bet365-primary rendering.
- [ ] **Step 3: Update probability, row price labels, trend text, source badge, expanded details, and total basis** to use Stake first.
- [ ] **Step 4: Re-run the frontend and existing Bet365 tests**, updating only assertions whose product behavior intentionally changed.

### Task 5: Live scrape, browser verification, and deployment

**Files:**
- Update: `data/nhl_oddsportal_stake.json` from a real scrape only if valid.

**Interfaces:**
- Consumes: live OddsPortal NHL listing/event pages and the current NHL schedule.
- Produces: a deployed GitHub Pages NHL board and an active polling pipeline.

- [ ] **Step 1: Run all Python and Node tests** and require zero failures.
- [ ] **Step 2: Run one real NHL-only scraper pass** with debug output and require at least one successfully matched game containing Stake markets.
- [ ] **Step 3: Serve the site locally and verify desktop/mobile cards** show Stake ML/HD/OU, working swap, and editable total line.
- [ ] **Step 4: Inspect `git status`, stage only intended files, and inspect the staged diff**.
- [ ] **Step 5: Commit, inspect `git show --stat`, pull/rebase `origin/main`, re-run verification, and push `HEAD:main`** while confirming the actual push exit status.
- [ ] **Step 6: Verify the workflow run and live GitHub Pages asset timestamps/content** before reporting completion.
