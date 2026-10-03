'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');
const { mergeStakeObservation } = require('./nba_odds_core.js');

const OUT = path.join(__dirname, 'data', 'nba_bet365_odds.json');
const PREGAME = path.join(__dirname, 'data', 'nba_pregame.json');
const SEASON = '26-27';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://nba.titan007.com/' };

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

async function collectBet365NbaOdds(options = {}) {
  const get = options.fetchText || fetchText;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const observedAt = new Date(now).toISOString();
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { matches: {} };
  const pregame = options.pregame && typeof options.pregame === 'object' ? options.pregame : { games: [] };
  const taiwanToday = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const taiwanTomorrow = new Date(now + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  const months = new Set([taiwanToday.slice(0, 7), taiwanTomorrow.slice(0, 7)]);
  const fixtures = [];
  for (const month of months) {
    const [year, value] = month.split('-').map(Number);
    const html = await get(`https://nba.titan007.com/jsData/matchResult/${SEASON}/l1_1_${year}_${value}.js`);
    fixtures.push(...parseMonth(html));
  }
  const targets = fixtures.filter((game) => [taiwanToday, taiwanTomorrow].includes(game.startBJ.slice(0, 10)));
  const matches = { ...(previous.matches || {}) };
  const failures = [];
  let succeeded = 0;
  for (const fixture of targets) {
    try {
      const card = (pregame.games || []).find((game) => game.date === fixture.startBJ.slice(0, 10) && game.away === fixture.away && game.home === fixture.home);
      if (!card) continue;
      const handicapHtml = await get(`https://nba.titan007.com/odds/Handicap.aspx?ScheId=${fixture.scheId}&companyId=8`);
      const totalHtml = await get(`https://nba.titan007.com/odds/OverDownChart.aspx?scheId=${fixture.scheId}&companyId=8&num=1&t=1`);
      let moneyline = null;
      try {
        const id = String(fixture.scheId);
        moneyline = parseMoneyline(await get(`https://nba.titan007.com/1x2/data1x2/${id[0]}/${id.slice(1, 3)}/${id}.js`));
      } catch (_) {}
      const handicapRows = keepPregameRows(parseChangeRows(handicapHtml), fixture.startBJ);
      const totalRows = keepPregameRows(parseChangeRows(totalHtml), fixture.startBJ);
      const handicap = handicapRows[0] || null;
      const total = totalRows[0] || null;
      const normalized = {
        provider: 'bet365-via-titan-company-8',
        officialId: card.officialId,
        scheId: fixture.scheId,
        scheduledStart: new Date(String(fixture.startBJ).replace(' ', 'T') + ':00+08:00').toISOString(),
        away: fixture.away,
        home: fixture.home,
        moneyline,
        favorite: handicap ? (Number(handicap.line) < 0 ? 'away' : 'home') : null,
        line: handicap ? Math.abs(Number(handicap.line)) : null,
        handicapOdds: handicap ? { away: handicap.o2 || null, home: handicap.o1 || null } : null,
        total: total ? { line: Math.abs(Number(total.line)), over: total.o1 || null, under: total.o2 || null } : null,
        raw: { handicap: handicapRows.slice(0, 240), total: totalRows.slice(0, 240) },
      };
      if (!normalized.moneyline && !normalized.handicapOdds && !normalized.total) continue;
      matches[card.officialId] = mergeStakeObservation(matches[card.officialId], normalized, observedAt);
      succeeded++;
    } catch (error) {
      failures.push({ scheId: fixture.scheId, error: String(error && error.message || error).slice(0, 240) });
    }
  }
  return {
    schemaVersion: 1,
    provider: 'bet365-via-titan-company-8',
    updated: observedAt,
    health: { status: failures.length ? 'partial' : 'ok', discovered: targets.length, succeeded, failures },
    matches,
  };
}

async function main() {
  try {
    const output = await collectBet365NbaOdds({ previous: loadJson(OUT, { matches: {} }), pregame: loadJson(PREGAME, { games: [] }) });
    saveAtomic(OUT, output);
    console.log(`Bet365 NBA：發現 ${output.health.discovered}、成功 ${output.health.succeeded}、失敗 ${output.health.failures.length}`);
  } finally {
    await sidecar.shutdown();
  }
}

module.exports = { parseMonth, parseChangeRows, keepPregameRows, parseMoneyline, collectBet365NbaOdds, saveAtomic };

if (require.main === module) main().catch((error) => {
  console.error(`Bet365 NBA 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
