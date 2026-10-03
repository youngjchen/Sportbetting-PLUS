'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');
const {
  normalizeLeague,
  normalizeTeam,
  buildOfficialGames,
  matchOfficialGame,
  normalizeBaseballMarkets,
  buildBaseballFeed,
} = require('./baseball_stake_core.js');

const BASE_URL = 'https://odds-data.stake.com';
const STAKE_URL = 'https://stake.com';
const OUT = path.join('data', 'baseball_stake_odds.json');

const LEAGUES = {
  MLB: {
    schedule: '/schedule/sport/baseball/usa/tournament/mlb',
    page: '/sports/baseball/usa/mlb/',
  },
  NPB: {
    schedule: '/schedule/sport/baseball/japan/tournament/npb',
    page: '/sports/baseball/japan/npb/',
  },
  KBO: {
    schedule: '/schedule/sport/baseball/republic-of-korea/tournament/kbo-league',
    page: '/sports/baseball/republic-of-korea/kbo-league/',
  },
  CPBL: {
    schedule: '/schedule/sport/baseball/chinese-taipei/tournament/cpbl',
    page: '/sports/baseball/chinese-taipei/cpbl/',
  },
};

function flattenSchedule(payload) {
  const seen = new Set();
  const fixtures = [];
  for (const bucket of Array.isArray(payload && payload.schedule) ? payload.schedule : []) {
    const rows = Array.isArray(bucket && bucket.fixtures)
      ? bucket.fixtures
      : Array.isArray(bucket && bucket.fixture) ? bucket.fixture : [];
    for (const fixture of rows) {
      const key = fixture && (fixture.slug || fixture.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fixtures.push(fixture);
    }
  }
  return fixtures.sort((a, b) => Number(a.startTime || a.date || 0) - Number(b.startTime || b.date || 0));
}

function flattenMarkets(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenMarkets(item, output);
  } else if (value && typeof value === 'object' && value.name && Array.isArray(value.outcomes)) {
    output.push(value);
  }
  return output;
}

function fixtureSides(fixture) {
  const parts = String(fixture && fixture.name || '').split(/\s+-\s+/).map((part) => normalizeTeam(part)).filter(Boolean);
  if (parts.length !== 2) throw new Error(`Stake 棒球賽事名稱無法辨識：${fixture && fixture.name || ''}`);
  return { home: parts[0], away: parts[1] };
}

function numberFrom(value) {
  const match = String(value || '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function taggedLine(market, key) {
  const text = `${market && market.specifiers || ''}|${market && market.extendedSpecifiers || ''}`;
  const match = new RegExp(`(?:${key}|line)=([+-]?\\d+(?:\\.\\d+)?)`, 'i').exec(text);
  return match ? Math.abs(Number(match[1])) : null;
}

function validOdds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 1 ? number : null;
}

function outcomeSide(name, teams) {
  const cleaned = String(name || '').replace(/\s*\([+-]?\d+(?:\.\d+)?\)\s*$/, '').trim();
  const team = normalizeTeam(cleaned);
  return team === teams.away ? 'away' : team === teams.home ? 'home' : null;
}

function teamOdds(market, teams) {
  const output = {};
  for (const outcome of Array.isArray(market && market.outcomes) ? market.outcomes : []) {
    if (!outcome || outcome.active === false) continue;
    const side = outcomeSide(outcome.name, teams);
    const odds = validOdds(outcome.odds);
    if (side && odds != null) output[side] = odds;
  }
  return output.away && output.home ? output : null;
}

function handicapCandidate(market, teams) {
  const odds = teamOdds(market, teams);
  if (!market || !odds) return null;
  const signed = {};
  for (const outcome of market.outcomes || []) {
    const side = outcomeSide(outcome && outcome.name, teams);
    const lineMatch = String(outcome && outcome.name || '').match(/\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
    if (side && lineMatch) signed[side] = Number(lineMatch[1]);
  }
  const favorite = signed.away < 0 ? 'away' : signed.home < 0 ? 'home' : null;
  const line = Math.abs(signed.away || signed.home || taggedLine(market, 'hcp'));
  return favorite && Number.isFinite(line) && line > 0 ? { favorite, line, ...odds } : null;
}

function balancedHandicap(candidates) {
  // Stake returns every alternate run line in an unstable order; its displayed main line is the closest-priced pair.
  return candidates.filter(Boolean).sort((a, b) =>
    Math.abs(a.away - a.home) - Math.abs(b.away - b.home)
  )[0] || null;
}

function parseStakeApiMarkets(groups, fixture) {
  const teams = fixtureSides(fixture);
  const markets = [];
  for (const group of Array.isArray(groups) ? groups : []) flattenMarkets(group && group.markets, markets);
  const active = markets.filter((market) => !market.status || market.status === 'active');
  const wholeGame = active.filter((market) => !/(?:innings?\s+1\s+to\s+5|\d+(?:st|nd|rd|th) inning|team total|player)/i.test(String(market.name || '')));
  const winner = wholeGame.find((market) => /^Winner\s*\(Incl\. Extra Innings\)$/i.test(String(market.name || '')))
    || wholeGame.find((market) => /^(?:Money Line|Match Winner)$/i.test(String(market.name || '')));
  let handicapMarkets = wholeGame.filter((market) => /^Handicap\s*\(Incl\. Extra Innings\)$/i.test(String(market.name || '')));
  if (!handicapMarkets.length) handicapMarkets = wholeGame.filter((market) => /^(?:Run Line|Spread)$/i.test(String(market.name || '')));
  const totalMarkets = wholeGame.filter((market) => /^Total\s*\(Incl\. Extra Innings\)$/i.test(String(market.name || '')));
  if (!totalMarkets.length) totalMarkets.push(...wholeGame.filter((market) => /^Total$/i.test(String(market.name || ''))));
  const output = {};

  const ml = teamOdds(winner, teams);
  if (ml) output.ml = ml;

  const hd = balancedHandicap(handicapMarkets.map((market) => handicapCandidate(market, teams)));
  if (hd) output.hd = hd;

  const totalCandidates = totalMarkets.map((market) => {
    let over = null;
    let under = null;
    let line = taggedLine(market, 'total');
    for (const outcome of market.outcomes || []) {
      if (!outcome || outcome.active === false) continue;
      if (/^over\b/i.test(outcome.name || '')) over = validOdds(outcome.odds);
      if (/^under\b/i.test(outcome.name || '')) under = validOdds(outcome.odds);
      if (line == null) line = Math.abs(numberFrom(outcome.name));
    }
    return line != null && over != null && under != null ? { line, over, under } : null;
  }).filter(Boolean).sort((a, b) => Math.abs(a.over - a.under) - Math.abs(b.over - b.under));
  if (totalCandidates.length) output.total = totalCandidates[0];
  return output;
}

function fixtureNameFromWinner(groups) {
  const markets = [];
  for (const group of Array.isArray(groups) ? groups : []) flattenMarkets(group && group.markets, markets);
  const winner = markets.find((market) => (!market.status || market.status === 'active') &&
    /^Winner\s*\(Incl\. Extra Innings\)$/i.test(String(market.name || '')));
  const names = (winner && winner.outcomes || []).filter((outcome) => outcome && outcome.active !== false)
    .map((outcome) => String(outcome.name || '').replace(/\s*\([+-]?\d+(?:\.\d+)?\)\s*$/, '').trim())
    .filter(Boolean);
  return names.length === 2 ? `${names[0]} - ${names[1]}` : '';
}

function accordion($, title) {
  return $('.secondary-accordion').filter((_, element) =>
    $(element).children('.header').first().text().replace(/\s+/g, ' ').trim().includes(title)
  ).first();
}

function pageButtons($, section) {
  return section.find('button[data-testid="fixture-outcome"]').toArray().map((button) => {
    const item = $(button);
    return {
      name: item.find('[data-testid="outcome-button-name"]').first().text().trim(),
      aria: String(item.attr('aria-label') || ''),
      odds: validOdds(item.find('[data-testid="fixture-odds"]').first().text().trim()),
    };
  });
}

function parseStakeBaseballPage(html, fixture) {
  const teams = fixtureSides(fixture);
  const $ = cheerio.load(String(html || ''));
  const output = {};

  const winner = pageButtons($, accordion($, 'Winner (Incl. Extra Innings)'));
  const ml = {};
  for (const item of winner) {
    const side = outcomeSide(item.name, teams) || outcomeSide(item.aria, teams);
    if (side && item.odds != null) ml[side] = item.odds;
  }
  if (ml.away && ml.home) output.ml = ml;

  const handicap = pageButtons($, accordion($, 'Handicap (Incl. Extra Innings)'));
  const handicapCandidates = [];
  for (let index = 0; index + 1 < handicap.length; index += 2) {
    const hd = {};
    const signed = {};
    for (const item of handicap.slice(index, index + 2)) {
      const text = `${item.name} ${item.aria}`;
      const side = outcomeSide(item.name, teams) || outcomeSide(item.aria, teams);
      const matches = Array.from(text.matchAll(/\(([+-]?\d+(?:\.\d+)?)\)/g));
      const line = matches.length ? Number(matches[0][1]) : null;
      if (side && item.odds != null && line != null) {
        hd[side] = item.odds;
        signed[side] = line;
      }
    }
    const favorite = signed.away < 0 ? 'away' : signed.home < 0 ? 'home' : null;
    const hdLine = Math.abs(signed.away || signed.home || 0);
    if (favorite && hdLine && hd.away && hd.home) handicapCandidates.push({ favorite, line: hdLine, ...hd });
  }
  const pageHandicap = balancedHandicap(handicapCandidates);
  if (pageHandicap) output.hd = pageHandicap;

  const totals = pageButtons($, accordion($, 'Total (Incl. Extra Innings)'));
  const totalCandidates = [];
  for (let index = 0; index + 1 < totals.length; index += 2) {
    let over = null;
    let under = null;
    let totalLine = null;
    for (const item of totals.slice(index, index + 2)) {
      const text = `${item.name} ${item.aria}`;
      if (/\bover\b/i.test(text)) over = item.odds;
      if (/\bunder\b/i.test(text)) under = item.odds;
      if (totalLine == null) totalLine = Math.abs(numberFrom(text));
    }
    if (totalLine != null && over != null && under != null) totalCandidates.push({ line: totalLine, over, under });
  }
  totalCandidates.sort((a, b) => Math.abs(a.over - a.under) - Math.abs(b.over - b.under));
  if (totalCandidates.length) output.total = totalCandidates[0];
  if (!output.ml && !output.hd && !output.total) throw new Error('Stake 官方棒球賽事頁沒有可辨識的全場盤');
  return output;
}

async function requestJSON(endpoint, apiKey) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Sportbetting-PLUS/1.0' };
  if (apiKey) headers['X-API-KEY'] = apiKey;
  const response = await fetch(BASE_URL + endpoint, { headers, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`Stake HTTP ${response.status} ${endpoint}`);
  return response.json();
}

async function fetchOfficialPage(config, fixture) {
  return sidecar.fetchText(`${STAKE_URL}${config.page}${encodeURI(fixture.slug)}`, {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  }, 90000);
}

function betExplorerGame(feed, official) {
  if (!feed || String(feed.bookmaker || '') !== 'Stake.com' || !feed.games) return null;
  const wantedStart = Date.parse(official.scheduledStart);
  let best = null;
  let bestDiff = Infinity;
  for (const game of Object.values(feed.games)) {
    if (!game || normalizeLeague(game.league) !== official.league) continue;
    if (normalizeTeam(game.awayTeam) !== official.away || normalizeTeam(game.homeTeam) !== official.home) continue;
    const start = Date.parse(game.startISO || `${game.date}T${game.startTime}:00+08:00`);
    const diff = Math.abs(start - wantedStart);
    if (Number.isFinite(diff) && diff < bestDiff && diff <= 2 * 3600000) {
      best = game;
      bestDiff = diff;
    }
  }
  return best ? { ...best, bookmaker: 'Stake.com' } : null;
}

async function collectLeague(config, context) {
  const payload = await context.request(config.schedule, context.apiKey);
  const discovered = flattenSchedule(payload);
  const observations = [];
  const failures = [];
  let unmatched = 0;
  let attempted = 0;
  for (const fixture of discovered) {
    if (!fixture || fixture.preMatchEnabled === false || String(fixture.status || '').toLowerCase() === 'ended') continue;
    const startTime = Number(fixture.startTime || fixture.date || 0);
    if (!Number.isFinite(startTime) || startTime <= context.now) continue;
    attempted++;
    try {
      const body = await context.request(`/odds/${encodeURIComponent(fixture.slug)}`, context.apiKey);
      const detail = body && body.fixture ? { ...fixture, ...body.fixture } : fixture;
      let resolvedDetail = detail;
      let official = matchOfficialGame({ ...resolvedDetail, league: context.league, startTime }, context.officialGames);
      if (!official) {
        const marketName = fixtureNameFromWinner(body && body.groups);
        if (marketName) {
          resolvedDetail = { ...detail, name: marketName };
          official = matchOfficialGame({ ...resolvedDetail, league: context.league, startTime }, context.officialGames);
        }
      }
      if (!official) {
        unmatched++;
        continue;
      }
      let markets = parseStakeApiMarkets(body && body.groups, resolvedDetail);
      if (!markets.ml || !markets.hd || !markets.total) {
        try {
          const html = await context.fetchPage(config, fixture);
          const pageMarkets = parseStakeBaseballPage(html, resolvedDetail);
          markets = { ...pageMarkets, ...markets };
        } catch (pageError) {
          if (!Object.keys(markets).length) throw pageError;
        }
      }
      const fallback = betExplorerGame(context.betExplorer, official);
      const normalized = normalizeBaseballMarkets(context.league, markets, fallback);
      const observedAt = new Date(context.clock()).toISOString();
      observations.push({
        league: context.league,
        officialId: official.officialId,
        scheduledStart: official.scheduledStart,
        away: official.away,
        home: official.home,
        fixtureId: resolvedDetail.id || fixture.id || null,
        slug: resolvedDetail.slug || fixture.slug,
        sourceUrl: `${STAKE_URL}${config.page}${encodeURI(fixture.slug)}`,
        ...normalized,
        observedAt,
      });
    } catch (error) {
      failures.push({ slug: fixture.slug, error: String(error && error.message || error).slice(0, 240) });
    }
  }
  if (failures.length && !observations.length && failures.length === attempted) {
    throw new Error(failures[0].error);
  }
  return { observations, health: { discovered: discovered.length, matched: observations.length, unmatched, failed: failures.length, failures } };
}

async function collectBaseballStakeOdds(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const request = options.request || requestJSON;
  const fetchPage = options.fetchPage || fetchOfficialPage;
  const officialRows = Array.isArray(options.officialRows) ? options.officialRows : [];
  const officialGames = buildOfficialGames(officialRows);
  const wanted = Array.isArray(options.leagues) && options.leagues.length
    ? options.leagues.map(normalizeLeague).filter(Boolean)
    : Object.keys(LEAGUES);
  const leagueResults = {};
  let succeededLeagues = 0;
  for (const league of wanted) {
    try {
      const result = await collectLeague(LEAGUES[league], {
        league, now, clock, request, fetchPage, officialGames,
        apiKey: options.apiKey || '', betExplorer: options.betExplorer || null,
      });
      leagueResults[league] = { observations: result.observations, error: null, health: result.health };
      succeededLeagues++;
    } catch (error) {
      leagueResults[league] = { observations: [], error: String(error && error.message || error) };
    }
  }
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : null;
  if (!succeededLeagues && !(previous && previous.matches && Object.keys(previous.matches).length)) {
    throw new Error('Stake 棒球四聯盟沒有任何有效聯盟資料');
  }
  const observedAt = new Date(clock()).toISOString();
  const feed = buildBaseballFeed(previous, officialRows, leagueResults, observedAt);
  for (const league of wanted) {
    if (feed.leagues[league] && leagueResults[league] && leagueResults[league].health) {
      feed.leagues[league].health = leagueResults[league].health;
    }
  }
  feed.provider = 'stake-official';
  return feed;
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function saveAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

async function probe() {
  const result = {};
  for (const [league, config] of Object.entries(LEAGUES)) {
    try {
      const payload = await requestJSON(config.schedule, process.env.STAKE_ODDS_API_KEY || '');
      const fixtures = flattenSchedule(payload);
      result[league] = {
        discovered: fixtures.length,
        fixtures: fixtures.slice(0, 8).map((item) => ({ name: item.name, slug: item.slug, startTime: item.startTime || item.date })),
      };
    } catch (error) {
      result[league] = { error: String(error && error.message || error) };
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  try {
    if (process.argv.includes('--probe')) return probe();
    const previous = loadJSON(OUT, { schemaVersion: 1, leagues: {}, matches: {} });
    const officialRows = loadJSON(path.join('data', 'pregame_data.json'), []);
    const betExplorer = loadJSON(path.join('data', 'oddsportal_summary.json'), null);
    const output = await collectBaseballStakeOdds({
      previous,
      officialRows,
      betExplorer,
      apiKey: process.env.STAKE_ODDS_API_KEY || '',
    });
    saveAtomic(OUT, output);
    const statuses = Object.entries(output.leagues || {}).map(([league, health]) => `${league}:${health.status}`).join(' ');
    console.log(`Stake 棒球官方盤：${Object.keys(output.matches || {}).length} 場；${statuses}`);
  } finally {
    await sidecar.shutdown();
  }
}

module.exports = {
  LEAGUES,
  flattenSchedule,
  parseStakeApiMarkets,
  parseStakeBaseballPage,
  collectLeague,
  collectBaseballStakeOdds,
  requestJSON,
  saveAtomic,
};

if (require.main === module) main().catch((error) => {
  console.error(`Stake 棒球收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
