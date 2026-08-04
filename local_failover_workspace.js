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

// 備援自家會 stage 的全部產出路徑（local_failover.js 各 staged.push 的聯集）。
// 自癒收殮只敢動這份清單內的殘留；清單外＝可能是人手改動，一律 fail-closed。
const FAILOVER_OUTPUT_ROOTS = ['data', 'pregame_data.json', 'lottery_series.json'];
const FAILOVER_OWNED_RE = [
  /^data\/oddsportal_summary\.json$/,
  /^data\/oddsportal_history\//,
  /^data\/oddsportal_archive\//,
  /^data\/oddsportal_harvest_state\.json$/,
  /^data\/pregame_data\.json$/,
  /^data\/lottery_series\.json$/,
  /^data\/expert_picks_(?:mlb|npb|cpbl|kbo)\.json$/,
  /^data\/expert_archive\//,
  /^pregame_data\.json$/,
  /^lottery_series\.json$/,
];

function classifyFailoverDirt(lines) {
  const owned = [], foreign = [];
  for (const line of lines) {
    // porcelain: XY<space>path；rename 'R  old -> new' 取箭頭後；引號路徑去引號
    let rel = String(line).slice(3).trim();
    const arrow = rel.indexOf(' -> ');
    if (arrow >= 0) rel = rel.slice(arrow + 4);
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    rel = rel.replace(/\\/g, '/');
    (FAILOVER_OWNED_RE.some((re) => re.test(rel)) ? owned : foreign).push(rel);
  }
  return { owned, foreign };
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
  // 2026-08-04 根治：專用 clone 沒設 git 身分 → 8/1 06:14 commit 失敗、產出卡在暫存區、
  // 潔癖檢查從此整輪拒跑 3.5 天（log「推送流程失敗：git commit」）。身分設定必須早於任何 commit。
  git(['config', 'user.name', 'bb-failover[local]'], workspaceDir);
  git(['config', 'user.email', 'bb-failover@local'], workspaceDir);
  const dirtyLines = git(['status', '--porcelain'], workspaceDir)
    .split(/\r?\n/)
    .filter(line => line && line !== '?? node_modules/');
  if (dirtyLines.length) {
    // 自癒收殮：殘留若全是「備援自家產出檔」（上輪 commit/push 中途死掉的孤兒），
    // 收殮成一個 commit 繼續跑（隨下一次成功輪一起推上雲）；有任何非自家檔案照舊 fail-closed。
    const dirt = classifyFailoverDirt(dirtyLines);
    if (dirt.foreign.length) {
      throw new Error(`failover workspace not clean（不乾淨），拒絕自動覆寫：\n${dirtyLines.join('\n')}`);
    }
    for (const rel of dirt.owned) {
      if (rel.endsWith('.json')) {
        try { JSON.parse(fs.readFileSync(path.join(workspaceDir, rel), 'utf8')); }
        catch (_) {
          // 半寫壞檔：追蹤檔還原乾淨版；未追蹤壞檔直接丟（都是可再生產出）
          try { git(['checkout', '--', rel], workspaceDir); }
          catch (_) { try { fs.unlinkSync(path.join(workspaceDir, rel)); } catch (_) {} }
        }
      }
    }
    git(['add', '-A', '--', ...FAILOVER_OUTPUT_ROOTS], workspaceDir);
    try { git(['commit', '-q', '-m', 'data: failover 自癒收殮上輪殘留產出（中斷孤兒，防 fail-closed 卡死）'], workspaceDir); }
    catch (_) { /* 全被還原成乾淨版=無事可提交 */ }
    console.log('[failover workspace] 已自癒收殮殘留產出：\n' + dirtyLines.join('\n'));
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

module.exports = { ensureFailoverWorkspace, ensureRuntimeDependencies, normalizedRemote, classifyFailoverDirt, FAILOVER_OUTPUT_ROOTS };
