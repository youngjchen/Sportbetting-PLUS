'use strict';

const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');

const HUB_URL = 'https://www.bet365.com/hub/en-us/baseball/mlb';
const MATCH_TOL_MIN = 20;
const ACTIVE_WINDOW_HOURS = 24;
const START_GRACE_MIN = 30;

const TEAM_CN = {
  'ARI Diamondbacks': '響尾蛇',
  'PIT Pirates': '海盜',
  'BAL Orioles': '金鶯',
  'DET Tigers': '老虎',
  'PHI Phillies': '費城人',
  'MIA Marlins': '馬林魚',
  'TEX Rangers': '遊騎兵',
  'TB Rays': '光芒',
  'TOR Blue Jays': '藍鳥',
  'WAS Nationals': '國民',
  'ATL Braves': '勇士',
  'NY Mets': '大都會',
  'CLE Guardians': '守護者',
  'CIN Reds': '紅人',
  'KC Royals': '皇家',
  'MIN Twins': '雙城',
  'NY Yankees': '洋基',
  'CHI White Sox': '白襪',
  'CHI Cubs': '小熊',
  'STL Cardinals': '紅雀',
  'HOU Astros': '太空人',
  'LA Angels': '天使',
  'BOS Red Sox': '紅襪',
  Athletics: '運動家',
  'COL Rockies': '落磯',
  'SD Padres': '教士',
  'MIL Brewers': '釀酒人',
  'SF Giants': '巨人',
  'SEA Mariners': '水手',
  'LA Dodgers': '道奇',
};

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function hkOdds(value) {
  const decimal = Number(value);
  return Number.isFinite(decimal) ? round2(decimal - 1) : null;
}

function firstNumber(text) {
  const match = String(text || '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function taiwanISO(utc) {
  const parsed = Date.parse(utc);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed + 8 * 3600e3);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+08:00`;
}

function marketLinks($, element) {
  const result = {};
  $(element).find('[data-item-variant]').each((_, link) => {
    const variant = $(link).attr('data-item-variant');
    if (!variant || result[variant]) return;
    result[variant] = {
      decimal: Number($(link).attr('data-item-odds')),
      line: firstNumber($(link).text()),
    };
  });
  return result;
}

function parseBet365Hub(html) {
  const $ = cheerio.load(String(html || ''));
  const games = new Map();

  $('li[data-item-category2="MLB"][data-item-name]').each((_, element) => {
    const name = $(element).attr('data-item-name') || '';
    const parts = name.split(/\s+@\s+/);
    if (parts.length !== 2) return;
    const awayTeam = TEAM_CN[parts[0].trim()];
    const homeTeam = TEAM_CN[parts[1].trim()];
    const startISO = taiwanISO($(element).find('[data-utc]').first().attr('data-utc'));
    const fixtureId = $(element).attr('data-fixture-id');
    if (!awayTeam || !homeTeam || !startISO || !fixtureId) return;

    // Bet365 對同一場的獨贏、讓分、大小使用三個不同 fixture id；
    // 真正的跨市場鍵必須是「主客隊＋開賽時間」。
    const key = `${startISO}|${awayTeam}|${homeTeam}`;
    const game = games.get(key) || { fixtureId, awayTeam, homeTeam, startISO };
    const category = $(element).attr('data-item-category3');
    const links = marketLinks($, element);

    if (category === 'Money Line' && links['Away Win'] && links['Home Win']) {
      const away = links['Away Win'].decimal;
      const home = links['Home Win'].decimal;
      if (Number.isFinite(away) && Number.isFinite(home)) {
        game.fixtureId = fixtureId;
        game.ml = { away, home };
      }
    } else if (category === 'Run Line' && links['Away Win'] && links['Home Win']) {
      const homeLine = links['Home Win'].line;
      const away = hkOdds(links['Away Win'].decimal);
      const home = hkOdds(links['Home Win'].decimal);
      if (Number.isFinite(homeLine) && away != null && home != null) {
        game.hd = {
          away,
          home,
          // odds_log 的既有語義：正數＝主隊讓，負數＝客隊讓。
          line: -homeLine,
        };
      }
    } else if (category === 'Game Totals' && links.Over && links.Under) {
      const line = links.Over.line;
      const over = hkOdds(links.Over.decimal);
      const under = hkOdds(links.Under.decimal);
      if (Number.isFinite(line) && over != null && under != null) {
        game.ou = {
          over,
          under,
          line,
        };
      }
    }
    games.set(key, game);
  });

  return [...games.values()].sort((a, b) => a.startISO.localeCompare(b.startISO));
}

async function fetchBet365Hub() {
  const html = await sidecar.fetchText(HUB_URL, {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  }, 90000);
  const games = parseBet365Hub(html);
  const complete = games.filter((game) => game.ml && game.hd && game.ou);
  if (complete.length < 10) {
    throw new Error(`Bet365 官方頁解析不完整：三市場完整 ${complete.length}/${games.length} 場`);
  }
  return games;
}

function sameGame(match, game) {
  return match.league === 'mlb' &&
    match.awayTeam === game.awayTeam &&
    match.homeTeam === game.homeTeam &&
    String(match.startISO).slice(0, 10) === game.startISO.slice(0, 10);
}

function minuteDiff(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 60000;
}

function inCaptureWindow(game, now) {
  const start = Date.parse(game.startISO);
  return Number.isFinite(start) &&
    start < now + ACTIVE_WINDOW_HOURS * 3600e3 &&
    start > now - START_GRACE_MIN * 60000;
}

function augmentUpcoming(upcoming, officialGames, now = Date.now()) {
  const result = upcoming.slice();
  for (const game of officialGames) {
    if (!inCaptureWindow(game, now)) continue;
    const candidates = result.filter((match) => sameGame(match, game));
    let exact = null;
    let best = Infinity;
    for (const match of candidates) {
      const diff = minuteDiff(match.startISO, game.startISO);
      if (diff < best) {
        best = diff;
        exact = match;
      }
    }
    if (exact && best <= MATCH_TOL_MIN) {
      exact.bet365Fixture = game;
      continue;
    }

    const hhmm = game.startISO.slice(11, 16);
    const base = candidates[0];
    const id = base ? `${base.id}@${hhmm.replace(':', '')}` : `b365:${game.fixtureId}`;
    result.push({
      id,
      league: 'mlb',
      time: `${game.startISO.slice(0, 10)} ${hhmm}`,
      startISO: game.startISO,
      started: Date.parse(game.startISO) <= now,
      homeRaw: game.homeTeam,
      awayRaw: game.awayTeam,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      bet365Fixture: game,
      officialFallback: true,
    });
  }
  return result.sort((a, b) => String(a.startISO).localeCompare(String(b.startISO)));
}

function mergeOfficialRows(existing, snapshot, stamp) {
  const current = Array.isArray(existing) ? existing : [];
  const first = current[0];
  const keys = Object.keys(snapshot);
  if (first && keys.every((key) => String(first[key]) === String(snapshot[key]))) return existing;
  return [Object.assign({}, snapshot, { ts: stamp, src: 'bet365_official' }), ...current].slice(0, 200);
}

function officialRowsToHdTs(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.ts && row.line != null)
    .map((row) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(row.ts);
      return match ? {
        line: Number(row.line),
        live: false,
        hhmm: `${match[4]}:${match[5]}`,
        md: `${Number(match[2])}-${Number(match[3])}`,
      } : null;
    })
    .filter(Boolean)
    .reverse();
}

module.exports = {
  HUB_URL,
  TEAM_CN,
  parseBet365Hub,
  fetchBet365Hub,
  augmentUpcoming,
  mergeOfficialRows,
  officialRowsToHdTs,
  shutdown: sidecar.shutdown,
};
