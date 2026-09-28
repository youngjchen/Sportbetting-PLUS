/* ============================================================
   STAKE 官方 Odds Data API — NHL 賽前盤 shadow 收集器
   API: schedule/sport/ice-hockey/usa/tournament/nhl + odds/{slug}
   Secret: STAKE_ODDS_API_KEY（只放 X-API-KEY header，不落檔、不印出）
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeStakeMarkets, parseStakeFixtureName, mergeStakeGame } = require('./nhl_core.js');

const BASE_URL = 'https://odds-data.stake.com';
const SCHEDULE_PATH = '/schedule/sport/ice-hockey/usa/tournament/nhl';
const OUT = path.join('data', 'stake_api_odds.json');

function flattenSchedule(payload) {
  const seen = new Set();
  const out = [];
  for (const bucket of Array.isArray(payload && payload.schedule) ? payload.schedule : []) {
    const fixtures = Array.isArray(bucket.fixtures) ? bucket.fixtures : Array.isArray(bucket.fixture) ? bucket.fixture : [];
    for (const fixture of fixtures) {
      const key = fixture && (fixture.slug || fixture.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(fixture);
    }
  }
  return out.sort((a, b) => Number(a.date || a.startTime || 0) - Number(b.date || b.startTime || 0));
}

function selectFixtures(fixtures, now, fromHours, toHours, maxFixtures) {
  const lo = now + fromHours * 3600000;
  const hi = now + toHours * 3600000;
  return fixtures.filter(item => {
    const start = Number(item.date || item.startTime || 0);
    return item && item.preMatchEnabled !== false && item.status !== 'ended' && start >= lo && start <= hi;
  }).slice(0, maxFixtures);
}

async function requestJSON(endpoint, apiKey) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Sportbetting-PLUS/1.0' };
  if (apiKey) headers['X-API-KEY'] = apiKey;
  const response = await fetch(BASE_URL + endpoint, { headers, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`STAKE HTTP ${response.status} ${endpoint}`);
  return response.json();
}

function compactRawMarkets(groups) {
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const market of Array.isArray(group && group.markets) ? group.markets : []) {
      const name = String(market && market.name || '');
      if (!/(money\s*line|winner|handicap|puck line|spread|total|over\/?under)/i.test(name)) continue;
      out.push({
        group: String(group.name || ''), name, status: market.status || null,
        specifiers: market.specifiers || '', extendedSpecifiers: market.extendedSpecifiers || '',
        outcomes: Array.isArray(market.outcomes) ? market.outcomes.map(o => ({ name: o.name, odds: o.odds, active: o.active })) : []
      });
    }
  }
  return out;
}

async function collectStakeOdds(options) {
  const opts = options || {};
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('缺少 STAKE_ODDS_API_KEY；官方盤口端點不會回傳市場');
  const request = opts.request || requestJSON;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const observedAt = new Date(now).toISOString();
  const previous = opts.previous && typeof opts.previous === 'object' ? opts.previous : { games: {} };

  const schedule = await request(SCHEDULE_PATH, apiKey);
  const discovered = flattenSchedule(schedule);
  const targets = selectFixtures(
    discovered, now,
    Number(opts.fromHours == null ? -2 : opts.fromHours),
    Number(opts.toHours == null ? 96 : opts.toHours),
    Number(opts.maxFixtures == null ? 60 : opts.maxFixtures)
  );

  const games = { ...(previous.games || {}) };
  const failures = [];
  let succeeded = 0;
  for (const fixture of targets) {
    try {
      const body = await request(`/odds/${encodeURIComponent(fixture.slug)}`, apiKey);
      const detail = body && body.fixture ? body.fixture : body;
      const groups = detail && detail.groups;
      const markets = normalizeStakeMarkets(groups);
      if (!groups || !Object.keys(markets).length) throw new Error('回應沒有 groups 有效市場（通常是金鑰未授權）');
      const current = {
        fixtureId: detail.id || fixture.id || null,
        slug: detail.slug || fixture.slug,
        name: detail.name || fixture.name || '',
        teams: parseStakeFixtureName(detail.name || fixture.name),
        startTime: Number(detail.startTime || detail.date || fixture.date || fixture.startTime || 0),
        status: detail.status || fixture.status || null,
        ...markets,
        rawMarkets: compactRawMarkets(groups)
      };
      games[current.slug] = mergeStakeGame(games[current.slug], current, observedAt);
      succeeded++;
    } catch (error) {
      failures.push({ slug: fixture.slug, error: String(error && error.message || error).slice(0, 240) });
    }
  }

  if (!succeeded) {
    const why = failures[0] ? `：${failures[0].error}` : targets.length ? '' : '：目前時窗沒有 NHL 場次';
    throw new Error(`STAKE 沒有任何有效市場${why}`);
  }

  const cutoff = now - 3 * 86400000;
  for (const [key, game] of Object.entries(games)) {
    if (Number(game.startTime || 0) && Number(game.startTime) < cutoff) delete games[key];
  }
  return {
    provider: 'stake-official', mode: 'shadow', updated: observedAt,
    source: { schedule: SCHEDULE_PATH, odds: '/odds/{fixtureSlug}' },
    health: { discovered: discovered.length, targeted: targets.length, succeeded, failed: failures.length, failures },
    games
  };
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function saveAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1));
  fs.renameSync(temp, file);
}

async function probeSchedule() {
  const payload = await requestJSON(SCHEDULE_PATH, '');
  const fixtures = flattenSchedule(payload);
  console.log(JSON.stringify({ endpoint: SCHEDULE_PATH, count: fixtures.length, fixtures: fixtures.slice(0, 10).map(f => ({ slug: f.slug, name: f.name, date: f.date, status: f.status })) }, null, 2));
}

async function main() {
  if (process.argv.includes('--probe')) return probeSchedule();
  const previous = loadJSON(OUT, { games: {} });
  const output = await collectStakeOdds({
    apiKey: process.env.STAKE_ODDS_API_KEY,
    previous,
    fromHours: process.env.STAKE_FROM_HOURS,
    toHours: process.env.STAKE_TO_HOURS,
    maxFixtures: process.env.STAKE_MAX_FIXTURES
  });
  saveAtomic(OUT, output);
  console.log(`STAKE NHL shadow：目標 ${output.health.targeted}、成功 ${output.health.succeeded}、失敗 ${output.health.failed}`);
}

module.exports = { flattenSchedule, selectFixtures, collectStakeOdds, requestJSON };

if (require.main === module) main().catch(error => {
  console.error(`STAKE NHL 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
