# Anomaly Statistics and IndexedDB Migration Implementation Plan

> **For Codex:** Execute this plan inline with test-driven development. Do not delegate because the user requested direct execution in this task.

**Goal:** Restore all three settled anomaly games, preserve both doubleheader games, and move growing divination ledgers from localStorage to verified IndexedDB storage without risking data loss.

**Architecture:** Normalize game identity and anomaly evidence at their shared boundaries, then recover missing settled rows from immutable card snapshots. Add one browser storage adapter that owns IndexedDB migration, verification, legacy gzip fallback, size reporting, and backup reads so every consumer follows the same rules.

**Tech Stack:** Vanilla JavaScript, browser IndexedDB/localStorage APIs, Node.js built-in test runner, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-09-24-anomaly-storage-repair.md`

---

### Task 1: Lock the anomaly regressions with failing tests

**Files:**
- Modify: `tests/anomaly_nrfi_ui.test.js`
- Modify: `tests/oddsportal_integration.test.js`
- Create: `tests/settlement_doubleheader.test.js`

- [x] Add a test where BetExplorer reports `flipEver: false` while Titan has `sw > 0`; require a Bet365 × 台彩 snapshot.
- [x] Add a duplicate OddsPortal fixture and require the candidate whose market activity matches the target date.
- [x] Add two same-team/date fixtures at 01:35 and 06:35 and require two distinct game identities.
- [x] Run the focused tests and confirm they fail for the expected old behavior.

### Task 2: Repair evidence selection, identity, recovery, and statistics

**Files:**
- Modify: `anomaly-nrfi-addon.js`
- Modify: `index.html`
- Modify: `github-sync.js`
- Modify: `tests/anomaly_nrfi_ui.test.js`
- Modify: `tests/settlement_doubleheader.test.js`

- [x] Combine BetExplorer, Titan, and latched swap evidence with OR semantics.
- [x] Rank OddsPortal duplicates by target-date market activity before observation time.
- [x] Introduce a time/official-ID-aware game key and use it for upsert and cloud merge.
- [x] Recover missing `doc.games` rows from settled match cards using each board's date.
- [x] Let `bet365Taiwan.relation` fill anomaly classification only when no explicit manual classification exists.
- [x] Run focused anomaly and settlement tests until green.

### Task 3: Build verified IndexedDB storage test-first

**Files:**
- Modify: `tests/storage_pressure.test.js`
- Modify: `storage-pressure.js`

- [x] Add tests for successful write/read verification, legacy migration cleanup, corrupt verification retention, and IndexedDB-unavailable fallback.
- [x] Run the focused storage tests and confirm they fail before implementation.
- [x] Implement the injectable large-JSON store and production IndexedDB adapter.
- [x] Preserve gzip legacy decoding/encoding and expose size statistics.
- [x] Run the focused storage tests until green.

### Task 4: Integrate divination, sync, backup, and UI

**Files:**
- Modify: `divination-addon.js`
- Modify: `wnba-divination-addon.js`
- Modify: `github-sync.js`
- Modify: `index.html`
- Modify: `nba.html`
- Modify: `tests/index_storage_emergency.test.js`
- Create: `tests/backup_envelope.test.js`

- [x] Route both divination ledgers through the shared store and keep legacy fallback.
- [x] Route GitHub cast pull writes through the same verified storage path.
- [x] Export a versioned backup envelope containing both ledgers and support old/new imports.
- [x] Show localStorage pressure separately from IndexedDB large-data size.
- [x] Bump every changed add-on script query version in its HTML entry point.
- [x] Run backup, storage, sync, and HTML integration tests until green.

### Task 5: Review, verify, deploy, and inspect fresh data

**Files:**
- Review all modified files.

- [x] Run the complete test suite and syntax checks.
- [x] Perform the multi-axis code review and resolve every blocking finding.
- [ ] Verify workflow YAML BOM state if any workflow changed.
- [ ] Run `git status`, stage only intended files, commit, and inspect `git show --stat`.
- [ ] Run `git pull --rebase origin main`, rerun targeted verification if the rebase changes code, then push and confirm `main -> main`.
- [ ] Check the deployed page/data is fresh and confirm both doubleheader games plus Cardinals/Pirates are represented independently.
