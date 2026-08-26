'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function loadWorkspaceModule() {
  try {
    return require('../local_failover_workspace.js');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND'
        && String(error.message).includes('local_failover_workspace.js')) {
      return {};
    }
    throw error;
  }
}

test('local failover installs runtime dependencies only when package-lock changes', () => {
  const { ensureRuntimeDependencies } = loadWorkspaceModule();
  assert.equal(typeof ensureRuntimeDependencies, 'function');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-deps-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    let installs = 0;
    const install = () => {
      installs++;
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    };

    assert.equal(ensureRuntimeDependencies(root, install), true);
    assert.equal(installs, 1);
    assert.equal(ensureRuntimeDependencies(root, install), false);
    assert.equal(installs, 1);

    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    assert.equal(ensureRuntimeDependencies(root, install), true);
    assert.equal(installs, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local failover can execute the real npm ci entrypoint on Windows', { skip: process.platform !== 'win32' }, () => {
  const { ensureRuntimeDependencies } = loadWorkspaceModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-real-npm-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'failover-real-npm-test',
      version: '1.0.0',
      private: true,
    }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      name: 'failover-real-npm-test',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'failover-real-npm-test',
          version: '1.0.0',
        },
      },
    }));

    assert.equal(ensureRuntimeDependencies(root), true);
    assert.ok(fs.existsSync(path.join(root, '.git', 'bb_failover_deps.sha256')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local failover runs from an independent clone and fast-forwards it without touching the interactive clone', () => {
  const { ensureFailoverWorkspace } = loadWorkspaceModule();
  assert.equal(typeof ensureFailoverWorkspace, 'function');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-workspace-'));
  const origin = path.join(root, 'origin.git');
  const interactive = path.join(root, 'interactive');
  const failover = path.join(root, 'failover');
  try {
    git(['init', '--bare', origin], root);
    git(['init', '-b', 'main', interactive], root);
    git(['config', 'user.email', 'test@example.invalid'], interactive);
    git(['config', 'user.name', 'Test'], interactive);
    fs.writeFileSync(path.join(interactive, 'tracked.txt'), 'v1\n');
    git(['add', 'tracked.txt'], interactive);
    git(['commit', '-m', 'seed'], interactive);
    git(['remote', 'add', 'origin', origin], interactive);
    git(['push', '-u', 'origin', 'main'], interactive);

    ensureFailoverWorkspace({ originUrl: origin, workspaceDir: failover });
    const failoverGitDir = path.resolve(git(['rev-parse', '--absolute-git-dir'], failover));
    assert.equal(failoverGitDir, path.join(failover, '.git'));
    assert.notEqual(failoverGitDir, path.join(interactive, '.git'));

    fs.writeFileSync(path.join(interactive, 'interactive-only.txt'), 'do not copy\n');
    assert.equal(fs.existsSync(path.join(failover, 'interactive-only.txt')), false);

    fs.writeFileSync(path.join(interactive, 'tracked.txt'), 'v2\n');
    git(['add', 'tracked.txt'], interactive);
    git(['commit', '-m', 'update'], interactive);
    git(['push', 'origin', 'main'], interactive);
    ensureFailoverWorkspace({ originUrl: origin, workspaceDir: failover });

    assert.equal(
      fs.readFileSync(path.join(failover, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n'),
      'v2\n'
    );
    assert.equal(fs.existsSync(path.join(interactive, 'interactive-only.txt')), true);

    fs.mkdirSync(path.join(failover, 'node_modules'));
    fs.writeFileSync(path.join(failover, 'node_modules', 'runtime.txt'), 'generated dependency\n');
    assert.doesNotThrow(
      () => ensureFailoverWorkspace({ originUrl: origin, workspaceDir: failover })
    );

    fs.writeFileSync(path.join(failover, 'unexpected-local-file.txt'), 'dirty\n');
    assert.throws(
      () => ensureFailoverWorkspace({ originUrl: origin, workspaceDir: failover }),
      /not clean|不乾淨/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ══ 2026-08-04 自癒收殮：自家產出殘留不再把備援卡死（8/1 卡死 3.5 天事故）══

test('classifyFailoverDirt separates failover-owned outputs from foreign files', () => {
  const { classifyFailoverDirt } = loadWorkspaceModule();
  assert.equal(typeof classifyFailoverDirt, 'function');
  const wedge = classifyFailoverDirt([
    'A  data/oddsportal_history/2026-08-01.jsonl.gz',
    'M  data/oddsportal_summary.json',
  ]);
  assert.deepEqual(wedge.foreign, []);          // 8/1 實際卡死的兩個檔＝可自癒
  assert.equal(wedge.owned.length, 2);

  const mixed = classifyFailoverDirt([
    'M  data/oddsportal_summary.json',
    ' M local_failover.js',                      // 程式碼被動過＝絕不自動處理
  ]);
  assert.deepEqual(mixed.foreign, ['local_failover.js']);

  const renamed = classifyFailoverDirt(['R  data/x.json -> data/pregame_data.json']);
  assert.deepEqual(renamed.foreign, []);
  const quoted = classifyFailoverDirt(['?? "data/expert_archive/a b.json"']);
  assert.deepEqual(quoted.foreign, []);

  // playsport_scraper 會先在 repo 根產生 NRFI 暫存檔，再鏡射到 data/。
  // 上一輪若中斷，這個可重建產物不能讓整條備援永久 fail-closed。
  const nrfiRoot = classifyFailoverDirt(['?? nrfi_results.json']);
  assert.deepEqual(nrfiRoot.foreign, []);
  assert.deepEqual(nrfiRoot.owned, ['nrfi_results.json']);
});

test('local failover mirrors every playsport output including NRFI into data', () => {
  const { mirrorPregameOutputs } = loadWorkspaceModule();
  assert.equal(typeof mirrorPregameOutputs, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-pregame-outputs-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'pregame_data.json'), '[{"id":"game"}]');
    fs.writeFileSync(path.join(root, 'lottery_series.json'), '{"games":{}}');
    fs.writeFileSync(path.join(root, 'nrfi_results.json'), '{"games":{"game":{"nrfi":true}}}');
    const staged = [];

    mirrorPregameOutputs(root, staged);

    assert.deepEqual(staged, [
      'data/pregame_data.json',
      'data/lottery_series.json',
      'data/nrfi_results.json',
    ]);
    assert.equal(
      fs.readFileSync(path.join(root, 'data', 'nrfi_results.json'), 'utf8'),
      '{"games":{"game":{"nrfi":true}}}'
    );
    assert.equal(fs.existsSync(path.join(root, 'nrfi_results.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generated NRFI scratch file does not wedge the isolated failover workspace', () => {
  const { ensureFailoverWorkspace } = loadWorkspaceModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-nrfi-scratch-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const failover = path.join(root, 'failover');
  try {
    git(['init', '--bare', origin], root);
    git(['init', '-b', 'main', seed], root);
    git(['config', 'user.email', 'test@example.invalid'], seed);
    git(['config', 'user.name', 'Test'], seed);
    fs.writeFileSync(path.join(seed, 'tracked.txt'), 'seed\n');
    git(['add', 'tracked.txt'], seed);
    git(['commit', '-m', 'seed'], seed);
    git(['remote', 'add', 'origin', origin], seed);
    git(['push', '-u', 'origin', 'main'], seed);
    ensureFailoverWorkspace({ originUrl: origin, workspaceDir: failover });
    fs.writeFileSync(path.join(failover, 'nrfi_results.json'), '{"games":{}}');

    assert.doesNotThrow(
      () => ensureFailoverWorkspace({ originUrl: origin, workspaceDir: failover })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 2026-08-07 卡死事故：git() 對 porcelain 輸出做 .trim()，第一行的狀態欄空格被吃掉，
// 舊版固定 slice(3) 多砍兩字元 → 自家產出檔被誤判成外來檔 → 整輪 fail-closed 12 小時。
test('classifyFailoverDirt tolerates the leading space trimmed off the first porcelain line', () => {
  const { classifyFailoverDirt } = require('../local_failover_workspace.js');
  // git() 回傳的是 .trim() 過的整段 → 第一行少了開頭空格
  const trimmed = [' M lottery_series.json', ' M pregame_data.json'].join('\n').trim().split('\n');
  const dirt = classifyFailoverDirt(trimmed);
  assert.deepEqual(dirt.foreign, []);
  assert.deepEqual(dirt.owned, ['lottery_series.json', 'pregame_data.json']);

  // 任何自家產出檔排在第一行都必須通過（實測任一種都會卡死）
  for (const first of [' M data/oddsportal_summary.json', ' M data/oddsportal_harvest_state.json',
                       'M  data/pregame_data.json', '?? data/oddsportal_archive/2026-05.json']) {
    const one = classifyFailoverDirt([first].join('\n').trim().split('\n'));
    assert.deepEqual(one.foreign, [], `應判為自家產出：${first}`);
  }

  // 外來檔仍必須 fail-closed（守門不能被放寬掉）
  const mixed = classifyFailoverDirt([' M index.html', ' M data/oddsportal_summary.json'].join('\n').trim().split('\n'));
  assert.deepEqual(mixed.foreign, ['index.html']);

  // 改名列仍取箭頭後的新路徑
  const renamed = classifyFailoverDirt(['R  data/old.json -> data/oddsportal_summary.json']);
  assert.deepEqual(renamed.owned, ['data/oddsportal_summary.json']);
});

test('NRFI 根目錄暫存檔會先鏡射到 data 再移除，避免下一輪再次卡死', () => {
  const { recoverOwnedRootOutputs } = require('../local_failover_workspace.js');
  assert.equal(typeof recoverOwnedRootOutputs, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-nrfi-recover-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const fresh = { updatedAt: '2026-08-26T10:00:00+08:00', games: { a: { nrfi: true } } };
    fs.writeFileSync(path.join(root, 'nrfi_results.json'), JSON.stringify(fresh));
    fs.writeFileSync(path.join(root, 'data', 'nrfi_results.json'), JSON.stringify({ games: {} }));

    recoverOwnedRootOutputs(root, ['nrfi_results.json']);

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'data', 'nrfi_results.json'), 'utf8')),
      fresh
    );
    assert.equal(fs.existsSync(path.join(root, 'nrfi_results.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 2026-08-09 卡死事故：上一輪 rebase 中途死掉留下 .git/rebase-merge，
// 之後每輪都撞「already a rebase-merge directory」→ 連續 33 小時沒抓任何資料。
test('a leftover rebase directory is cleaned up instead of wedging every run', () => {
  const fs = require('node:fs'), os = require('node:os'), pathMod = require('node:path');
  const { ensureFailoverWorkspace } = require('../local_failover_workspace.js');
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'bbwedge-'));
  const origin = pathMod.join(root, 'origin.git');
  const ws = pathMod.join(root, 'ws');
  const run = (args, cwd) => require('node:child_process').execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    // 建一個最小的上游 repo
    fs.mkdirSync(origin); run(['init', '--bare', '-b', 'main'], origin);
    const seed = pathMod.join(root, 'seed');
    fs.mkdirSync(seed); run(['init', '-b', 'main'], seed);
    run(['config', 'user.email', 't@t'], seed); run(['config', 'user.name', 't'], seed);
    fs.writeFileSync(pathMod.join(seed, 'a.txt'), 'one');
    run(['add', '-A'], seed); run(['commit', '-m', 'seed'], seed);
    run(['remote', 'add', 'origin', origin], seed); run(['push', 'origin', 'main'], seed);

    ensureFailoverWorkspace({ originUrl: origin, workspaceDir: ws });   // 首次 clone
    // 偽造上一輪殘留的 rebase 目錄
    fs.mkdirSync(pathMod.join(ws, '.git', 'rebase-merge'), { recursive: true });
    fs.writeFileSync(pathMod.join(ws, '.git', 'rebase-merge', 'head-name'), 'refs/heads/main');

    ensureFailoverWorkspace({ originUrl: origin, workspaceDir: ws });   // 不該丟例外
    assert.equal(fs.existsSync(pathMod.join(ws, '.git', 'rebase-merge')), false, '殘留的 rebase 應被收拾');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
});
