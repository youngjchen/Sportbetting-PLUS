'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseStakeMarkets,
  matchPregameGame,
  mergeStakeObservation,
  pregameStartMs,
} = require('./nba_odds_core.js');

const BASE_URL = 'https://odds-data.stake.com';
const OUT = path.join(__dirname, 'data', 'nba_stake_odds.json');
const PREGAME = path.join(__dirname, 'data', 'nba_pregame.json');
// Stake 賽程時間只到整點（07:30 開打寫 07:00；2026-10-15 查證）。整點過後一小時內仍抓，是否已開賽改看玩運彩的開賽時間
// （玩運彩對 ESPN 42 場有 41 場一致）。
const FLOOR_SLACK_MS = 60 * 60 * 1000;
const START_MATCH_MS = 2 * 3600000;
const SCHEDULES = Object.freeze({
  preseason: '/schedule/sport/basketball/usa/tournament/nba-preseason',
  regular: '/schedule/sport/basketball/usa/tournament/nba',
});

function scheduleFixtures(payload) {
  const rows = [];
  for (const bucket of Array.isArray(payload && payload.schedule) ? payload.schedule : []) {
    rows.push(...(Array.isArray(bucket.fixtures) ? bucket.fixtures : Array.isArray(bucket.fixture) ? bucket.fixture : []));
  }
  return rows;
}

function flattenSchedule(payloads) {
  const seen = new Set();
  const games = [];
  for (const payload of payloads || []) {
    for (const fixture of scheduleFixtures(payload)) {
      const key = fixture && (fixture.slug || fixture.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      games.push(fixture);
    }
  }
  return games.sort((left, right) => Number(left.date || left.startTime || 0) - Number(right.date || right.startTime || 0));
}

async function requestJson(endpoint) {
  const response = await fetch(BASE_URL + endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'Sportbetting-PLUS/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`STAKE HTTP ${response.status} ${endpoint}`);
  return response.json();
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function saveAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(temp, file);
}

function fallbackKey(game) {
  return `NBA_${String(game.scheduledStart || '').slice(0, 16)}_${game.away}_${game.home}`.replace(/[^A-Za-z0-9_-]+/g, '_');
}

async function collectStakeNbaOdds(options = {}) {
  const request = options.request || requestJson;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const observedAt = new Date(now).toISOString();
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { matches: {} };
  const pregame = options.pregame && typeof options.pregame === 'object' ? options.pregame : { games: [] };
  const payloads = [];
  const health = {};
  for (const [season, endpoint] of Object.entries(SCHEDULES)) {
    try {
      const payload = await request(endpoint);
      payloads.push(payload);
      health[season] = { status: 'ok', discovered: scheduleFixtures(payload).length, failed: 0 };
    } catch (error) {
      health[season] = { status: 'error', discovered: 0, failed: 1, error: String(error && error.message || error) };
    }
  }
  const fixtures = flattenSchedule(payloads).filter((fixture) => {
    const start = Number(fixture && (fixture.date || fixture.startTime || 0));
    const status = String(fixture && fixture.status || '').toLowerCase();
    return fixture && fixture.preMatchEnabled !== false && status !== 'live' && status !== 'ended'
      && start > now - FLOOR_SLACK_MS && start <= now + 21 * 86400000;
  });
  const matches = { ...(previous.matches || {}) };
  const failures = [];
  let succeeded = 0;
  let shiftedStarts = 0;
  for (const fixture of fixtures) {
    try {
      const body = await request(`/odds/${encodeURIComponent(fixture.slug)}`);
      const detail = body && body.fixture ? body.fixture : body;
      const fixtureForNames = { ...fixture, ...(detail || {}), name: detail && detail.name || fixture.name };
      const markets = parseStakeMarkets(body && body.groups || detail && detail.groups, fixtureForNames);
      if (!markets.moneyline && !markets.handicapOdds && !markets.total) throw new Error('沒有可辨識的全場盤');
      const startTime = Number(fixtureForNames.date || fixtureForNames.startTime || fixture.date || 0);
      const normalized = {
        provider: 'stake-official',
        fixtureId: fixtureForNames.id || fixture.id || null,
        slug: fixtureForNames.slug || fixture.slug,
        scheduledStart: new Date(startTime).toISOString(),
        away: markets.away,
        home: markets.home,
        moneyline: markets.moneyline || null,
        favorite: markets.favorite || null,
        line: markets.line == null ? null : Number(markets.line),
        handicapOdds: markets.handicapOdds || null,
        total: markets.total || null,
        sourceUrl: `https://stake.com/sports/basketball/usa/${fixture.slug}`,
      };
      const card = matchPregameGame(normalized, pregame.games || []);
      const tempKey = fallbackKey(normalized);   // 臨時鍵沿用 Stake 原始時間（舊資料就是這樣存的）
      const cardStart = card ? pregameStartMs(card) : NaN;
      const realStart = Number.isFinite(cardStart) && Math.abs(cardStart - startTime) <= START_MATCH_MS ? cardStart : startTime;
      if (realStart <= now || String(detail && detail.status || '').toLowerCase() === 'live') continue;
      if (realStart !== startTime) {
        normalized.scheduledStart = new Date(realStart).toISOString();
        normalized.stakeDate = new Date(startTime).toISOString();
        shiftedStarts++;
      }
      normalized.officialId = card && card.officialId || tempKey;
      let old = matches[normalized.officialId] || null;
      // 之前配不上賽程時用臨時鍵存的同一場：歷史搬到正式編號下，臨時鍵刪掉（免得同一場兩筆）
      if (normalized.officialId !== tempKey && matches[tempKey] && matches[tempKey].slug === normalized.slug) {
        if (!old) old = matches[tempKey];
        delete matches[tempKey];
      }
      matches[normalized.officialId] = mergeStakeObservation(old, normalized, observedAt);
      succeeded++;
    } catch (error) {
      failures.push({ slug: fixture.slug, error: String(error && error.message || error).slice(0, 240) });
    }
  }
  const cutoff = now - 7 * 86400000;
  for (const [key, game] of Object.entries(matches)) {
    const start = Date.parse(game && game.scheduledStart || '');
    if (Number.isFinite(start) && start < cutoff) delete matches[key];
  }
  // 整點過後才發現已開賽而跳過的不算失敗；真的有抓失敗、又一場都沒成功才報錯
  if (failures.length && !succeeded && !Object.keys(previous.matches || {}).length) {
    throw new Error(`STAKE NBA 全部失敗：${failures[0] ? failures[0].error : '未知錯誤'}`);
  }
  return {
    schemaVersion: 1,
    provider: 'stake-official',
    updated: observedAt,
    health: { ...health, targeted: fixtures.length, shiftedStarts, succeeded, failures },
    matches,
  };
}

async function probe() {
  const rows = [];
  for (const [season, endpoint] of Object.entries(SCHEDULES)) {
    const payload = await requestJson(endpoint);
    rows.push({ season, endpoint, fixtures: scheduleFixtures(payload).map((fixture) => ({ name: fixture.name, slug: fixture.slug, date: fixture.date })) });
  }
  console.log(JSON.stringify(rows, null, 2));
}

async function main() {
  if (process.argv.includes('--probe')) return probe();
  const output = await collectStakeNbaOdds({
    previous: loadJson(OUT, { matches: {} }),
    pregame: loadJson(PREGAME, { games: [] }),
  });
  saveAtomic(OUT, output);
  console.log(`STAKE NBA：目標 ${output.health.targeted}、成功 ${output.health.succeeded}、失敗 ${output.health.failures.length}`);
}

module.exports = { SCHEDULES, flattenSchedule, collectStakeNbaOdds, requestJson, saveAtomic };

if (require.main === module) main().catch((error) => {
  console.error(`STAKE NBA 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
