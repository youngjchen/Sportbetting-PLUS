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

    fs.writeFileSync(path.join(failover, 'unexpected-local-file.txt'), 'dirty\n');
    assert.throws(
      () => ensureFailoverWorkspace({ originUrl: origin, workspaceDir: failover }),
      /not clean|不乾淨/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
