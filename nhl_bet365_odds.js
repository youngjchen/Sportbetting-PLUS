'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');
const { fetchBet365Page } = require('./bet365_official_transport.js');
const {
  translateTeam,
  stableGameKey,
  mergeBet365Game,
} = require('./nhl_bet365_core.js');

const HUB_URL = 'https://www.bet365.com/hub/en-us/ice-hockey/nhl';
const OUT = path.join(__dirname, 'data', 'nhl_bet365_odds.json');
const THREE_DAYS_MS = 3 * 86400000;

function firstNumber(text) {
  const match = String(text || '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function marketLinks($, element) {
  const result = {};
  $(element).find('[data-item-variant]').each((_, link) => {
    const variant = $(link).attr('data-item-variant');
    if (!variant || result[variant]) return;
    result[variant] = {
      odds: Number($(link).attr('data-item-odds')),
      line: firstNumber($(link).text()),
    };
  });
  return result;
}

function hasTwoValidPrices(outcomes) {
  return outcomes['Away Win'] && outcomes['Home Win'] &&
    Number.isFinite(outcomes['Away Win'].odds) &&
    Number.isFinite(outcomes['Home Win'].odds);
}

function moneyLineMarket(game, outcomes) {
  return {
    market: 'Money Line',
    outcomes: [
      { name: game.away, side: 'away', odds: outcomes['Away Win'].odds },
      { name: game.home, side: 'home', odds: outcomes['Home Win'].odds },
    ],
  };
}

function puckLineMarket(game, outcomes) {
  const awayLine = outcomes['Away Win'].line;
  const homeLine = outcomes['Home Win'].line;
  if (!Number.isFinite(awayLine) || !Number.isFinite(homeLine)) return null;
  if (awayLine === 0 || homeLine === 0 || Math.sign(awayLine) === Math.sign(homeLine)) return null;
  if (Math.abs(Math.abs(awayLine) - Math.abs(homeLine)) > 0.0001) return null;
  return {
    market: 'Puck Line',
    line: Math.abs(awayLine),
    favSide: awayLine < 0 ? 'away' : 'home',
    outcomes: [
      { name: game.away, side: 'away', line: awayLine, odds: outcomes['Away Win'].odds },
      { name: game.home, side: 'home', line: homeLine, odds: outcomes['Home Win'].odds },
    ],
  };
}

function totalMarket(outcomes) {
  if (!outcomes.Over || !outcomes.Under) return null;
  const line = outcomes.Over.line;
  if (!Number.isFinite(line) || line <= 0 || !Number.isFinite(outcomes.Over.odds) || !Number.isFinite(outcomes.Under.odds)) return null;
  return {
    market: 'Game Totals',
    line,
    outcomes: [
      { name: 'Over', side: 'over', line, odds: outcomes.Over.odds },
      { name: 'Under', side: 'under', line, odds: outcomes.Under.odds },
    ],
  };
}

function parseBet365NhlHub(html) {
  const $ = cheerio.load(String(html || ''));
  const games = new Map();

  $('li[data-item-category2="NHL"][data-item-name]').each((_, element) => {
    const category = $(element).attr('data-item-category3');
    if (category !== 'Money Line' && category !== 'Puck Line' && category !== 'Game Totals') return;
    const name = String($(element).attr('data-item-name') || '');
    const parts = name.split(/\s+@\s+/);
    if (parts.length !== 2) return;
    const away = parts[0].trim();
    const home = parts[1].trim();
    const startTime = Date.parse($(element).find('[data-utc]').first().attr('data-utc'));
    const fixtureId = String($(element).attr('data-fixture-id') || '').trim();
    if (!away || !home || !Number.isFinite(startTime) || !fixtureId) return;

    const key = `${startTime}|${away}|${home}`;
    const game = games.get(key) || {
      startTime,
      away,
      home,
      awayZh: translateTeam(away),
      homeZh: translateTeam(home),
      fixtureIds: {},
    };
    const outcomes = marketLinks($, element);
    if (category === 'Money Line' && hasTwoValidPrices(outcomes)) {
      game.fixtureIds.ml = fixtureId;
      game.ml = moneyLineMarket(game, outcomes);
    }
    if (category === 'Puck Line' && hasTwoValidPrices(outcomes)) {
      const market = puckLineMarket(game, outcomes);
      if (market) {
        game.fixtureIds.hd = fixtureId;
        game.hd = market;
      }
    }
    if (category === 'Game Totals') {
      const market = totalMarket(outcomes);
      if (market) {
        game.fixtureIds.total = fixtureId;
        game.total = market;
      }
    }
    const eventUrl = String($(element).find('a.fas-EventLink[href]').first().attr('href') || '').trim();
    if (eventUrl) {
      game.sourceUrls = game.sourceUrls || {};
      if (category === 'Money Line') game.sourceUrls.ml = eventUrl;
      if (category === 'Puck Line') game.sourceUrls.hd = eventUrl;
      if (category === 'Game Totals') game.sourceUrls.total = eventUrl;
    }
    games.set(key, game);
  });

  return [...games.values()].sort((a, b) => a.startTime - b.startTime);
}

async function fetchOfficialHub() {
  return sidecar.fetchText(HUB_URL, {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  }, 90000);
}

async function fetchOfficialDetails(game) {
  const fixtureId = game && game.fixtureIds && (game.fixtureIds.ml || game.fixtureIds.hd);
  const sourceUrl = game && game.sourceUrls && (game.sourceUrls.ml || game.sourceUrls.hd);
  if (!sourceUrl && !fixtureId) return '';
  const url = sourceUrl || `https://www.bet365.com/dl/sportsbookredirect/?bs=${encodeURIComponent(fixtureId)}-0~0&bet=1`;
  const page = await fetchBet365Page(url, { waitMs: 5000, timeoutMs: 60000 });
  return page.html;
}

// ===== 備援：Action Network 上的 bet365（美國站，與官網 hub/en-us 同一家）=====
// 2026-10-26 起 Bet365 各聯盟 hub 頁拿掉了整塊賠率（只剩文案），互動頁也擋程式；BetExplorer／OddsPortal 的冰球讓分都沒有 bet365。
// 2026-10-28 使用者拍板：官網失敗時改用 Action Network 的 bet365 盤，「只要看 BET365 讓分方是誰，賠率不重要」。
const ACTION_URL = 'https://api.actionnetwork.com/web/v2/scoreboard/nhl';
const ACTION_BET365_BOOK = '79';

function americanToDecimal(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.round((n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n)) * 100) / 100;
}

function usDate(ms) {
  return new Date(ms - 5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
}

// scoreboard JSON → 與官網 hub 解析同形的比賽（隊名用 Action Network 全名，中文名同一張對照表）
function parseActionNetworkNhl(payload) {
  const out = [];
  for (const row of (payload && payload.games) || []) {
    const teams = Object.fromEntries(((row && row.teams) || []).map((t) => [t.id, t.full_name]));
    const away = String(teams[row.away_team_id] || '').trim();
    const home = String(teams[row.home_team_id] || '').trim();
    const startTime = Date.parse(row.start_time || '');
    const book = row.markets && row.markets[ACTION_BET365_BOOK] && row.markets[ACTION_BET365_BOOK].event;
    if (!away || !home || !Number.isFinite(startTime) || !book) continue;
    let awayZh, homeZh;
    try { awayZh = translateTeam(away); homeZh = translateTeam(home); } catch (_) { continue; }
    const pick = (list, side) => (list || []).find((o) => o && o.side === side);
    const game = { startTime, away, home, awayZh, homeZh, fixtureIds: { actionNetwork: String(row.id || '') },
      provider: 'actionnetwork-bet365', status: String(row.status || '') };
    const mlA = pick(book.moneyline, 'away'), mlH = pick(book.moneyline, 'home');
    if (mlA && mlH && americanToDecimal(mlA.odds) && americanToDecimal(mlH.odds)) {
      game.ml = { market: 'Money Line', outcomes: [
        { name: away, side: 'away', odds: americanToDecimal(mlA.odds) },
        { name: home, side: 'home', odds: americanToDecimal(mlH.odds) },
      ] };
    }
    const spA = pick(book.spread, 'away'), spH = pick(book.spread, 'home');
    const aLine = Number(spA && spA.value), hLine = Number(spH && spH.value);
    if (Number.isFinite(aLine) && Number.isFinite(hLine) && aLine !== 0 && Math.sign(aLine) !== Math.sign(hLine)) {
      game.hd = { market: 'Puck Line', line: Math.abs(aLine), favSide: aLine < 0 ? 'away' : 'home', outcomes: [
        { name: away, side: 'away', line: aLine, odds: americanToDecimal(spA.odds) },
        { name: home, side: 'home', line: hLine, odds: americanToDecimal(spH.odds) },
      ] };
    }
    const over = pick(book.total, 'over'), under = pick(book.total, 'under');
    const tLine = Number(over && over.value);
    if (Number.isFinite(tLine) && tLine > 0 && under) {
      game.total = { market: 'Game Totals', line: tLine, outcomes: [
        { name: 'Over', side: 'over', line: tLine, odds: americanToDecimal(over.odds) },
        { name: 'Under', side: 'under', line: tLine, odds: americanToDecimal(under.odds) },
      ] };
    }
    if (game.hd) out.push(game);
  }
  return out.sort((a, b) => a.startTime - b.startTime);
}

async function fetchActionNetworkGames(now) {
  const games = [];
  for (const day of [0, 1, 2]) {
    const url = `${ACTION_URL}?bookIds=${ACTION_BET365_BOOK}&periods=event&date=${usDate(now + day * 86400e3)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Action Network HTTP ${response.status}`);
    games.push(...parseActionNetworkNhl(await response.json()));
  }
  const seen = new Set();
  return games.filter((g) => !seen.has(`${g.startTime}|${g.away}|${g.home}`) && seen.add(`${g.startTime}|${g.away}|${g.home}`));
}

async function collectOfficialGames(options) {
  const fetchText = options.fetchText || fetchOfficialHub;
  const html = await fetchText(HUB_URL);
  if (/(?:just a moment|cf-chl|challenge-platform|cloudflare)/i.test(String(html || ''))) {
    throw new Error('Bet365 NHL 官方頁遇到 Cloudflare 挑戰，保留舊資料');
  }

  const parsed = parseBet365NhlHub(html);
  if (!parsed.length) throw new Error('Bet365 NHL 官方頁沒有可辨識賽事，保留舊資料');
  const complete = parsed.filter((game) => game.ml && game.hd);
  if (complete.length !== parsed.length) {
    throw new Error(`Bet365 NHL 官方頁解析不完整：完整 ${complete.length}/${parsed.length} 場，保留舊資料`);
  }
  return complete;
}

async function collectBet365NhlOdds(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { games: {} };
  const previousGames = previous.games && typeof previous.games === 'object' ? previous.games : {};
  // 測試注入 fetchText 時不碰真網路的備援（同 fetchDetails 的慣例）
  const fetchFallback = options.fetchActionNetwork === false || (options.fetchText && options.fetchActionNetwork == null)
    ? null
    : (options.fetchActionNetwork || fetchActionNetworkGames);
  let complete, source = HUB_URL, official = true;
  try {
    complete = await collectOfficialGames(options);
  } catch (officialError) {
    if (!fetchFallback) throw officialError;
    complete = await fetchFallback(now);
    if (!complete.length) throw new Error(`${officialError.message}；Action Network 也沒有 bet365 讓分盤`);
    source = ACTION_URL; official = false;
    // 同一場沿用舊鍵（官網隊名「LA Kings」≠ Action Network「Los Angeles Kings」），讓分歷史接續、換邊照算
    for (const game of complete) {
      const hit = Object.entries(previousGames).find(([, old]) => old && old.awayZh === game.awayZh && old.homeZh === game.homeZh &&
        Math.abs(Number(old.startTime) - game.startTime) <= 2 * 3600e3);
      if (hit) { game.startTime = Number(hit[1].startTime); game.away = hit[1].away; game.home = hit[1].home; }
    }
  }

  const fetchDetails = !official || options.fetchDetails === false || (options.fetchText && options.fetchDetails == null)
    ? null
    : (options.fetchDetails || fetchOfficialDetails);
  if (fetchDetails) {
    for (const game of complete.filter((item) => !item.total).slice(0, 8)) {
      try {
        const detailHtml = await fetchDetails(game);
        if (!detailHtml) continue;
        const detail = parseBet365NhlHub(detailHtml).find((item) =>
          item.away === game.away && item.home === game.home && Math.abs(item.startTime - game.startTime) <= 60000
        );
        if (detail && detail.total) {
          game.total = detail.total;
          if (detail.fixtureIds && detail.fixtureIds.total) game.fixtureIds.total = detail.fixtureIds.total;
        }
      } catch (_) {
        // Hub 的獨贏／讓分仍是有效官方資料；詳情頁失敗只讓大小分進備援層。
      }
    }
  }

  const observedAt = new Date(now).toISOString();
  // 開賽前最後 30 秒開始凍結，避免頁面切成場中盤後把即時盤誤當賽前收盤。
  const upcoming = complete.filter((game) => Number(game.startTime) > now + 30000 &&
    (official || !game.status || game.status === 'scheduled'));
  const games = {};

  for (const game of upcoming) {
    const key = stableGameKey(game);
    games[key] = mergeBet365Game(previousGames[key], game, observedAt);
  }
  const cutoff = now - THREE_DAYS_MS;
  for (const [key, game] of Object.entries(previousGames)) {
    if (!games[key] && Number(game && game.startTime) >= cutoff) games[key] = game;
  }

  return {
    provider: official ? 'bet365-official' : 'actionnetwork-bet365',
    strategy: 'official-first',
    updated: observedAt,
    source,
    health: {
      status: official ? 'ok' : 'fallback',
      gameCount: upcoming.length,
      marketCount: upcoming.reduce((count, game) => count + ['ml', 'hd', 'total'].filter((key) => game[key]).length, 0),
      totalCount: upcoming.filter((game) => game.total).length,
    },
    games,
  };
}

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function saveAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const json = `${JSON.stringify(value, null, 1)}\n`;
  JSON.parse(json);
  fs.writeFileSync(temp, json);
  fs.renameSync(temp, file);
}

async function updateOddsFile(options = {}) {
  const out = options.out || OUT;
  const previous = loadJSON(out, { games: {} });
  const output = await collectBet365NhlOdds({
    previous,
    fetchText: options.fetchText,
    now: options.now,
  });
  saveAtomic(out, output);
  return output;
}

async function main() {
  try {
    const output = await updateOddsFile();
    console.log(`Bet365 NHL：成功 ${output.health.gameCount} 場、${output.health.marketCount} 個市場`);
  } finally {
    await sidecar.shutdown();
  }
}

module.exports = {
  HUB_URL,
  OUT,
  parseBet365NhlHub,
  parseActionNetworkNhl,
  collectBet365NhlOdds,
  saveAtomic,
  updateOddsFile,
};

if (require.main === module) main().catch((error) => {
  console.error(`Bet365 NHL 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
