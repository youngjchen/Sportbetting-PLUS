'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const INTERVAL_MS = 15 * 60_000;
const OUTPUT_PATHS = Object.freeze([
  'data/oddsportal_summary.json',
  'data/oddsportal_history',
]);

function isOddsPortalDue(lastAttemptMs, nowMs = Date.now()) {
  const last = Number(lastAttemptMs) || 0;
  return last <= 0 || nowMs - last >= INTERVAL_MS;
}

function pythonCandidates(env = process.env) {
  const values = [
    env.ODDSPORTAL_PYTHON,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Python', 'bin', 'python.exe'),
    'python',
  ].filter(Boolean);
  return [...new Set(values)];
}

function resolvePython(env = process.env, probe = execFileSync) {
  const errors = [];
  for (const candidate of pythonCandidates(env)) {
    try {
      probe(candidate, ['-c', 'import scrapling'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return candidate;
    } catch (error) {
      errors.push(`${candidate}: ${String(error.message || error).split(/\r?\n/)[0]}`);
    }
  }
  throw new Error(`找不到已安裝 Scrapling 的 Python runtime：${errors.join(' | ')}`);
}

function runOddsPortal({ repoDir, python = resolvePython(), timeoutMs = 20 * 60_000 }) {
  execFileSync(python, ['oddsportal_scraper.py'], {
    cwd: repoDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  return [...OUTPUT_PATHS];
}

module.exports = {
  INTERVAL_MS,
  OUTPUT_PATHS,
  isOddsPortalDue,
  pythonCandidates,
  resolvePython,
  runOddsPortal,
};
