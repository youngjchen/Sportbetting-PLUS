'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const sidecar = require('./sidecar_client.js');
const { parseTaiwanResult } = require('./nba_odds_core.js');

const OUT = path.join(__dirname, 'data', 'nba_pregame.json');
const SERIES = path.join(__dirname, 'data', 'nba_lottery_series.json');
const KEEP_DAYS = 7;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126',
  Referer: 'https://www.playsport.cc/',
  'Accept-Language': 'zh-TW,zh;q=0.9',
};

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function twDate(offset = 0, now = Date.now()) {
  const date = new Date(Number(now) + 8 * 3600000 + Number(offset) * 86400000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function extractLive(html, date) {
  const $ = cheerio.load(String(html || ''));
  const games = [];
  $('.outer-gamebox[data-oid]').each((_, element) => {
    const box = $(element);
    const officialId = String(box.attr('data-oid') || '').trim();
    if (!/^NBA_\d{8}_/.test(officialId)) return;
    const preview = box.find('.js-gamePreviewBox').first();
    const live = box.find('.js-gameOnbox').first();
    const gid = ((box.attr('id') || '').match(/(\d+)$/) || [])[1] || null;
    const names = preview.find('table.no_start_team td a').toArray().map((node) => clean($(node).text())).filter(Boolean);
    const away = clean(live.attr('data-namea')) || names[0] || null;
    const home = clean(live.attr('data-nameh')) || names[1] || null;
    if (!away || !home) return;
    const time = clean(preview.find('.team_cinter').first().text()) || null;
    const previewVisible = !String(preview.attr('style') || '').includes('display:none');
    const liveText = clean(live.text());
    const finished = /比賽結束|完場|終場|Final/i.test(liveText);
    const postponed = /延期|取消|中止|延賽|順延|保留比賽|裁定/.test(liveText);
    const status = finished ? 'finished' : postponed ? 'postponed' : previewVisible ? 'upcoming' : 'inprogress';
    const score = (suffix) => {
      const value = Number(clean(live.find(`#${gid}_${suffix}`).text()));
      return Number.isFinite(value) ? value : null;
    };
    const quarters = (side) => {
      const values = [];
      for (let index = 1; index <= 8; index++) {
        const value = score(`${side}${index}`);
        if (value == null && index > 5) break;
        values.push(value);
      }
      while (values.length && values[values.length - 1] == null) values.pop();
      return values;
    };
    games.push({
      officialId, league: 'NBA', date, time, away, home, gid,
      status,
      inning: status === 'inprogress' ? clean(live.find(`#${gid}_inning_big`).text()) : '',
      awayScore: status === 'upcoming' ? null : score('asr_big'),
      homeScore: status === 'upcoming' ? null : score('hsr_big'),
      qAway: status === 'upcoming' ? [] : quarters('as'),
      qHome: status === 'upcoming' ? [] : quarters('hs'),
      hdFav: null, hdVal: null, hdSrc: null, totLine: null, mlOffered: false,
      taiwan: { ml: null, hd: null, ou: null },
    });
  });
  return games;
}

function mergeDayGames(liveGames, resultGames) {
  const byId = new Map((liveGames || []).map((game) => [game.officialId, { ...game }]));
  for (const result of resultGames || []) {
    const prior = byId.get(result.officialId) || [...byId.values()].find((game) =>
      game.date === result.date && game.away === result.away && game.home === result.home &&
      (!game.time || !result.time || game.time === result.time));
    if (prior) {
      byId.set(prior.officialId, {
        ...prior,
        ...result,
        officialId: prior.officialId,
        status: prior.status,
        inning: prior.inning,
        qAway: prior.qAway,
        qHome: prior.qHome,
        awayScore: prior.awayScore == null ? result.awayScore : prior.awayScore,
        homeScore: prior.homeScore == null ? result.homeScore : prior.homeScore,
      });
    } else {
      byId.set(result.officialId, {
        status: result.awayScore == null ? 'upcoming' : 'finished', inning: '', qAway: [], qHome: [],
        ...result,
      });
    }
  }
  return [...byId.values()];
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

function updateSeries(games, observedAt, now) {
  const series = loadJson(SERIES, {});
  for (const game of games) {
    if (game.status !== 'upcoming') continue;
    const rows = series[game.officialId] = Array.isArray(series[game.officialId]) ? series[game.officialId] : [];
    const value = {
      hdFav: game.hdFav || null,
      hdVal: game.hdVal == null ? null : Number(game.hdVal),
      totLine: game.totLine == null ? null : Number(game.totLine),
    };
    const last = rows[rows.length - 1];
    if (!last || last.hdFav !== value.hdFav || last.hdVal !== value.hdVal || last.totLine !== value.totLine) {
      rows.push({ t: observedAt, ...value });
    }
  }
  const cutoff = twDate(-KEEP_DAYS, now).replace(/-/g, '');
  for (const key of Object.keys(series)) {
    const match = key.match(/^NBA_(\d{8})_/);
    if (match && match[1] < cutoff) delete series[key];
  }
  saveAtomic(SERIES, series);
}

async function collectNbaPregame(options = {}) {
  const fetchText = options.fetchText || sidecar.fetchText;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const dates = [twDate(0, now), twDate(1, now)];
  const liveByDate = {};
  const resultByDate = {};
  const failures = [];
  for (const date of dates) {
    const ymd = date.replace(/-/g, '');
    try {
      const html = await fetchText(`https://www.playsport.cc/livescore/3?gamedate=${ymd}&mode=1&`, HEADERS, 30000);
      liveByDate[date] = extractLive(html, date);
    } catch (error) {
      failures.push({ source: 'livescore', date, error: String(error && error.message || error) });
    }
  }
  for (const date of [twDate(-1, now), ...dates]) {
    const ymd = date.replace(/-/g, '');
    try {
      const html = await fetchText(`https://www.playsport.cc/gamesData/result?allianceid=3&gametime=${ymd}`, HEADERS, 30000);
      resultByDate[date] = parseTaiwanResult(html, date);
    } catch (error) {
      failures.push({ source: 'result', date, error: String(error && error.message || error) });
    }
  }
  const fresh = [];
  for (const date of new Set([...Object.keys(liveByDate), ...Object.keys(resultByDate)])) {
    fresh.push(...mergeDayGames(liveByDate[date] || [], resultByDate[date] || []));
  }
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { games: [] };
  const cutoff = twDate(-KEEP_DAYS, now);
  const byId = new Map();
  for (const game of previous.games || []) {
    if (game.date >= cutoff && game.officialId) byId.set(game.officialId, game);
  }
  for (const game of fresh) {
    if (!game.officialId) continue;
    for (const [oldId, old] of byId) {
      if (oldId !== game.officialId && old.date === game.date && old.away === game.away && old.home === game.home &&
          (!old.time || !game.time || old.time === game.time)) byId.delete(oldId);
    }
    byId.set(game.officialId, game);
  }
  const games = [...byId.values()];
  games.sort((left, right) => `${left.date}${left.time || ''}`.localeCompare(`${right.date}${right.time || ''}`));
  if (!games.length && (previous.games || []).length) throw new Error('NBA 本輪賽程全空，保留舊資料');
  return {
    provider: 'playsport-taiwan',
    updated: new Date(now).toISOString(),
    count: games.length,
    health: { status: failures.length ? 'partial' : 'ok', failures },
    games,
  };
}

async function main() {
  try {
    const previous = loadJson(OUT, { games: [] });
    const output = await collectNbaPregame({ previous });
    saveAtomic(OUT, output);
    updateSeries(output.games, output.updated, Date.now());
    console.log(`NBA 台彩賽程：${output.count} 場，狀態 ${output.health.status}`);
  } finally {
    await sidecar.shutdown();
  }
}

module.exports = { extractLive, mergeDayGames, collectNbaPregame, saveAtomic, twDate };

if (require.main === module) main().catch((error) => {
  console.error(`NBA 賽程收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
