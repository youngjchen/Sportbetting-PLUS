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
const ODDSPORTAL = path.join(__dirname, 'data', 'oddsportal_bet365.json');
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

// BET365 備援＝BetExplorer 摘要裡「真的 BET365 欄」（game.bet365）。
// ‼️ game.markets 是 Stake.com 的盤（摘要的 bookmaker＝Stake.com），絕不可當 BET365
// （2026-10-11 發現：日韓職 BET365 欄一直顯示 Stake 的讓分方與換邊，七類跟著記錯）。
// BET365 兩個方向同時開著（ambiguous）時方向只是網頁排列順序 → 不給，讓下一層來源接手。
const BETEXPLORER_BET365 = 'betexplorer-bet365';
// 第二道備援（2026-10-12 使用者規格）：OddsPortal 的 BET365 欄（oddsportal_bet365.py，本機每 30 分）。
// 檔案的 games[].bet365 與 BetExplorer 摘要同形 → 同一支函式轉換，只換 provider。
const ODDSPORTAL_BET365 = 'oddsportal-bet365';
const FALLBACK_STALE_MS = 90 * 60 * 1000;
function betExplorerObservation(game, provider = BETEXPLORER_BET365) {
  const b = game && game.bet365;
  if (!b || (b.side !== 'away' && b.side !== 'home') || b.ambiguous) return null;
  const line = Number(b.line);
  if (!Number.isFinite(line) || line <= 0) return null;
  const startTime = game.startISO || `${game.date}T${game.startTime}:00+08:00`;
  const seen = Date.parse(b.observedAt || game.observedAt || b.at || '');   // 舊摘要沒有觀測時間 → 用該線開出時間
  if (!Number.isFinite(seen)) return null;
  const odds = b.odds || {};
  const observation = normalizeMarketObservation({
    provider,
    observedAt: new Date(seen).toISOString(),
    scheduledStart: new Date(Date.parse(startTime)).toISOString(),
    hd: { favorite: b.side, line, away: odds.away, home: odds.home },
  }, { allowPricelessHd: true });
  if (!observation.markets.hd) return null;
  const activeSide = observation.favorite;
  const struck = Array.isArray(game.bet365 && game.bet365.struck) ? game.bet365.struck : [];
  const priorSide = struck.find((entry) => entry && (entry.side === 'away' || entry.side === 'home') && entry.side !== activeSide);
  if (game.bet365 && game.bet365.flipEver && activeSide && priorSide) {
    const observedAt = observation.observedAt;
    const changedAt = Date.parse(game.bet365.at || game.bet365.observedAt || observedAt);
    observation.evidenceEvents = [{
      at: Number.isFinite(changedAt) ? new Date(changedAt).toISOString() : observedAt,
      type: 'favorite-flip',
      provider,
      from: priorSide.side,
      to: activeSide,
      line: observation.markets.hd && observation.markets.hd.line,
      evidenceId: `${provider}:${game.eventId || `${game.date}|${game.awayTeam}|${game.homeTeam}`}:bet365-favorite-flip:${priorSide.side}:${activeSide}`,
    }];
  }
  return observation;
}

// BetExplorer 第一道、OddsPortal 第二道：BetExplorer 沒抓到（沒有可用的 bet365 列）就用 OddsPortal；
// BetExplorer 有、但 90 分鐘沒更新（網站當機，10/11 晚上實例）而 OddsPortal 較新，也換 OddsPortal。
function pickFallbackObservation(betExplorer, oddsPortal, now) {
  const fresh = (obs) => obs && now - Date.parse(obs.observedAt) <= FALLBACK_STALE_MS;
  if (fresh(betExplorer)) return betExplorer;
  if (fresh(oddsPortal)) return oddsPortal;
  return betExplorer || oddsPortal || null;
}

// 2026-10-11 以前存的 'betexplorer' 紀錄其實是 Stake.com 的盤（誤標成 BET365）→ 清掉；官網紀錄保留。
// 只剩誤標資料的場次整筆刪除，下一輪從真的 BET365 欄（betexplorer-bet365）重建。可重複執行。
function purgeStakeMislabel(match) {
  if (!match || typeof match !== 'object') return null;
  const bad = (provider) => provider === 'betexplorer';
  const oldHistory = Array.isArray(match.history) ? match.history : [];
  const oldEvents = Array.isArray(match.events) ? match.events : [];
  const history = oldHistory.filter((row) => row && !bad(row.provider));
  const events = oldEvents.filter((event) => event && !bad(event.provider) &&
    !(event.type === 'source-change' && (bad(event.from) || bad(event.to))));
  const touched = history.length !== oldHistory.length || events.length !== oldEvents.length || bad(match.provider) ||
    Object.values(match.markets || {}).some((market) => market && bad(market.provider));
  if (!touched) return match;
  if (!history.length) return null;
  const last = history[history.length - 1];
  const providerHistories = { ...(match.providerHistories || {}) };
  delete providerHistories.betexplorer;
  return {
    ...match, provider: last.provider, favorite: last.favorite || null,
    markets: JSON.parse(JSON.stringify(last.markets || {})), history, providerHistories, events,
    favoriteFlipCount: events.filter((event) => event.type === 'favorite-flip').length,
  };
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
  // 每個官網頁的抓取狀態（以頁為單位，ALL 的攔截回應不覆寫主頁結果）。
  // 2026-10-11：同一台 runner 的 IP 被 bet365 擋 403 長達 4.5 小時，新 runner 卻正常 →
  // 工作流看 pages.MLB.ok 連續失敗就結束本棒換 runner（新 IP）。
  const pageStatus = {};
  for (const page of pages || []) {
    const pageKey = page && page.league || 'ALL';
    if (page && page.error) {
      pageErrors.push(page.error);
      if (!pageStatus[pageKey]) pageStatus[pageKey] = { ok: false, error: String(page.error).slice(0, 200) };
      continue;
    }
    if (!pageStatus[pageKey]) pageStatus[pageKey] = { ok: true };
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
  for (const [key, match] of Object.entries(matches)) {
    const cleaned = purgeStakeMislabel(match);
    if (cleaned) matches[key] = cleaned;
    else delete matches[key];
  }
  const leagues = JSON.parse(JSON.stringify(previous.leagues || {}));
  const health = Object.fromEntries(['MLB', 'NPB', 'KBO', 'CPBL'].map((league) => [league, {
    scheduled: 0, officialMatched: 0, fallbackMatched: 0, oddsPortalMatched: 0, matched: 0,
  }]));

  for (const official of officialGames) {
    health[official.league].scheduled++;
    const direct = officialById[official.officialId] || null;
    const fallbackGame = findFallbackGame(options.betExplorer, official);
    const oddsPortalGame = findFallbackGame(options.oddsPortal, official);
    const fallback = pickFallbackObservation(
      fallbackGame ? betExplorerObservation(fallbackGame) : null,
      oddsPortalGame ? betExplorerObservation(oddsPortalGame, ODDSPORTAL_BET365) : null,
      now,
    );
    const frozen = matches[official.officialId] && matches[official.officialId].provider === 'bet365-official'
      ? matches[official.officialId]
      : null;
    const resolved = resolveBaseballGame(direct, fallback, frozen);
    if (!Object.keys(resolved.markets).length) continue;
    if (direct && Object.keys(direct.markets || {}).length) health[official.league].officialMatched++;
    const usedProviders = Object.values(resolved.markets).map((market) => market.provider);
    if (fallback && usedProviders.some((p) => p === BETEXPLORER_BET365 || p === ODDSPORTAL_BET365)) {
      health[official.league].fallbackMatched++;
    }
    if (usedProviders.includes(ODDSPORTAL_BET365)) health[official.league].oddsPortalMatched++;
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
    pages: pageStatus,
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
      oddsPortal: loadJSON(ODDSPORTAL, { games: {} }),
    });
    saveAtomic(OUT, output);
    const summary = Object.entries(output.leagues).map(([league, row]) =>
      `${league}:${row.status} 官網${row.officialMatched}/備援${row.fallbackMatched}(OddsPortal ${row.oddsPortalMatched})`).join(' ');
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
  pickFallbackObservation,
  ODDSPORTAL_BET365,
  purgeStakeMislabel,
  resolveBaseballGame,
  collectBaseballBet365Odds,
  saveAtomic,
};

if (require.main === module) main().catch((error) => {
  console.error(`Bet365 棒球收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
