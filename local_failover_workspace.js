// local_failover_workspace.js — 在專用 clone 中啟動本機備援，隔離互動工作目錄。
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function normalizedRemote(value) {
  const raw = String(value || '').trim();
  if (/^[a-z]+:\/\//i.test(raw) || /^[^/\\]+@[^:]+:/.test(raw)) {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
  return path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase();
}

function ensureFailoverWorkspace({ originUrl, workspaceDir }) {
  if (!originUrl) throw new Error('originUrl is required');
  if (!workspaceDir || !path.isAbsolute(workspaceDir)) {
    throw new Error('workspaceDir must be an absolute path');
  }
  const parent = path.dirname(workspaceDir);
  fs.mkdirSync(parent, { recursive: true });

  if (!fs.existsSync(workspaceDir)) {
    git(['clone', '--branch', 'main', '--single-branch', originUrl, workspaceDir], parent);
  } else if (!fs.statSync(workspaceDir).isDirectory()
      || !fs.statSync(path.join(workspaceDir, '.git')).isDirectory()) {
    throw new Error(`failover workspace is not an independent clone: ${workspaceDir}`);
  }

  const actualOrigin = git(['remote', 'get-url', 'origin'], workspaceDir);
  if (normalizedRemote(actualOrigin) !== normalizedRemote(originUrl)) {
    throw new Error(`failover workspace origin mismatch: ${actualOrigin}`);
  }
  const dirty = git(['status', '--porcelain'], workspaceDir)
    .split(/\r?\n/)
    .filter(line => line && line !== '?? node_modules/')
    .join('\n');
  if (dirty) {
    throw new Error(`failover workspace not clean（不乾淨），拒絕自動覆寫：\n${dirty}`);
  }

  git(['fetch', 'origin', 'main', '--prune'], workspaceDir);
  git(['rebase', 'origin/main'], workspaceDir);
  return workspaceDir;
}

function ensureRuntimeDependencies(workspaceDir, install = null) {
  const lockPath = path.join(workspaceDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return false;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
  const marker = path.join(workspaceDir, '.git', 'bb_failover_deps.sha256');
  const previous = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  if (previous === digest && fs.existsSync(path.join(workspaceDir, 'node_modules'))) return false;

  const runInstall = install || (() => {
    const executable = process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund']
      : ['ci', '--omit=dev', '--no-audit', '--no-fund'];
    execFileSync(executable, args, {
      cwd: workspaceDir,
      stdio: 'inherit',
      windowsHide: true,
    });
  });
  runInstall(workspaceDir);
  fs.writeFileSync(marker, digest + '\n');
  return true;
}

function main() {
  const sourceRepo = __dirname;
  const originUrl = process.env.BB_FAILOVER_ORIGIN || git(['remote', 'get-url', 'origin'], sourceRepo);
  const workspaceDir = path.resolve(
    process.env.BB_FAILOVER_WORKSPACE
      || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Sportbetting-PLUS-failover')
  );
  ensureFailoverWorkspace({ originUrl, workspaceDir });
  ensureRuntimeDependencies(workspaceDir);
  const result = spawnSync(process.execPath, [path.join(workspaceDir, 'local_failover.js'), '--once'], {
    cwd: workspaceDir,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, BB_FAILOVER_ISOLATED: '1' },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[failover workspace] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { ensureFailoverWorkspace, ensureRuntimeDependencies, normalizedRemote };
