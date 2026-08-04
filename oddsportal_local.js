'use strict';

// ============================================================
// oddsportal_local.js — OddsPortal/Stake 本機抓取的「賽程驅動閘」
// 2026-08-04 使用者拍板：廢除 15 分鐘盯哨（設計上一天 ~3000 頁請求），
// 改一天 5-6 閘（~150-190 頁請求）：
//   open  ：各聯盟開盤後抓初盤 —— MLB 前一天 07:00（實證前日凌晨 ~03:00 開盤，
//           抓「明日」場）；亞洲三聯盟當天 03:00（實證中職最晚 00:21 開盤）。
//   flip  ：開賽前 2.5 小時巡一次讓分對調（亞洲一簇；MLB 以首場為錨，一簇）。
//   close ：該群組最晚開賽 +10 分後統一抓收盤（收盤=走勢史中開賽前最後一筆，
//           由 oddsportal_scraper.py 於已開賽場次自動改用時戳取法）。
// 每一閘皆為「缺口驅動」：優先抓專案裡初盤/收盤還沒填的比賽（含過去 3.5 天回補），
// 上限 40 場/閘。錯過 6 小時的閘直接過期不補（缺口回補由之後任何閘順手完成）。
// ============================================================

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const INTERVAL_MS = 15 * 60_000;           // 舊盯哨常數；僅為相容保留，不再驅動排程
const ASIA_LEAGUES = Object.freeze(['npb', 'kbo', 'cpbl']);
const GATE_LOOKBACK_MS = 6 * 3600e3;
const BACKFILL_HOURS = 120;                // 每閘順手回補過去 5 天的缺口（涵蓋 8/1 搶救批）
const T_FLIP_MIN = 150;                    // 開賽前 2.5h
const CLOSE_LAG_MIN = 10;                  // 最晚開賽 +10 分
const OPEN_ASIA_HHMM = '03:00';
const OPEN_MLB_HHMM = '07:00';
const OUTPUT_PATHS = Object.freeze([
  'data/oddsportal_summary.json',
  'data/oddsportal_history',
]);

function isOddsPortalDue(lastAttemptMs, nowMs = Date.now()) {
  const last = Number(lastAttemptMs) || 0;
  return last <= 0 || nowMs - last >= INTERVAL_MS;
}

function gameStartMs(game) {
  const date = String((game && game.date) || '').slice(0, 10);
  const timeText = String((game && (game.gameTime || game.time)) || '');
  const match = timeText.match(/\d{1,2}:\d{2}/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !match) return null;
  const ms = Date.parse(`${date}T${match[0].padStart(5, '0')}:00+08:00`);
  return Number.isFinite(ms) ? ms : null;
}

function dayBefore(date) {
  const ms = Date.parse(`${date}T00:00:00+08:00`) - 86400e3;
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
}

// games＝data/pregame_data.json 的陣列（今天＋明天）。回傳依時間排序的閘清單。
function computeOddsPortalGates(games, nowMs = Date.now()) {
  const groups = new Map();
  for (const game of games || []) {
    const league = String((game && game.league) || '').toLowerCase();
    const grp = league === 'mlb' ? 'mlb' : (ASIA_LEAGUES.includes(league) ? 'asia' : null);
    if (!grp) continue;
    const startMs = gameStartMs(game);
    if (!startMs) continue;
    const date = String(game.date).slice(0, 10);
    const key = `${grp}|${date}`;
    const cur = groups.get(key) || { min: startMs, max: startMs };
    cur.min = Math.min(cur.min, startMs);
    cur.max = Math.max(cur.max, startMs);
    groups.set(key, cur);
  }
  const gates = [];
  for (const [key, span] of groups) {
    const [grp, date] = key.split('|');
    const leagues = grp === 'mlb' ? ['mlb'] : [...ASIA_LEAGUES];
    const openAt = grp === 'mlb'
      ? Date.parse(`${dayBefore(date)}T${OPEN_MLB_HHMM}:00+08:00`)
      : Date.parse(`${date}T${OPEN_ASIA_HHMM}:00+08:00`);
    const flipAt = span.min - T_FLIP_MIN * 60e3;
    const closeAt = span.max + CLOSE_LAG_MIN * 60e3;
    gates.push({ id: `open_${grp}_${date}`, at: openAt, mode: 'open', leagues, fromHours: -BACKFILL_HOURS, toHours: 36, maxGames: 40 });
    gates.push({ id: `flip_${grp}_${date}`, at: flipAt, mode: 'flip', leagues, fromHours: -BACKFILL_HOURS, toHours: Math.max(2, Math.ceil((span.max - flipAt) / 3600e3) + 1), maxGames: 40, refreshUpcoming: true });
    gates.push({ id: `close_${grp}_${date}`, at: closeAt, mode: 'close', leagues, fromHours: -BACKFILL_HOURS, toHours: 1, maxGames: 40 });
  }
  gates.sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  return gates;
}

// 一次醒來只放行一個到點且未跑過的閘；過期（>6h）的閘永遠不補跑。
function dueOddsPortalGate(gates, state, nowMs = Date.now()) {
  for (const gate of gates || []) {
    if (gate.at <= nowMs && nowMs - gate.at <= GATE_LOOKBACK_MS && !state[`opg_${gate.id}`]) return gate;
  }
  return null;
}

function pruneOddsPortalGateState(state, nowMs = Date.now()) {
  for (const key of Object.keys(state || {})) {
    if (key.startsWith('opg_') && nowMs - (Number(state[key]) || 0) > 7 * 86400e3) delete state[key];
  }
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

// ── 歷史收割閘（2026-08-05 使用者拍板：RESULTS 區 4/1 至今全量）──
// 每天三批、每批一個聯盟 350 場（收割器自選未完成聯盟），全部 done 後自動熄火。
const HARVEST_HHMM = Object.freeze(['05:05', '11:35', '15:05']);
const HARVEST_OUTPUTS = Object.freeze([
  'data/oddsportal_archive',
  'data/oddsportal_history',
  'data/oddsportal_harvest_state.json',
]);

function dueHarvestGate(harvestState, state, nowMs = Date.now()) {
  const allDone = ['mlb', 'npb', 'kbo', 'cpbl'].every((lg) => ((harvestState || {})[lg] || {}).done);
  if (allDone) return null;
  const day = new Date(nowMs + 8 * 3600e3).toISOString().slice(0, 10);
  for (const hhmm of HARVEST_HHMM) {
    const at = Date.parse(`${day}T${hhmm}:00+08:00`);
    const id = `harvest_${day}_${hhmm.replace(':', '')}`;
    if (at <= nowMs && nowMs - at <= GATE_LOOKBACK_MS && !state[`opg_${id}`]) {
      return { id, at, harvest: true };
    }
  }
  return null;
}

function runOddsPortalHarvest({ repoDir, python = resolvePython(), timeoutMs = 100 * 60_000 }) {
  execFileSync(python, ['oddsportal_harvest.py', '--max-games', '350'], {
    cwd: repoDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  return [...HARVEST_OUTPUTS];
}

function oddsPortalArgs(gate) {
  const args = ['oddsportal_scraper.py'];
  if (!gate) return args;
  args.push('--leagues', gate.leagues.join(','));
  args.push('--from-hours', String(gate.fromHours));
  args.push('--to-hours', String(gate.toHours));
  args.push('--max-games', String(gate.maxGames));
  args.push('--include-started');
  if (gate.refreshUpcoming) args.push('--refresh-upcoming');
  return args;
}

function runOddsPortal({ repoDir, gate = null, python = resolvePython(), timeoutMs = 30 * 60_000 }) {
  execFileSync(python, oddsPortalArgs(gate), {
    cwd: repoDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  return [...OUTPUT_PATHS];
}

module.exports = {
  INTERVAL_MS,
  HARVEST_HHMM,
  HARVEST_OUTPUTS,
  dueHarvestGate,
  runOddsPortalHarvest,
  OUTPUT_PATHS,
  ASIA_LEAGUES,
  GATE_LOOKBACK_MS,
  isOddsPortalDue,
  gameStartMs,
  computeOddsPortalGates,
  dueOddsPortalGate,
  pruneOddsPortalGateState,
  oddsPortalArgs,
  pythonCandidates,
  resolvePython,
  runOddsPortal,
};
