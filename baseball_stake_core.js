'use strict';

const LEAGUES = new Set(['MLB', 'NPB', 'KBO', 'CPBL']);
const MATCH_TOLERANCE_MS = 2 * 60 * 60 * 1000;
const PRE_START_CUTOFF_MS = 30 * 1000;
const MATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TEAM_ALIASES = {
  // MLB
  'Arizona Diamondbacks': '響尾蛇', 'Pittsburgh Pirates': '海盜',
  'Baltimore Orioles': '金鶯', 'Detroit Tigers': '老虎',
  'Philadelphia Phillies': '費城人', 'Miami Marlins': '馬林魚',
  'Texas Rangers': '遊騎兵', 'Tampa Bay Rays': '光芒',
  'Toronto Blue Jays': '藍鳥', 'Washington Nationals': '國民',
  'Atlanta Braves': '勇士', 'New York Mets': '大都會',
  'Cleveland Guardians': '守護者', 'Cincinnati Reds': '紅人',
  'Kansas City Royals': '皇家', 'Minnesota Twins': '雙城',
  'New York Yankees': '洋基', 'Chicago White Sox': '白襪',
  'Chicago Cubs': '小熊', 'St.Louis Cardinals': '紅雀', 'St. Louis Cardinals': '紅雀',
  'Houston Astros': '太空人', 'Los Angeles Angels': '天使',
  'Boston Red Sox': '紅襪', 'Athletics': '運動家', 'Oakland Athletics': '運動家',
  'Colorado Rockies': '落磯', 'San Diego Padres': '教士',
  'Milwaukee Brewers': '釀酒人', 'San Francisco Giants': '巨人',
  'Seattle Mariners': '水手', 'Los Angeles Dodgers': '道奇',
  // NPB
  'Yomiuri Giants': '巨人', 'Hanshin Tigers': '阪神',
  'Yokohama BayStars': '橫濱', 'Yokohama DeNA BayStars': '橫濱',
  'Hiroshima Carp': '廣島', 'Hiroshima Toyo Carp': '廣島',
  'Yakult Swallows': '養樂多', 'Tokyo Yakult Swallows': '養樂多',
  'Chunichi Dragons': '中日', 'Fukuoka SoftBank Hawks': '軟銀',
  'Fukuoka S. Hawks': '軟銀', 'SoftBank Hawks': '軟銀',
  'Nippon Ham Fighters': '火腿', 'Hokkaido Nippon-Ham Fighters': '火腿',
  'Orix Buffaloes': '歐力士', 'Chiba Lotte Marines': '羅德',
  'Seibu Lions': '西武', 'Saitama Seibu Lions': '西武',
  'Rakuten Gold. Eagles': '樂天', 'Rakuten Golden Eagles': '樂天',
  'Tohoku Rakuten Golden Eagles': '樂天',
  // KBO
  'Doosan Bears': '斗山熊', 'SSG Landers': '登陸者',
  'Kiwoom Heroes': '培證', 'LG Twins': '雙子', 'KT Wiz': '巫師', 'KT Wiz Suwon': '巫師',
  'NC Dinos': '恐龍', 'Samsung Lions': '三星獅',
  'Hanwha Eagles': '華老鷹', 'KIA Tigers': '起亞虎', 'Lotte Giants': '樂天',
  // CPBL
  'CTBC Brothers': '兄弟', 'Chinatrust Brothers': '兄弟',
  'TSG Hawks': '台鋼', 'Tainan TSG GhostHawks': '台鋼',
  'Wei Chuan Dragons': '味全', 'Fubon Guardians': '富邦',
  'Rakuten Monkeys': '樂天', 'Uni Lions': '統一', 'Uni-President Lions': '統一',
  // Known Chinese aliases in the board feeds.
  '韓華鷹': '華老鷹', '韓華': '華老鷹', '橫濱DeNA': '橫濱', '橫濱海灣之星': '橫濱',
};

function teamKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');
}

const ALIASES_BY_KEY = Object.fromEntries(Object.entries(TEAM_ALIASES).map(([name, value]) => [teamKey(name), value]));

function normalizeLeague(value) {
  const text = String(value || '').toUpperCase();
  return LEAGUES.has(text) ? text : '';
}

function normalizeTeam(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return ALIASES_BY_KEY[teamKey(raw)] || raw;
}

function taiwanStart(row) {
  const date = String(row && row.date || '').slice(0, 10);
  const time = String(row && (row.time || row.gameTime) || '').match(/(\d{1,2}):(\d{2})/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) return NaN;
  return Date.parse(`${date}T${String(Number(time[1])).padStart(2, '0')}:${time[2]}:00+08:00`);
}

function buildOfficialGames(rows) {
  const rejected = new Set(['finished', 'ended', 'cancelled', 'canceled', 'postponed']);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const league = normalizeLeague(row && row.league);
    const scheduledMs = taiwanStart(row);
    if (!league || !row || !row.officialId || !Number.isFinite(scheduledMs)) return null;
    if (rejected.has(String(row.status || '').toLowerCase())) return null;
    return {
      league,
      officialId: String(row.officialId),
      scheduledStart: new Date(scheduledMs).toISOString(),
      scheduledMs,
      away: normalizeTeam(row.awayTeam || row.away),
      home: normalizeTeam(row.homeTeam || row.home),
      date: String(row.date || '').slice(0, 10),
      time: new Date(scheduledMs + 8 * 3600000).toISOString().slice(11, 16),
    };
  }).filter((game) => game && game.away && game.home);
}

function fixtureTeams(name) {
  const parts = String(name || '').split(/\s+-\s+/).map((part) => normalizeTeam(part)).filter(Boolean);
  return parts.length === 2 ? { home: parts[0], away: parts[1] } : null;
}

function matchOfficialGame(fixture, officialGames) {
  const league = normalizeLeague(fixture && fixture.league);
  const teams = fixtureTeams(fixture && fixture.name);
  const start = Number(fixture && (fixture.startTime || fixture.date));
  if (!league || !teams || !Number.isFinite(start)) return null;
  const candidates = (Array.isArray(officialGames) ? officialGames : []).filter((game) =>
    game.league === league && game.away === teams.away && game.home === teams.home
  ).map((game) => ({ game, diff: Math.abs(game.scheduledMs - start) }))
    .filter((entry) => entry.diff <= MATCH_TOLERANCE_MS)
    .sort((a, b) => a.diff - b.diff);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].diff === candidates[1].diff) return null;
  return candidates[0].game;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function absoluteOrNull(value) {
  const number = finite(value);
  return number == null ? null : Math.abs(number);
}

function validOddsPair(value, left, right) {
  const a = finite(value && value[left]);
  const b = finite(value && value[right]);
  return a != null && b != null && a > 1 && b > 1 ? { [left]: a, [right]: b } : null;
}

function betExplorerStakeHandicap(game) {
  if (!game || String(game.bookmaker || '') !== 'Stake.com') return null;
  const market = game.markets && game.markets.hd;
  const snapshot = market && (market.active || market.close || market.open);
  if (!snapshot || absoluteOrNull(snapshot.line) !== 1.5) return null;
  return validOddsPair(snapshot, 'away', 'home');
}

function normalizeBaseballMarkets(leagueValue, markets, fallbackGame) {
  const league = normalizeLeague(leagueValue);
  const hd = markets && markets.hd;
  const favorite = hd && (hd.favorite === 'away' || hd.favorite === 'home') ? hd.favorite : null;
  const rawLine = absoluteOrNull(hd && hd.line);
  const isMlbOne = league === 'MLB' && rawLine === 1;
  let handicapOdds = validOddsPair(hd, 'away', 'home');
  let handicapSource = handicapOdds ? 'stake-official' : null;
  const canonicalLine = isMlbOne ? 1.5 : rawLine;
  if (isMlbOne) {
    handicapOdds = betExplorerStakeHandicap(fallbackGame);
    handicapSource = handicapOdds ? 'betexplorer-stake-row' : null;
  }
  const totalLine = absoluteOrNull(markets && markets.total && markets.total.line);
  const totalOdds = validOddsPair(markets && markets.total, 'over', 'under');
  const total = totalLine != null ? { line: totalLine, ...(totalOdds || { over: null, under: null }) } : null;
  const moneyline = validOddsPair(markets && markets.ml, 'away', 'home');
  return {
    favorite,
    rawLine,
    canonicalLine,
    handicapOdds,
    moneyline,
    total,
    sources: {
      direction: favorite ? 'stake-official' : null,
      handicapOdds: handicapSource,
      total: total ? 'stake-official' : null,
      moneyline: moneyline ? 'stake-official' : null,
    },
    partial: !favorite || canonicalLine == null || !handicapOdds || !total,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function snapshotOf(game) {
  return {
    observedAt: game.observedAt,
    favorite: game.favorite,
    rawLine: game.rawLine,
    canonicalLine: game.canonicalLine,
    handicapOdds: clone(game.handicapOdds),
    moneyline: clone(game.moneyline),
    total: clone(game.total),
    sources: clone(game.sources),
    partial: !!game.partial,
  };
}

function comparableSnapshot(game) {
  const snapshot = snapshotOf(game);
  delete snapshot.observedAt;
  return JSON.stringify(snapshot);
}

function mergeBaseballObservation(previous, observation) {
  const prev = previous && typeof previous === 'object' ? clone(previous) : null;
  const next = observation && typeof observation === 'object' ? clone(observation) : null;
  if (!next) return prev;
  const start = Date.parse(next.scheduledStart || (prev && prev.scheduledStart) || '');
  const observed = Date.parse(next.observedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(observed)) return prev;
  const cutoff = start - PRE_START_CUTOFF_MS;
  if (observed > cutoff) {
    if (!prev) return null;
    prev.frozenAt = prev.frozenAt || new Date(cutoff).toISOString();
    return prev;
  }

  if (prev) {
    for (const field of ['favorite', 'rawLine', 'canonicalLine']) {
      if (next[field] == null && prev[field] != null) next[field] = prev[field];
    }
    if (!next.handicapOdds && prev.handicapOdds) next.handicapOdds = clone(prev.handicapOdds);
    if (!next.moneyline && prev.moneyline) next.moneyline = clone(prev.moneyline);
    if (!next.total && prev.total) next.total = clone(prev.total);
    next.sources = { ...(prev.sources || {}), ...(next.sources || {}) };
    for (const field of ['direction', 'handicapOdds', 'moneyline', 'total']) {
      if (!(observation.sources && observation.sources[field]) && prev.sources && prev.sources[field]) {
        next.sources[field] = prev.sources[field];
      }
    }
  }

  const history = prev && Array.isArray(prev.history) ? prev.history.slice() : [];
  const transitions = prev && Array.isArray(prev.favoriteTransitions) ? prev.favoriteTransitions.slice() : [];
  const previousSnapshot = history.length ? history[history.length - 1] : prev;
  if (!previousSnapshot || comparableSnapshot(previousSnapshot) !== comparableSnapshot(next)) {
    if (previousSnapshot && previousSnapshot.favorite && next.favorite && previousSnapshot.favorite !== next.favorite) {
      transitions.push({ at: next.observedAt, from: previousSnapshot.favorite, to: next.favorite });
    }
    history.push(snapshotOf(next));
  }

  return {
    ...(prev || {}),
    ...next,
    frozenAt: null,
    favoriteFlipCount: transitions.length,
    favoriteTransitions: transitions.slice(-120),
    history: history.slice(-240),
  };
}

function buildBaseballFeed(previous, officialRows, leagueResults, observedAt) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const matches = clone(prev.matches || {});
  const leagues = clone(prev.leagues || {});
  const results = leagueResults && typeof leagueResults === 'object' ? leagueResults : {};
  for (const league of LEAGUES) {
    const result = results[league];
    if (!result) continue;
    if (result.error) {
      leagues[league] = {
        ...(leagues[league] || {}), status: 'partial', error: String(result.error), lastAttemptAt: observedAt,
      };
      continue;
    }
    const observations = Array.isArray(result.observations) ? result.observations : [];
    for (const item of observations) {
      if (!item || !item.officialId) continue;
      const merged = mergeBaseballObservation(matches[item.officialId], item);
      if (merged) matches[item.officialId] = merged;
    }
    leagues[league] = {
      status: observations.some((item) => item && item.partial) ? 'partial' : 'ok',
      lastSuccessAt: observedAt, lastAttemptAt: observedAt, error: null,
      matched: observations.length,
    };
  }

  const now = Date.parse(observedAt || '');
  if (Number.isFinite(now)) {
    for (const [key, game] of Object.entries(matches)) {
      const start = Date.parse(game && game.scheduledStart || '');
      if (Number.isFinite(start) && now - start > MATCH_RETENTION_MS) {
        delete matches[key];
      } else if (Number.isFinite(start) && now > start - PRE_START_CUTOFF_MS) {
        game.frozenAt = game.frozenAt || new Date(start - PRE_START_CUTOFF_MS).toISOString();
      }
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: observedAt,
    officialScheduleCount: buildOfficialGames(officialRows).length,
    leagues,
    matches,
  };
}

module.exports = {
  PRE_START_CUTOFF_MS,
  normalizeLeague,
  normalizeTeam,
  buildOfficialGames,
  matchOfficialGame,
  normalizeBaseballMarkets,
  mergeBaseballObservation,
  buildBaseballFeed,
};
