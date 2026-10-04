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

async function collectBet365NhlOdds(options = {}) {
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

  const fetchDetails = options.fetchDetails === false || (options.fetchText && options.fetchDetails == null)
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

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const observedAt = new Date(now).toISOString();
  // 開賽前最後 30 秒開始凍結，避免頁面切成場中盤後把即時盤誤當賽前收盤。
  const upcoming = complete.filter((game) => Number(game.startTime) > now + 30000);
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { games: {} };
  const previousGames = previous.games && typeof previous.games === 'object' ? previous.games : {};
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
    provider: 'bet365-official',
    strategy: 'official-first',
    updated: observedAt,
    source: HUB_URL,
    health: {
      status: 'ok',
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
  collectBet365NhlOdds,
  saveAtomic,
  updateOddsFile,
};

if (require.main === module) main().catch((error) => {
  console.error(`Bet365 NHL 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
