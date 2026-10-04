'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');
const { fetchBet365Page } = require('./bet365_official_transport.js');
const {
  normalizeMarketObservation,
  mergeProviderObservation,
  resolveGameSources,
  isPregameObservation,
} = require('./bet365_official_core.js');
const { buildOfficialGames, normalizeTeam } = require('./baseball_stake_core.js');

const OUT = path.join(__dirname, 'data', 'baseball_bet365_odds.json');
const PREGAME = path.join(__dirname, 'data', 'pregame_data.json');
const BETEXPLORER = path.join(__dirname, 'data', 'oddsportal_summary.json');
const MLB_HUB_URL = 'https://www.bet365.com/hub/en-us/baseball/mlb';
const SPORTSBOOK_URL = 'https://www.bet365.com/#/AS/B16/';
const MATCH_TOLERANCE_MS = 2 * 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const SHORT_TEAM_ALIASES = Object.freeze({
  // MLB hub abbreviations.
  'ARI Diamondbacks': '響尾蛇', 'PIT Pirates': '海盜', 'BAL Orioles': '金鶯',
  'DET Tigers': '老虎', 'PHI Phillies': '費城人', 'MIA Marlins': '馬林魚',
  'TEX Rangers': '遊騎兵', 'TB Rays': '光芒', 'TOR Blue Jays': '藍鳥',
  'WAS Nationals': '國民', 'ATL Braves': '勇士', 'NY Mets': '大都會',
  'CLE Guardians': '守護者', 'CIN Reds': '紅人', 'KC Royals': '皇家',
  'MIN Twins': '雙城', 'NY Yankees': '洋基', 'CHI White Sox': '白襪',
  'CHI Cubs': '小熊', 'STL Cardinals': '紅雀', 'HOU Astros': '太空人',
  'LA Angels': '天使', 'BOS Red Sox': '紅襪', Athletics: '運動家',
  'COL Rockies': '落磯', 'SD Padres': '教士', 'MIL Brewers': '釀酒人',
  'SF Giants': '巨人', 'SEA Mariners': '水手', 'LA Dodgers': '道奇',
  // Asian aliases seen across Bet365 and the board.
  'Yokohama DeNA BayStars': '橫濱', 'Hanwha Eagles': '華老鷹',
  'CTBC Brothers': '兄弟', 'Chinatrust Brothers': '兄弟',
  'Wei Chuan Dragons': '味全', 'Fubon Guardians': '富邦',
  'Rakuten Monkeys': '樂天', 'Uni Lions': '統一', 'Uni-President Lions': '統一',
  'TSG Hawks': '台鋼', 'Tainan TSG GhostHawks': '台鋼',
});

function leagueCode(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('MLB')) return 'MLB';
  if (text.includes('NPB') || text.includes('JAPAN')) return 'NPB';
  if (text.includes('KBO') || text.includes('KOREA')) return 'KBO';
  if (text.includes('CPBL') || text.includes('CHINESE PROFESSIONAL') || text.includes('TAIWAN')) return 'CPBL';
  return '';
}

function translateBaseballTeam(league, name) {
  const raw = String(name || '').trim();
  return SHORT_TEAM_ALIASES[raw] || normalizeTeam(raw) || raw;
}

function firstNumber(value) {
  const match = String(value || '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function marketLinks($, element) {
  const outcomes = {};
  $(element).find('[data-item-variant]').each((_, link) => {
    const variant = String($(link).attr('data-item-variant') || '').trim();
    const odds = Number($(link).attr('data-item-odds'));
    if (!variant || !Number.isFinite(odds) || outcomes[variant]) return;
    outcomes[variant] = { odds, line: firstNumber($(link).text()) };
  });
  return outcomes;
}

function validPair(outcomes, left, right) {
  return outcomes[left] && outcomes[right] &&
    Number.isFinite(outcomes[left].odds) && Number.isFinite(outcomes[right].odds);
}

function parseBet365BaseballPage(html) {
  const $ = cheerio.load(String(html || ''));
  const games = new Map();
  $('li[data-item-category2][data-item-category3][data-item-name]').each((_, element) => {
    const league = leagueCode($(element).attr('data-item-category2'));
    const category = String($(element).attr('data-item-category3') || '').trim();
    const teams = String($(element).attr('data-item-name') || '').split(/\s+@\s+/);
    const startTime = Date.parse($(element).find('[data-utc]').first().attr('data-utc'));
    const fixtureId = String($(element).attr('data-fixture-id') || '').trim();
    if (!league || teams.length !== 2 || !Number.isFinite(startTime) || !fixtureId) return;
    const away = translateBaseballTeam(league, teams[0]);
    const home = translateBaseballTeam(league, teams[1]);
    if (!away || !home) return;
    const key = `${league}|${startTime}|${away}|${home}`;
    const game = games.get(key) || {
      league,
      startTime,
      scheduledStart: new Date(startTime).toISOString(),
      away,
      home,
      fixtureIds: {},
      markets: {},
    };
    const outcomes = marketLinks($, element);
    if (/^Money Line$/i.test(category) && validPair(outcomes, 'Away Win', 'Home Win')) {
      game.fixtureIds.ml = fixtureId;
      game.markets.ml = { away: outcomes['Away Win'].odds, home: outcomes['Home Win'].odds };
    } else if (/^(?:Run Line|Point Spread|Handicap)$/i.test(category) && validPair(outcomes, 'Away Win', 'Home Win')) {
      const awayLine = outcomes['Away Win'].line;
      const homeLine = outcomes['Home Win'].line;
      if (Number.isFinite(awayLine) && Number.isFinite(homeLine) && awayLine !== 0 && Math.sign(awayLine) !== Math.sign(homeLine)) {
        game.fixtureIds.hd = fixtureId;
        game.markets.hd = {
          favorite: awayLine < 0 ? 'away' : 'home',
          line: Math.abs(awayLine),
          away: outcomes['Away Win'].odds,
          home: outcomes['Home Win'].odds,
        };
      }
    } else if (/^(?:Game Totals|Totals?|Total)$/i.test(category) && validPair(outcomes, 'Over', 'Under')) {
      const line = outcomes.Over.line;
      if (Number.isFinite(line) && line > 0) {
        game.fixtureIds.total = fixtureId;
        game.markets.total = { line, over: outcomes.Over.odds, under: outcomes.Under.odds };
      }
    }
    games.set(key, game);
  });
  return [...games.values()].sort((a, b) => a.startTime - b.startTime);
}

function snapshotBeforeStart(market, startTime) {
  if (!market || typeof market !== 'object') return null;
  for (const key of ['close', 'active', 'open']) {
    const snapshot = market[key];
    if (!snapshot) continue;
    const at = snapshot.at || market.observedAt;
    if (isPregameObservation(startTime, at)) return { ...snapshot, at };
  }
  return null;
}

function betExplorerObservation(game) {
  if (!game || !game.markets) return null;
  const startTime = game.startISO || `${game.date}T${game.startTime}:00+08:00`;
  const ml = snapshotBeforeStart(game.markets.ml, startTime);
  const hd = snapshotBeforeStart(game.markets.hd, startTime);
  const total = snapshotBeforeStart(game.markets.ou, startTime);
  const selectedTimes = [ml, hd, total].map((market) => market && Date.parse(market.at)).filter(Number.isFinite);
  if (!selectedTimes.length) return null;
  const observedAt = new Date(Math.max(...selectedTimes)).toISOString();
  const observation = normalizeMarketObservation({
    provider: 'betexplorer',
    observedAt,
    scheduledStart: new Date(Date.parse(startTime)).toISOString(),
    ml: ml && { away: ml.away, home: ml.home },
    hd: hd && { favorite: hd.favorite || (game.bet365 && game.bet365.side), line: hd.line, away: hd.away, home: hd.home },
    total: total && { line: total.line, over: total.over, under: total.under },
  });
  const activeSide = observation.favorite;
  const struck = Array.isArray(game.bet365 && game.bet365.struck) ? game.bet365.struck : [];
  const priorSide = struck.find((entry) => entry && (entry.side === 'away' || entry.side === 'home') && entry.side !== activeSide);
  if (game.bet365 && game.bet365.flipEver && activeSide && priorSide) {
    const changedAt = Date.parse(game.bet365.at || game.bet365.observedAt || observedAt);
    observation.evidenceEvents = [{
      at: Number.isFinite(changedAt) ? new Date(changedAt).toISOString() : observedAt,
      type: 'favorite-flip',
      provider: 'betexplorer',
      from: priorSide.side,
      to: activeSide,
      line: observation.markets.hd && observation.markets.hd.line,
      evidenceId: `betexplorer:${game.eventId || `${game.date}|${game.awayTeam}|${game.homeTeam}`}:bet365-favorite-flip:${priorSide.side}:${activeSide}`,
    }];
  }
  return observation;
}

function resolveBaseballGame(official, fallback, frozenOfficial) {
  return resolveGameSources(official, fallback, frozenOfficial);
}

function findOfficialMatch(parsed, officialGames) {
  const candidates = officialGames.filter((game) => game.league === parsed.league &&
    game.away === parsed.away && game.home === parsed.home)
    .map((game) => ({ game, diff: Math.abs(game.scheduledMs - parsed.startTime) }))
    .filter((entry) => entry.diff <= MATCH_TOLERANCE_MS)
    .sort((a, b) => a.diff - b.diff);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].diff === candidates[1].diff) return null;
  return candidates[0].game;
}

function findFallbackGame(feed, official) {
  const candidates = Object.values(feed && feed.games || {}).filter((game) => {
    if (!game || leagueCode(game.league) !== official.league) return false;
    if (translateBaseballTeam(official.league, game.awayTeam) !== official.away) return false;
    if (translateBaseballTeam(official.league, game.homeTeam) !== official.home) return false;
    const start = Date.parse(game.startISO || `${game.date}T${game.startTime}:00+08:00`);
    return Number.isFinite(start) && Math.abs(start - official.scheduledMs) <= MATCH_TOLERANCE_MS;
  });
  candidates.sort((a, b) => Math.abs(Date.parse(a.startISO) - official.scheduledMs) - Math.abs(Date.parse(b.startISO) - official.scheduledMs));
  return candidates[0] || null;
}

async function defaultFetchPages() {
  const pages = [];
  try {
    pages.push({ league: 'MLB', html: await sidecar.fetchText(MLB_HUB_URL, {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    }, 90000) });
  } catch (error) {
    pages.push({ league: 'MLB', error: String(error && error.message || error) });
  }
  try {
    const rendered = await fetchBet365Page(SPORTSBOOK_URL, { waitMs: 10000, timeoutMs: 90000 });
    pages.push({ league: 'ALL', html: rendered.html });
    for (const item of rendered.captured || []) {
      if (item && item.body) pages.push({ league: 'ALL', html: item.body, capturedUrl: item.url });
    }
  } catch (error) {
    pages.push({ league: 'ALL', error: String(error && error.message || error) });
  }
  return pages;
}

async function collectBaseballBet365Odds(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const observedAt = new Date(now).toISOString();
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { matches: {}, leagues: {} };
  const officialRows = Array.isArray(options.officialRows) ? options.officialRows : [];
  const officialGames = buildOfficialGames(officialRows).filter((game) => game.scheduledMs > now + 30000);
  const fetchPages = options.fetchPages || defaultFetchPages;
  const pages = await fetchPages();
  const parsed = [];
  const pageErrors = [];
  for (const page of pages || []) {
    if (page && page.error) {
      pageErrors.push(page.error);
      continue;
    }
    parsed.push(...parseBet365BaseballPage(page && page.html));
  }
  const officialById = {};
  for (const fixture of parsed) {
    const official = findOfficialMatch(fixture, officialGames);
    if (!official) continue;
    officialById[official.officialId] = normalizeMarketObservation({
      provider: 'bet365-official',
      observedAt,
      scheduledStart: official.scheduledStart,
      ml: fixture.markets.ml,
      hd: fixture.markets.hd,
      total: fixture.markets.total,
      fixtureIds: fixture.fixtureIds,
    });
  }

  const matches = JSON.parse(JSON.stringify(previous.matches || {}));
  const leagues = JSON.parse(JSON.stringify(previous.leagues || {}));
  const health = Object.fromEntries(['MLB', 'NPB', 'KBO', 'CPBL'].map((league) => [league, {
    scheduled: 0, officialMatched: 0, fallbackMatched: 0, matched: 0,
  }]));

  for (const official of officialGames) {
    health[official.league].scheduled++;
    const direct = officialById[official.officialId] || null;
    const fallbackGame = findFallbackGame(options.betExplorer, official);
    const fallback = fallbackGame ? betExplorerObservation(fallbackGame) : null;
    const frozen = matches[official.officialId] && matches[official.officialId].provider === 'bet365-official'
      ? matches[official.officialId]
      : null;
    const resolved = resolveBaseballGame(direct, fallback, frozen);
    if (!Object.keys(resolved.markets).length) continue;
    if (direct && Object.keys(direct.markets || {}).length) health[official.league].officialMatched++;
    if (fallback && Object.values(resolved.markets).some((market) => market.provider === 'betexplorer')) {
      health[official.league].fallbackMatched++;
    }
    health[official.league].matched++;
    const provider = resolved.markets.hd && resolved.markets.hd.provider ||
      resolved.markets.ml && resolved.markets.ml.provider ||
      resolved.markets.total && resolved.markets.total.provider;
    const observation = {
      league: official.league,
      officialId: official.officialId,
      scheduledStart: official.scheduledStart,
      away: official.away,
      home: official.home,
      provider,
      observedAt,
      favorite: resolved.favorite,
      markets: resolved.markets,
      mixedSources: resolved.mixedSources,
      evidenceEvents: [
        ...(Array.isArray(direct && direct.evidenceEvents) ? direct.evidenceEvents : []),
        ...(Array.isArray(fallback && fallback.evidenceEvents) ? fallback.evidenceEvents : []),
      ],
    };
    const merged = mergeProviderObservation(matches[official.officialId], observation);
    if (merged) matches[official.officialId] = merged;
  }

  for (const league of Object.keys(health)) {
    const row = health[league];
    leagues[league] = {
      status: row.matched ? (row.fallbackMatched ? 'fallback' : 'ok') : (pageErrors.length ? 'error' : 'empty'),
      ...row,
      lastAttemptAt: observedAt,
      lastSuccessAt: row.matched ? observedAt : (leagues[league] && leagues[league].lastSuccessAt || null),
      errors: pageErrors.slice(0, 4),
    };
  }
  for (const [key, game] of Object.entries(matches)) {
    const start = Date.parse(game && game.scheduledStart || '');
    if (Number.isFinite(start) && now - start > RETENTION_MS) delete matches[key];
  }
  return {
    schemaVersion: 1,
    provider: 'bet365-official-first',
    updated: observedAt,
    source: 'https://www.bet365.com/',
    leagues,
    matches,
  };
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

async function main() {
  try {
    const output = await collectBaseballBet365Odds({
      previous: loadJSON(OUT, { matches: {}, leagues: {} }),
      officialRows: loadJSON(PREGAME, []),
      betExplorer: loadJSON(BETEXPLORER, { games: {} }),
    });
    saveAtomic(OUT, output);
    const summary = Object.entries(output.leagues).map(([league, row]) =>
      `${league}:${row.status} 官網${row.officialMatched}/備援${row.fallbackMatched}`).join(' ');
    console.log(`Bet365 棒球：${Object.keys(output.matches).length} 場；${summary}`);
  } finally {
    await sidecar.shutdown();
  }
}

module.exports = {
  OUT,
  MLB_HUB_URL,
  SPORTSBOOK_URL,
  translateBaseballTeam,
  parseBet365BaseballPage,
  betExplorerObservation,
  resolveBaseballGame,
  collectBaseballBet365Odds,
  saveAtomic,
};

if (require.main === module) main().catch((error) => {
  console.error(`Bet365 棒球收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
