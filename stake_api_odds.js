/* ============================================================
   STAKE 官方 NHL 賽前盤收集器
   賽程：官方 Odds Data API
   盤口：有 STAKE_ODDS_API_KEY 時優先官方 API，否則讀 Stake 官方賽事頁
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');
const { normalizeStakeMarkets, parseStakeFixtureName, mergeStakeGame } = require('./nhl_core.js');
const { translateTeam } = require('./nhl_bet365_core.js');

const BASE_URL = 'https://odds-data.stake.com';
const PUBLIC_EVENT_BASE = 'https://stake.com/sports/ice-hockey/usa/nhl/';
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
  const lo = Math.max(now + fromHours * 3600000, now + 1);
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

function marketAccordion($, title) {
  return $('.secondary-accordion').filter((_, element) => {
    const header = $(element).children('.header').first().text().replace(/\s+/g, ' ').trim();
    return header.includes(title);
  }).first();
}

function buttonValue($, button) {
  const element = $(button);
  const name = element.find('[data-testid="outcome-button-name"]').first().text().trim();
  const odds = Number(element.find('[data-testid="fixture-odds"]').first().text().trim());
  return {
    aria: String(element.attr('aria-label') || '').trim(),
    name,
    odds,
  };
}

function lineNumber(value) {
  const match = String(value || '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function validOdds(value) {
  return Number.isFinite(Number(value)) && Number(value) > 1;
}

function stakeHomeAway(name) {
  const teams = parseStakeFixtureName(name);
  if (teams.length !== 2) throw new Error(`STAKE 官方賽事名稱無法辨識：${name || ''}`);
  // Stake/Betradar 的 fixture title 固定為「主隊 - 客隊」。
  return { home: teams[0], away: teams[1] };
}

function normalizedTeamName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function orientTeamMarket(market, away, home) {
  if (!market || !Array.isArray(market.outcomes)) return market || null;
  const awayKey = normalizedTeamName(away);
  const homeKey = normalizedTeamName(home);
  const oriented = market.outcomes.map((outcome) => {
    const nameKey = normalizedTeamName(outcome && outcome.name);
    const side = nameKey === awayKey ? 'away' : nameKey === homeKey ? 'home' : outcome && outcome.side;
    return { ...outcome, ...(side ? { side } : {}) };
  });
  const awayOutcome = oriented.find((outcome) => outcome.side === 'away');
  const homeOutcome = oriented.find((outcome) => outcome.side === 'home');
  const outcomes = awayOutcome && homeOutcome ? [awayOutcome, homeOutcome] : oriented;
  const negative = outcomes.find((outcome) => Number(outcome && outcome.line) < 0);
  return {
    ...market,
    ...(negative && (negative.side === 'away' || negative.side === 'home') ? { favSide: negative.side } : {}),
    outcomes,
  };
}

function orientMarkets(markets, fixtureName) {
  const { away, home } = stakeHomeAway(fixtureName);
  const result = { ...(markets || {}) };
  for (const kind of ['ml', 'hd']) {
    if (result[kind]) result[kind] = orientTeamMarket(result[kind], away, home);
  }
  return result;
}

function repairStoredOrientation(previous, fixtureName) {
  if (!previous || typeof previous !== 'object') return previous;
  const { away, home } = stakeHomeAway(fixtureName);
  const repairSnapshot = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return {
      ...snapshot,
      ...(snapshot.ml ? { ml: orientTeamMarket(snapshot.ml, away, home) } : {}),
      ...(snapshot.hd ? { hd: orientTeamMarket(snapshot.hd, away, home) } : {}),
    };
  };
  return {
    ...repairSnapshot(previous),
    teams: [away, home],
    awayName: away,
    homeName: home,
    awayTeam: translateTeam(away),
    homeTeam: translateTeam(home),
    history: Array.isArray(previous.history) ? previous.history.map(repairSnapshot) : [],
  };
}

function balancedPair(pairs) {
  const valid = pairs.filter((pair) => validOdds(pair.first.odds) && validOdds(pair.second.odds));
  valid.sort((left, right) => Math.abs(left.first.odds - left.second.odds) - Math.abs(right.first.odds - right.second.odds));
  return valid[0] || null;
}

function pairedButtons($, accordion) {
  const buttons = accordion.find('button[data-testid="fixture-outcome"]').toArray().map((button) => buttonValue($, button));
  const pairs = [];
  for (let index = 0; index + 1 < buttons.length; index += 2) {
    pairs.push({ first: buttons[index], second: buttons[index + 1] });
  }
  return pairs;
}

function parseStakeOfficialPage(html, fixture) {
  const { away, home } = stakeHomeAway(fixture && fixture.name);
  const $ = cheerio.load(String(html || ''));
  const result = {};

  const winner = marketAccordion($, 'Winner (Incl. Overtime and Penalties)');
  const winnerButtons = winner.find('button[data-testid="fixture-outcome"]').toArray().map((button) => buttonValue($, button));
  if (winnerButtons.length >= 2 && validOdds(winnerButtons[0].odds) && validOdds(winnerButtons[1].odds)) {
    result.ml = {
      market: 'Winner (Incl. Overtime and Penalties)',
      outcomes: [
        { name: away, side: 'away', odds: winnerButtons[1].odds },
        { name: home, side: 'home', odds: winnerButtons[0].odds },
      ],
    };
  }

  const totalPair = balancedPair(pairedButtons($, marketAccordion($, 'Total (Incl. Overtime and Penalties)'))
    .filter((pair) => {
      const firstLine = lineNumber(`${pair.first.name} ${pair.first.aria}`);
      const secondLine = lineNumber(`${pair.second.name} ${pair.second.aria}`);
      return Number.isFinite(firstLine) && Number.isFinite(secondLine)
        && Math.abs(firstLine) === Math.abs(secondLine);
    }));
  if (totalPair) {
    const line = Math.abs(lineNumber(`${totalPair.first.name} ${totalPair.first.aria}`));
    result.tot = {
      market: 'Total (Incl. Overtime and Penalties)',
      line,
      outcomes: [
        { name: 'Over', side: 'over', line, odds: totalPair.first.odds },
        { name: 'Under', side: 'under', line, odds: totalPair.second.odds },
      ],
    };
  }

  const handicapPair = balancedPair(pairedButtons($, marketAccordion($, 'Handicap (Incl. Overtime and Penalties)'))
    .map((pair) => ({
      first: { ...pair.first, line: lineNumber(`${pair.first.name} ${pair.first.aria}`) },
      second: { ...pair.second, line: lineNumber(`${pair.second.name} ${pair.second.aria}`) },
    }))
    .filter((pair) => Number.isFinite(pair.first.line) && Number.isFinite(pair.second.line)
      && pair.first.line !== 0 && pair.second.line !== 0
      && Math.sign(pair.first.line) !== Math.sign(pair.second.line)
      && Math.abs(pair.first.line) === Math.abs(pair.second.line)));
  if (handicapPair) {
    const line = Math.abs(handicapPair.first.line);
    const favSide = handicapPair.first.line < 0 ? 'home' : 'away';
    result.hd = {
      market: 'Handicap (Incl. Overtime and Penalties)',
      line,
      favSide,
      outcomes: [
        { name: away, side: 'away', line: handicapPair.second.line, odds: handicapPair.second.odds },
        { name: home, side: 'home', line: handicapPair.first.line, odds: handicapPair.first.odds },
      ],
    };
  }

  if (!result.ml && !result.hd && !result.tot) {
    throw new Error('STAKE 官方賽事頁沒有可辨識的全場賽前盤');
  }
  return result;
}

async function fetchOfficialPage(fixture) {
  return sidecar.fetchText(`${PUBLIC_EVENT_BASE}${encodeURI(fixture.slug)}`, {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  }, 90000);
}

function outcomeBySide(market, side, fallbackIndex) {
  const outcomes = Array.isArray(market && market.outcomes) ? market.outcomes : [];
  return outcomes.find((outcome) => outcome && outcome.side === side) || outcomes[fallbackIndex] || null;
}

function uiSnapshot(market, kind, at) {
  if (!market) return null;
  if (kind === 'ml') {
    const away = outcomeBySide(market, 'away', 0);
    const home = outcomeBySide(market, 'home', 1);
    if (!away || !home || !validOdds(away.odds) || !validOdds(home.odds)) return null;
    return { at, away: Number(away.odds), home: Number(home.odds) };
  }
  if (kind === 'hd') {
    const away = outcomeBySide(market, 'away', 0);
    const home = outcomeBySide(market, 'home', 1);
    const line = Math.abs(Number(market.line));
    if (!away || !home || !validOdds(away.odds) || !validOdds(home.odds) || !Number.isFinite(line)) return null;
    const favorite = market.favSide === 'away' || market.favSide === 'home'
      ? market.favSide
      : (Number(away.line) < 0 ? 'away' : Number(home.line) < 0 ? 'home' : null);
    if (!favorite) return null;
    return { at, line, favorite, away: Number(away.odds), home: Number(home.odds) };
  }
  const over = outcomeBySide(market, 'over', 0);
  const under = outcomeBySide(market, 'under', 1);
  const line = Math.abs(Number(market.line));
  if (!over || !under || !validOdds(over.odds) || !validOdds(under.odds) || !Number.isFinite(line)) return null;
  return { at, line, over: Number(over.odds), under: Number(under.odds) };
}

function withUiMarkets(game, observedAt, sourceMode) {
  const history = Array.isArray(game.history) ? game.history : [];
  const oldest = history[history.length - 1] || { at: observedAt, ml: game.ml, hd: game.hd, tot: game.tot };
  const markets = {};
  for (const [kind, field] of [['ml', 'ml'], ['hd', 'hd'], ['ou', 'tot']]) {
    const active = uiSnapshot(game[field], kind, observedAt);
    const open = uiSnapshot(oldest[field], kind, oldest.at || observedAt);
    if (active || open) markets[kind] = { ...(open ? { open } : {}), ...(active ? { active } : {}) };
  }
  const { away: awayName, home: homeName } = stakeHomeAway(game.name);
  const startTime = Number(game.startTime);
  return {
    ...game,
    league: 'nhl',
    date: new Date(startTime + 8 * 3600000).toISOString().slice(0, 10),
    startISO: new Date(startTime).toISOString(),
    awayName,
    homeName,
    awayTeam: translateTeam(awayName),
    homeTeam: translateTeam(homeName),
    sourceMode,
    sourceUrl: `${PUBLIC_EVENT_BASE}${encodeURI(game.slug)}`,
    lastPregameAt: observedAt,
    markets,
  };
}

async function collectStakeOdds(options) {
  const opts = options || {};
  const apiKey = String(opts.apiKey || '').trim();
  const request = opts.request || requestJSON;
  const fetchPage = opts.fetchPage || fetchOfficialPage;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const observedAt = new Date(now).toISOString();
  const previous = opts.previous && typeof opts.previous === 'object' ? opts.previous : { games: {} };

  const schedule = await request(SCHEDULE_PATH, apiKey);
  const discovered = flattenSchedule(schedule);
  const targets = selectFixtures(
    discovered, now,
    Number(opts.fromHours == null ? 0 : opts.fromHours),
    Number(opts.toHours == null ? 96 : opts.toHours),
    Number(opts.maxFixtures == null ? 60 : opts.maxFixtures)
  );

  const games = { ...(previous.games || {}) };
  const failures = [];
  let succeeded = 0;
  let apiSucceeded = 0;
  let pageSucceeded = 0;
  for (const fixture of targets) {
    try {
      const startTime = Number(fixture.date || fixture.startTime || 0);
      if (!(startTime > now)) continue;
      let detail = fixture;
      let markets = null;
      let rawMarkets = [];
      let sourceMode = 'official-page';
      if (apiKey) {
        try {
          const body = await request(`/odds/${encodeURIComponent(fixture.slug)}`, apiKey);
          detail = body && body.fixture ? body.fixture : body;
          const groups = detail && detail.groups;
          const normalized = orientMarkets(normalizeStakeMarkets(groups), detail.name || fixture.name);
          if (groups && Object.keys(normalized).length) {
            markets = normalized;
            rawMarkets = compactRawMarkets(groups);
            sourceMode = 'official-api';
            apiSucceeded++;
          }
        } catch (_) {
          markets = null;
        }
      }
      const missingUiMarket = ['ml', 'hd', 'tot'].some((kind) => {
        const uiKind = kind === 'tot' ? 'ou' : kind;
        return !uiSnapshot(markets && markets[kind], uiKind, observedAt);
      });
      if (missingUiMarket) {
        const html = await fetchPage(fixture);
        const pageMarkets = parseStakeOfficialPage(html, fixture);
        const combined = { ...(markets || {}) };
        for (const kind of ['ml', 'hd', 'tot']) {
          const uiKind = kind === 'tot' ? 'ou' : kind;
          if (!uiSnapshot(combined[kind], uiKind, observedAt) && pageMarkets[kind]) {
            combined[kind] = pageMarkets[kind];
          }
        }
        markets = combined;
        sourceMode = sourceMode === 'official-api' ? 'hybrid' : 'official-page';
        pageSucceeded++;
      }
      const fixtureName = detail.name || fixture.name || '';
      const fixtureTeams = stakeHomeAway(fixtureName);
      const current = {
        fixtureId: detail.id || fixture.id || null,
        slug: detail.slug || fixture.slug,
        name: fixtureName,
        teams: [fixtureTeams.away, fixtureTeams.home],
        startTime,
        status: detail.status || fixture.status || null,
        ...markets,
        rawMarkets,
      };
      if (!(current.startTime > now)) continue;
      const previousGame = repairStoredOrientation(games[current.slug], current.name);
      const merged = mergeStakeGame(previousGame, current, observedAt);
      games[current.slug] = withUiMarkets(merged, observedAt, sourceMode);
      succeeded++;
    } catch (error) {
      failures.push({ slug: fixture.slug, error: String(error && error.message || error).slice(0, 240) });
    }
  }

  if (!succeeded && targets.length) {
    const why = failures[0] ? `：${failures[0].error}` : targets.length ? '' : '：目前時窗沒有 NHL 場次';
    throw new Error(`STAKE 沒有任何有效市場${why}`);
  }

  const cutoff = now - 3 * 86400000;
  for (const [key, game] of Object.entries(games)) {
    if (Number(game.startTime || 0) && Number(game.startTime) < cutoff) delete games[key];
  }
  return {
    provider: 'stake-official',
    mode: apiSucceeded && pageSucceeded ? 'hybrid' : apiSucceeded ? 'official-api' : 'official-page',
    updated: observedAt,
    source: { schedule: SCHEDULE_PATH, odds: '/odds/{fixtureSlug}', page: `${PUBLIC_EVENT_BASE}{fixtureSlug}` },
    health: { discovered: discovered.length, targeted: targets.length, succeeded, apiSucceeded, pageSucceeded, failed: failures.length, failures },
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
  try {
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
    console.log(`STAKE NHL 官方盤：模式 ${output.mode}、目標 ${output.health.targeted}、成功 ${output.health.succeeded}、失敗 ${output.health.failed}`);
  } finally {
    await sidecar.shutdown();
  }
}

module.exports = {
  flattenSchedule,
  selectFixtures,
  parseStakeOfficialPage,
  collectStakeOdds,
  requestJSON,
  saveAtomic,
};

if (require.main === module) main().catch(error => {
  console.error(`STAKE NHL 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
