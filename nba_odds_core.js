'use strict';

const cheerio = require('cheerio');

const NBA_TEAMS = Object.freeze({
  'Atlanta Hawks': ['老鷹', 'ATL'],
  'Boston Celtics': ['塞爾提克', 'BOS'],
  'Brooklyn Nets': ['籃網', 'BKN'],
  'Charlotte Hornets': ['黃蜂', 'CHA'],
  'Chicago Bulls': ['公牛', 'CHI'],
  'Cleveland Cavaliers': ['騎士', 'CLE'],
  'Dallas Mavericks': ['獨行俠', 'DAL'],
  'Denver Nuggets': ['金塊', 'DEN'],
  'Detroit Pistons': ['活塞', 'DET'],
  'Golden State Warriors': ['勇士', 'GSW'],
  'Houston Rockets': ['火箭', 'HOU'],
  'Indiana Pacers': ['溜馬', 'IND'],
  'LA Clippers': ['快艇', 'LAC'],
  'Los Angeles Clippers': ['快艇', 'LAC'],
  'Los Angeles Lakers': ['湖人', 'LAL'],
  'Memphis Grizzlies': ['灰熊', 'MEM'],
  'Miami Heat': ['熱火', 'MIA'],
  'Milwaukee Bucks': ['公鹿', 'MIL'],
  'Minnesota Timberwolves': ['灰狼', 'MIN'],
  'New Orleans Pelicans': ['鵜鶘', 'NOP'],
  'New York Knicks': ['尼克', 'NYK'],
  'Oklahoma City Thunder': ['雷霆', 'OKC'],
  'Orlando Magic': ['魔術', 'ORL'],
  'Philadelphia 76ers': ['76人', 'PHI'],
  'Phoenix Suns': ['太陽', 'PHX'],
  'Portland Trail Blazers': ['拓荒者', 'POR'],
  'Sacramento Kings': ['國王', 'SAC'],
  'San Antonio Spurs': ['馬刺', 'SAS'],
  'Toronto Raptors': ['暴龍', 'TOR'],
  'Utah Jazz': ['爵士', 'UTA'],
  'Washington Wizards': ['巫師', 'WAS'],
});

const TEAM_CODE_BY_ZH = Object.freeze(Object.fromEntries(
  Object.values(NBA_TEAMS).map(([name, code]) => [name, code])
));

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function number(value) {
  const match = String(value == null ? '' : value).replace(/,/g, '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function translateNbaTeam(value) {
  const text = clean(value);
  const direct = NBA_TEAMS[text];
  if (direct) return direct[0];
  const key = Object.keys(NBA_TEAMS).find((name) => text === name || text.endsWith(` ${name}`));
  if (!key) throw new Error(`未知 NBA 隊名：${text || '(空白)'}`);
  return NBA_TEAMS[key][0];
}

function teamCode(value) {
  const code = TEAM_CODE_BY_ZH[clean(value)];
  if (!code) throw new Error(`未知 NBA 板面隊名：${clean(value) || '(空白)'}`);
  return code;
}

function parseClock(value) {
  const match = /(?:(AM|PM)\s*)?(\d{1,2}):(\d{2})/i.exec(clean(value));
  if (!match) return null;
  let hour = Number(match[2]);
  const ap = String(match[1] || '').toUpperCase();
  if (ap === 'PM' && hour < 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[3]}`;
}

function sidePrice(text, sideWord) {
  const normalized = clean(text).replace(/，/g, ',');
  const match = new RegExp(`${sideWord}\\s*(?:受讓)?([+-]?\\d+(?:\\.\\d+)?)\\s*,\\s*(\\d+(?:\\.\\d+)?)`).exec(normalized);
  return match ? { line: Number(match[1]), odds: Number(match[2]) } : null;
}

function plainPrice(text, sideWord) {
  const match = new RegExp(`${sideWord}\\s*(\\d+(?:\\.\\d+)?)`).exec(clean(text));
  return match ? Number(match[1]) : null;
}

function totalPrice(text, word) {
  const normalized = clean(text).replace(/，/g, ',');
  const match = new RegExp(`${word}\\s*(\\d+(?:\\.\\d+)?)\\s*,\\s*(\\d+(?:\\.\\d+)?)`).exec(normalized);
  return match ? { line: Number(match[1]), odds: Number(match[2]) } : null;
}

function parseTaiwanResult(html, date) {
  const $ = cheerio.load(String(html || ''));
  const grouped = new Map();
  $('table.gamedata-results tr[gameid]').each((_, row) => {
    const gid = String($(row).attr('gameid') || '').trim();
    if (!gid) return;
    if (!grouped.has(gid)) grouped.set(gid, []);
    grouped.get(gid).push($(row));
  });
  const games = [];
  for (const [gid, rows] of grouped) {
    if (rows.length < 2) continue;
    const away = clean(rows[0].find('td.td-teaminfo').text());
    const home = clean(rows[1].find('td.td-teaminfo').text());
    if (!away || !home) continue;
    const time = parseClock(rows[0].find('td.td-gameinfo h4').text()) || '00:00';
    const awayHd = sidePrice(rows[0].find('td.td-bank-bet01').text(), '客');
    const homeHd = sidePrice(rows[1].find('td.td-bank-bet01').text(), '主');
    const awayMl = plainPrice(rows[0].find('td.td-bank-bet03').text(), '客');
    const homeMl = plainPrice(rows[1].find('td.td-bank-bet03').text(), '主');
    const over = totalPrice(rows[0].find('td.td-bank-bet02').text(), '大');
    const under = totalPrice(rows[1].find('td.td-bank-bet02').text(), '小');
    const signedAway = awayHd ? awayHd.line : homeHd ? -homeHd.line : null;
    const favorite = Number.isFinite(signedAway) ? (signedAway < 0 ? 'away' : 'home') : null;
    const line = Number.isFinite(signedAway) ? Math.abs(signedAway) : null;
    const teamText = rows.map((row) => clean(row.find('td.td-teaminfo').text())).join(' ');
    const score = /(\d+)\s*V\.?S\.?\s*(\d+)/i.exec(teamText);
    const ymd = String(date || '').replace(/-/g, '');
    games.push({
      officialId: `NBA_${ymd}_${teamCode(away)}@${teamCode(home)}`,
      gid,
      league: 'NBA', date, time, away, home,
      awayScore: score ? Number(score[1]) : null,
      homeScore: score ? Number(score[2]) : null,
      hdFav: favorite,
      hdVal: line,
      hdSrc: favorite ? '運彩' : null,
      totLine: over ? over.line : under ? under.line : null,
      mlOffered: Number.isFinite(awayMl) && Number.isFinite(homeMl),
      taiwan: {
        ml: { away: awayMl, home: homeMl },
        hd: { favorite, line, away: awayHd && awayHd.odds, home: homeHd && homeHd.odds },
        ou: { line: over ? over.line : under ? under.line : null, over: over && over.odds, under: under && under.odds },
      },
    });
  }
  return games;
}

function flattenMarkets(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenMarkets(item, out);
  } else if (value && typeof value === 'object') {
    if (typeof value.name === 'string' && Array.isArray(value.outcomes)) out.push(value);
    for (const [key, nested] of Object.entries(value)) {
      if (key !== 'outcomes') flattenMarkets(nested, out);
    }
  }
  return out;
}

function fixtureHomeAway(fixture) {
  const parts = clean(fixture && fixture.name).split(/\s+-\s+/);
  if (parts.length !== 2) throw new Error(`STAKE NBA 賽事名稱無法辨識：${clean(fixture && fixture.name)}`);
  return { homeName: parts[0], awayName: parts[1] };
}

function outcomeFor(market, teamName) {
  const key = clean(teamName).toLowerCase();
  return (market.outcomes || []).find((outcome) => clean(outcome && outcome.name).toLowerCase().startsWith(key));
}

function signedLine(outcome) {
  const match = clean(outcome && outcome.name).match(/\(([+-]?\d+(?:\.\d+)?)\)/);
  return match ? Number(match[1]) : null;
}

function validOdds(value) {
  return Number.isFinite(Number(value)) && Number(value) > 1;
}

function balanced(candidates) {
  return candidates.filter((item) => validOdds(item.left) && validOdds(item.right))
    .sort((a, b) => Math.abs(a.left - a.right) - Math.abs(b.left - b.right))[0] || null;
}

function parseStakeMarkets(groups, fixture) {
  const { homeName, awayName } = fixtureHomeAway(fixture);
  const markets = flattenMarkets(groups).filter((market) => !market.status || market.status === 'active');
  const winner = markets.find((market) => /^Winner\s*\(Incl\. Overtime\)$/i.test(clean(market.name)));
  const homeWin = winner && outcomeFor(winner, homeName);
  const awayWin = winner && outcomeFor(winner, awayName);

  const handicapCandidates = markets
    .filter((market) => /^Handicap\s*\(Incl\. Overtime\)$/i.test(clean(market.name)))
    .map((market) => {
      const home = outcomeFor(market, homeName);
      const away = outcomeFor(market, awayName);
      const homeLine = signedLine(home);
      const awayLine = signedLine(away);
      if (!home || !away || !Number.isFinite(homeLine) || !Number.isFinite(awayLine) ||
          Math.sign(homeLine) === Math.sign(awayLine) || Math.abs(homeLine) !== Math.abs(awayLine)) return null;
      return { market, home, away, homeLine, awayLine, left: Number(home.odds), right: Number(away.odds) };
    }).filter(Boolean);
  const handicap = balanced(handicapCandidates);

  const totalCandidates = markets
    .filter((market) => /^Total\s*\(Incl\. Overtime\)$/i.test(clean(market.name)))
    .map((market) => {
      const over = (market.outcomes || []).find((outcome) => /^Over\b/i.test(clean(outcome && outcome.name)));
      const under = (market.outcomes || []).find((outcome) => /^Under\b/i.test(clean(outcome && outcome.name)));
      const line = number(clean(market.specifiers).replace(/^.*total=/i, '')) || number(over && over.name) || number(under && under.name);
      return over && under && Number.isFinite(line)
        ? { market, over, under, line: Math.abs(line), left: Number(over.odds), right: Number(under.odds) }
        : null;
    }).filter(Boolean);
  const total = balanced(totalCandidates);

  const result = {
    awayName, homeName,
    away: translateNbaTeam(awayName),
    home: translateNbaTeam(homeName),
  };
  if (awayWin && homeWin && validOdds(awayWin.odds) && validOdds(homeWin.odds)) {
    result.moneyline = { away: Number(awayWin.odds), home: Number(homeWin.odds) };
  }
  if (handicap) {
    result.favorite = handicap.awayLine < 0 ? 'away' : 'home';
    result.line = Math.abs(handicap.awayLine);
    result.handicapOdds = { away: Number(handicap.away.odds), home: Number(handicap.home.odds) };
  }
  if (total) result.total = { line: total.line, over: Number(total.over.odds), under: Number(total.under.odds) };
  return result;
}

function pregameStartMs(game) {
  const date = clean(game && game.date);
  const time = clean(game && game.time).slice(0, 5);
  return Date.parse(`${date}T${time || '00:00'}:00+08:00`);
}

function matchPregameGame(stake, games, toleranceMs = 12 * 3600000) {
  const start = Date.parse(stake && stake.scheduledStart || '');
  if (!Number.isFinite(start)) return null;
  const candidates = (games || []).filter((game) => game && game.away === stake.away && game.home === stake.home)
    .map((game) => ({ game, diff: Math.abs(pregameStartMs(game) - start) }))
    .filter((item) => Number.isFinite(item.diff) && item.diff <= toleranceMs)
    .sort((a, b) => a.diff - b.diff);
  return candidates[0] ? candidates[0].game : null;
}

function isPregameObservation(scheduledStart, observedAt) {
  const start = Date.parse(scheduledStart || '');
  const observed = Date.parse(observedAt || '');
  return Number.isFinite(start) && Number.isFinite(observed) && start - observed > 30000;
}

function marketSnapshot(game, observedAt) {
  return {
    observedAt,
    favorite: game.favorite || null,
    line: game.line == null ? null : Number(game.line),
    moneyline: game.moneyline || null,
    handicapOdds: game.handicapOdds || null,
    total: game.total || null,
  };
}

function stableSnapshot(value) {
  return JSON.stringify({
    favorite: value && value.favorite || null,
    line: !value || value.line == null ? null : Number(value.line),
    moneyline: value && value.moneyline || null,
    handicapOdds: value && value.handicapOdds || null,
    total: value && value.total || null,
  });
}

function mergeStakeObservation(previous, current, observedAt) {
  const old = previous && typeof previous === 'object' ? previous : {};
  const next = current && typeof current === 'object' ? current : {};
  if (!isPregameObservation(next.scheduledStart || old.scheduledStart, observedAt)) {
    return { ...old, frozenAt: old.frozenAt || observedAt };
  }
  const merged = {
    ...old,
    ...next,
    moneyline: next.moneyline || old.moneyline || null,
    handicapOdds: next.handicapOdds || old.handicapOdds || null,
    total: next.total || old.total || null,
    favorite: next.favorite || old.favorite || null,
    line: next.line == null ? (old.line == null ? null : old.line) : next.line,
    observedAt,
    frozenAt: null,
  };
  const history = Array.isArray(old.history) ? old.history.slice() : [];
  const snapshot = marketSnapshot(merged, observedAt);
  if (!history.length || stableSnapshot(history[history.length - 1]) !== stableSnapshot(snapshot)) history.push(snapshot);
  merged.history = history.slice(-240);
  return merged;
}

module.exports = {
  NBA_TEAMS,
  TEAM_CODE_BY_ZH,
  translateNbaTeam,
  parseTaiwanResult,
  parseStakeMarkets,
  matchPregameGame,
  mergeStakeObservation,
  isPregameObservation,
  fixtureHomeAway,
  flattenMarkets,
};
