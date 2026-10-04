'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');
const { NBA_TEAMS, translateNbaTeam } = require('./nba_odds_core.js');
const { fetchBet365Page } = require('./bet365_official_transport.js');
const {
  normalizeMarketObservation,
  mergeProviderObservation,
  resolveGameSources,
  isPregameObservation,
} = require('./bet365_official_core.js');

const OUT = path.join(__dirname, 'data', 'nba_bet365_odds.json');
const PREGAME = path.join(__dirname, 'data', 'nba_pregame.json');
const WNBA_PREGAME = path.join(__dirname, 'data', 'wnba_pregame.json');
const BETEXPLORER = path.join(__dirname, 'data', 'oddsportal_summary.json');
const SEASON = '26-27';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://nba.titan007.com/' };
const NBA_HUB_URL = 'https://www.bet365.com/hub/en-us/basketball/nba';
const WNBA_HUB_URL = 'https://www.bet365.com/hub/en-us/basketball/wnba';
const SPORTSBOOK_URL = 'https://www.bet365.com/#/AS/B18/';
const MATCH_TOLERANCE_MS = 12 * 3600000;
const RETENTION_MS = 7 * 86400000;

const NBA_SHORT = Object.freeze({
  'ATL Hawks': '老鷹', 'BOS Celtics': '塞爾提克', 'BKN Nets': '籃網', 'CHA Hornets': '黃蜂',
  'CHI Bulls': '公牛', 'CLE Cavaliers': '騎士', 'DAL Mavericks': '獨行俠', 'DEN Nuggets': '金塊',
  'DET Pistons': '活塞', 'GS Warriors': '勇士', 'HOU Rockets': '火箭', 'IND Pacers': '溜馬',
  'LA Clippers': '快艇', 'LA Lakers': '湖人', 'MEM Grizzlies': '灰熊', 'MIA Heat': '熱火',
  'MIL Bucks': '公鹿', 'MIN Timberwolves': '灰狼', 'NO Pelicans': '鵜鶘', 'NY Knicks': '尼克',
  'OKC Thunder': '雷霆', 'ORL Magic': '魔術', 'PHI 76ers': '76人', 'PHX Suns': '太陽',
  'POR Trail Blazers': '拓荒者', 'SAC Kings': '國王', 'SA Spurs': '馬刺', 'TOR Raptors': '暴龍',
  'UTA Jazz': '爵士', 'WAS Wizards': '巫師',
});

const WNBA_TEAMS = Object.freeze({
  'ATL Dream': '美夢', 'Atlanta Dream': '美夢', 'CHI Sky': '天空', 'Chicago Sky': '天空',
  'CON Sun': '太陽', 'Connecticut Sun': '太陽', 'DAL Wings': '飛翼', 'Dallas Wings': '飛翼',
  'GS Valkyries': '金州', 'Golden State Valkyries': '金州', 'IND Fever': '狂熱', 'Indiana Fever': '狂熱',
  'LA Sparks': '火花', 'Los Angeles Sparks': '火花', 'LV Aces': '王牌', 'Las Vegas Aces': '王牌',
  'MIN Lynx': '山貓', 'Minnesota Lynx': '山貓', 'NY Liberty': '自由', 'New York Liberty': '自由',
  'PHX Mercury': '水星', 'Phoenix Mercury': '水星', 'POR Fire': '火焰', 'Portland Fire': '火焰',
  'SEA Storm': '風暴', 'Seattle Storm': '風暴', 'TOR Tempo': '節奏', 'Toronto Tempo': '節奏',
  'WAS Mystics': '神秘', 'Washington Mystics': '神秘',
});

function sourceText(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  return /^\s*</.test(text) ? cheerio.load(text).text().replace(/^\uFEFF/, '') : text;
}

function parseMonth(raw) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(sourceText(raw), sandbox, { timeout: 1000 });
  const teams = Object.fromEntries((sandbox.arrTeam || []).map((team) => [Number(team[0]), team]));
  return Array.from(sandbox.arrData || []).map((row) => {
    const homeTeam = teams[Number(row[3])];
    const awayTeam = teams[Number(row[4])];
    return {
      scheId: Number(row[0]),
      startBJ: String(row[2] || ''),
      home: homeTeam && String(homeTeam[5] || homeTeam[2] || ''),
      away: awayTeam && String(awayTeam[5] || awayTeam[2] || ''),
    };
  }).filter((game) => game.scheId && game.startBJ && game.home && game.away);
}

function parseChangeRows(html) {
  // Titan 有時只回傳一串 <tr>，Cheerio 以完整文件解析時會把孤立列丟掉。
  const $ = cheerio.load(`<table>${String(html || '')}</table>`);
  const rows = [];
  $('tr').each((_, row) => {
    const cells = $(row).find('th,td').toArray().map((cell) => $(cell).text().replace(/\s+/g, ' ').trim()).filter(Boolean);
    const time = cells.find((cell) => /^\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.test(cell));
    if (!time) return;
    const values = cells.filter((cell) => cell !== time && /^[+-]?\d+(?:\.\d+)?$/.test(cell)).map(Number);
    if (!values.length) return;
    if (values.length >= 3) rows.push({ t: time, line: values[1], o1: values[0], o2: values[2] });
    else rows.push({ t: time, line: values[0] });
  });
  return rows;
}

function rowTime(row, startBJ) {
  const match = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(String(row && row.t || ''));
  const year = Number(String(startBJ || '').slice(0, 4));
  if (!match || !year) return NaN;
  return Date.parse(`${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}T${match[3].padStart(2, '0')}:${match[4]}:00+08:00`);
}

function keepPregameRows(rows, startBJ) {
  const start = Date.parse(String(startBJ || '').replace(' ', 'T') + ':00+08:00');
  return (rows || []).filter((row) => {
    const time = rowTime(row, startBJ);
    return Number.isFinite(time) && Number.isFinite(start) && start - time > 30000;
  });
}

async function fetchText(url) {
  return sidecar.fetchText(url, HEADERS, 90000);
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

function parseMoneyline(js) {
  const match = String(js || '').match(/var game=Array\(([\s\S]*?)\);/);
  if (!match) return null;
  for (const quoted of match[1].match(/"[^"]+"/g) || []) {
    const fields = quoted.slice(1, -1).split('|');
    if (fields[0] !== '214') continue;
    const home = Number(fields[8]);
    const away = Number(fields[9]);
    if (home > 1 && away > 1) return { away, home };
  }
  return null;
}

function basketballLeague(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('WNBA')) return 'WNBA';
  if (text.includes('NBA')) return 'NBA';
  return '';
}

function translateBasketballTeam(league, value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (league === 'WNBA') return WNBA_TEAMS[text] || text;
  if (NBA_SHORT[text]) return NBA_SHORT[text];
  if (NBA_TEAMS[text]) return NBA_TEAMS[text][0];
  try { return translateNbaTeam(text); } catch (_) { return text; }
}

function firstNumber(value) {
  const match = String(value || '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function officialOutcomes($, element) {
  const outcomes = {};
  $(element).find('[data-item-variant]').each((_, link) => {
    const variant = String($(link).attr('data-item-variant') || '').trim();
    const odds = Number($(link).attr('data-item-odds'));
    if (!variant || !Number.isFinite(odds) || outcomes[variant]) return;
    outcomes[variant] = { odds, line: firstNumber($(link).text()) };
  });
  return outcomes;
}

function outcome(outcomes, names) {
  for (const name of names) if (outcomes[name]) return outcomes[name];
  return null;
}

function parseBet365BasketballPage(html) {
  const $ = cheerio.load(String(html || ''));
  const games = new Map();
  $('li[data-item-category2][data-item-category3][data-item-name]').each((_, element) => {
    const league = basketballLeague($(element).attr('data-item-category2'));
    const category = String($(element).attr('data-item-category3') || '').trim();
    const teams = String($(element).attr('data-item-name') || '').split(/\s+@\s+/);
    const startTime = Date.parse($(element).find('[data-utc]').first().attr('data-utc'));
    const fixtureId = String($(element).attr('data-fixture-id') || '').trim();
    if (!league || teams.length !== 2 || !Number.isFinite(startTime) || !fixtureId) return;
    const away = translateBasketballTeam(league, teams[0]);
    const home = translateBasketballTeam(league, teams[1]);
    const key = `${league}|${startTime}|${away}|${home}`;
    const game = games.get(key) || {
      league, startTime, scheduledStart: new Date(startTime).toISOString(), away, home,
      fixtureIds: {}, markets: {},
    };
    const outcomes = officialOutcomes($, element);
    const awayWin = outcome(outcomes, ['Away Win', 'Away']);
    const homeWin = outcome(outcomes, ['Home Win', 'Home']);
    if (/^Money Line$/i.test(category) && awayWin && homeWin) {
      game.fixtureIds.ml = fixtureId;
      game.markets.ml = { away: awayWin.odds, home: homeWin.odds };
    } else if (/^(?:Point Spread|Handicap)$/i.test(category) && awayWin && homeWin) {
      if (Number.isFinite(awayWin.line) && Number.isFinite(homeWin.line) && awayWin.line !== 0 && Math.sign(awayWin.line) !== Math.sign(homeWin.line)) {
        game.fixtureIds.hd = fixtureId;
        game.markets.hd = {
          favorite: awayWin.line < 0 ? 'away' : 'home',
          line: Math.abs(awayWin.line), away: awayWin.odds, home: homeWin.odds,
        };
      }
    } else if (/^(?:Game Totals|Totals?|Total)$/i.test(category)) {
      const over = outcome(outcomes, ['Over']);
      const under = outcome(outcomes, ['Under']);
      if (over && under && Number.isFinite(over.line) && over.line > 0) {
        game.fixtureIds.total = fixtureId;
        game.markets.total = { line: over.line, over: over.odds, under: under.odds };
      }
    }
    games.set(key, game);
  });
  return [...games.values()].sort((a, b) => a.startTime - b.startTime);
}

function scheduleRows(value, league) {
  const rows = Array.isArray(value) ? value : value && Array.isArray(value.games) ? value.games : [];
  const rejected = new Set(['finished', 'inprogress', 'postponed', 'cancelled', 'canceled']);
  return rows.map((game) => {
    const startTime = Date.parse(`${game.date}T${String(game.time || '').slice(0, 5)}:00+08:00`);
    if (!game.officialId || !Number.isFinite(startTime) || rejected.has(String(game.status || '').toLowerCase())) return null;
    return { ...game, league, startTime, scheduledStart: new Date(startTime).toISOString() };
  }).filter(Boolean);
}

function findScheduleGame(fixture, schedules) {
  const candidates = schedules.filter((game) => game.league === fixture.league && game.away === fixture.away && game.home === fixture.home)
    .map((game) => ({ game, diff: Math.abs(game.startTime - fixture.startTime) }))
    .filter((entry) => entry.diff <= MATCH_TOLERANCE_MS)
    .sort((a, b) => a.diff - b.diff);
  return candidates[0] ? candidates[0].game : null;
}

function fallbackSnapshot(market, startTime) {
  for (const key of ['close', 'active', 'open']) {
    const row = market && market[key];
    if (row && isPregameObservation(startTime, row.at)) return { ...row, at: row.at };
  }
  return null;
}

function basketballFallback(game, schedule) {
  if (!game || !game.markets) return null;
  const ml = fallbackSnapshot(game.markets.ml, schedule.scheduledStart);
  const hd = fallbackSnapshot(game.markets.hd, schedule.scheduledStart);
  const total = fallbackSnapshot(game.markets.ou, schedule.scheduledStart);
  const times = [ml, hd, total].map((row) => row && Date.parse(row.at)).filter(Number.isFinite);
  if (!times.length) return null;
  return normalizeMarketObservation({
    provider: 'betexplorer',
    observedAt: new Date(Math.max(...times)).toISOString(),
    scheduledStart: schedule.scheduledStart,
    ml: ml && { away: ml.away, home: ml.home },
    hd: hd && { favorite: hd.favorite || game.bet365 && game.bet365.side, line: hd.line, away: hd.away, home: hd.home },
    total: total && { line: total.line, over: total.over, under: total.under },
  });
}

function findBasketballFallback(feed, schedule) {
  return Object.values(feed && feed.games || {}).find((game) =>
    basketballLeague(game && game.league) === schedule.league &&
    translateBasketballTeam(schedule.league, game.awayTeam) === schedule.away &&
    translateBasketballTeam(schedule.league, game.homeTeam) === schedule.home &&
    Math.abs(Date.parse(game.startISO || '') - schedule.startTime) <= MATCH_TOLERANCE_MS
  ) || null;
}

async function defaultFetchBasketballPages() {
  const pages = [];
  for (const url of [NBA_HUB_URL, WNBA_HUB_URL]) {
    try {
      pages.push({ html: await sidecar.fetchText(url, {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9',
      }, 90000) });
    } catch (error) {
      pages.push({ error: String(error && error.message || error) });
    }
  }
  try {
    const rendered = await fetchBet365Page(SPORTSBOOK_URL, { waitMs: 10000, timeoutMs: 90000 });
    pages.push({ html: rendered.html });
    for (const item of rendered.captured || []) if (item && item.body) pages.push({ html: item.body });
  } catch (error) {
    pages.push({ error: String(error && error.message || error) });
  }
  return pages;
}

async function collectBet365BasketballOdds(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const observedAt = new Date(now).toISOString();
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { matches: {}, leagues: {} };
  const schedules = [
    ...scheduleRows(options.nbaPregame, 'NBA'),
    ...scheduleRows(options.wnbaPregame, 'WNBA'),
  ].filter((game) => game.startTime > now + 30000);
  const pages = await (options.fetchPages || defaultFetchBasketballPages)();
  const fixtures = [];
  const errors = [];
  for (const page of pages || []) {
    if (page && page.error) errors.push(page.error);
    else fixtures.push(...parseBet365BasketballPage(page && page.html));
  }
  const officialById = {};
  for (const fixture of fixtures) {
    const schedule = findScheduleGame(fixture, schedules);
    if (!schedule) continue;
    officialById[schedule.officialId] = normalizeMarketObservation({
      provider: 'bet365-official', observedAt, scheduledStart: schedule.scheduledStart,
      ml: fixture.markets.ml, hd: fixture.markets.hd, total: fixture.markets.total,
      fixtureIds: fixture.fixtureIds,
    });
  }
  const matches = JSON.parse(JSON.stringify(previous.matches || {}));
  const leagues = JSON.parse(JSON.stringify(previous.leagues || {}));
  const health = { NBA: { scheduled: 0, officialMatched: 0, fallbackMatched: 0, matched: 0 }, WNBA: { scheduled: 0, officialMatched: 0, fallbackMatched: 0, matched: 0 } };
  for (const schedule of schedules) {
    const row = health[schedule.league];
    row.scheduled++;
    const direct = officialById[schedule.officialId] || null;
    const fallbackGame = findBasketballFallback(options.betExplorer, schedule);
    const fallback = fallbackGame ? basketballFallback(fallbackGame, schedule) : null;
    const frozen = matches[schedule.officialId] && matches[schedule.officialId].provider === 'bet365-official'
      ? matches[schedule.officialId]
      : null;
    const resolved = resolveGameSources(direct, fallback, frozen);
    if (!Object.keys(resolved.markets).length) continue;
    if (direct && Object.keys(direct.markets || {}).length) row.officialMatched++;
    if (Object.values(resolved.markets).some((market) => market.provider === 'betexplorer')) row.fallbackMatched++;
    row.matched++;
    const provider = resolved.markets.hd && resolved.markets.hd.provider || resolved.markets.ml && resolved.markets.ml.provider || resolved.markets.total && resolved.markets.total.provider;
    const observation = {
      officialId: schedule.officialId, league: schedule.league,
      scheduledStart: schedule.scheduledStart, away: schedule.away, home: schedule.home,
      provider, observedAt, favorite: resolved.favorite, line: resolved.line,
      moneyline: resolved.markets.ml ? { away: resolved.markets.ml.away, home: resolved.markets.ml.home } : null,
      handicapOdds: resolved.markets.hd ? { away: resolved.markets.hd.away, home: resolved.markets.hd.home } : null,
      total: resolved.markets.total ? { line: resolved.markets.total.line, over: resolved.markets.total.over, under: resolved.markets.total.under } : null,
      markets: resolved.markets, mixedSources: resolved.mixedSources,
    };
    const merged = mergeProviderObservation(matches[schedule.officialId], observation);
    if (merged) matches[schedule.officialId] = merged;
  }
  for (const league of ['NBA', 'WNBA']) {
    const row = health[league];
    leagues[league] = {
      status: row.matched ? (row.fallbackMatched ? 'fallback' : 'ok') : (errors.length ? 'error' : 'empty'),
      ...row, lastAttemptAt: observedAt,
      lastSuccessAt: row.matched ? observedAt : leagues[league] && leagues[league].lastSuccessAt || null,
      errors: errors.slice(0, 4),
    };
  }
  for (const [key, game] of Object.entries(matches)) {
    const start = Date.parse(game && game.scheduledStart || '');
    if (Number.isFinite(start) && now - start > RETENTION_MS) delete matches[key];
  }
  return {
    schemaVersion: 2,
    provider: 'bet365-official-first',
    updated: observedAt,
    source: 'https://www.bet365.com/',
    health: { status: Object.values(leagues).some((row) => row.status === 'error') ? 'partial' : 'ok', errors },
    leagues,
    matches,
  };
}

async function collectBet365NbaOdds(options = {}) {
  return collectBet365BasketballOdds({
    ...options,
    nbaPregame: options.nbaPregame || options.pregame,
    wnbaPregame: options.wnbaPregame || { games: [] },
  });
}

async function main() {
  try {
    const output = await collectBet365BasketballOdds({
      previous: loadJson(OUT, { matches: {}, leagues: {} }),
      nbaPregame: loadJson(PREGAME, { games: [] }),
      wnbaPregame: loadJson(WNBA_PREGAME, { games: [] }),
      betExplorer: loadJson(BETEXPLORER, { games: {} }),
    });
    saveAtomic(OUT, output);
    const summary = Object.entries(output.leagues).map(([league, row]) => `${league}:${row.status} 官網${row.officialMatched}/備援${row.fallbackMatched}`).join(' ');
    console.log(`Bet365 籃球：${Object.keys(output.matches).length} 場；${summary}`);
  } finally {
    await sidecar.shutdown();
  }
}

module.exports = {
  parseMonth,
  parseChangeRows,
  keepPregameRows,
  parseMoneyline,
  translateBasketballTeam,
  parseBet365BasketballPage,
  collectBet365BasketballOdds,
  collectBet365NbaOdds,
  saveAtomic,
};

if (require.main === module) main().catch((error) => {
  console.error(`Bet365 NBA 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
