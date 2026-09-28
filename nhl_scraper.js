/* ============================================================
   NHL 玩運彩每日管線
   來源：livescore/91（今明賽程）＋ gamesData/result?allianceid=91（昨今結算）
   賽前 NHL 盤依玩運彩規則包含延長賽與點球大戰；不採場中盤。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchText, shutdown } = require('./sidecar_client.js');
const { parseDay } = require('./nba_lab/wnba_pull_ps.js');
const { resolveHandicap } = require('./playsport_scraper.js');

const OUT = path.join('data', 'nhl_pregame.json');
const SERIES = path.join('data', 'nhl_lottery_series.json');
const SEASON_GAMES = path.join('data', 'nhl_games.json');
const SEASON_START = process.env.NHL_SEASON_START || '2026-09-30';
const KEEP_DAYS = 7;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126',
  Referer: 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9'
};
const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
const num = value => { const m = /-?\d+(?:\.\d+)?/.exec(String(value == null ? '' : value).replace(/,/g, '')); return m ? Number(m[0]) : null; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function twDate(offset) {
  const d = new Date(Date.now() + 8 * 3600000 + Number(offset || 0) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function decidedByText(text) {
  const value = clean(text);
  if (/點球|shootout|penalt/i.test(value)) return 'SO';
  if (/延長|overtime|\bOT\b/i.test(value)) return 'OT';
  if (/比賽結束|完場|終場|Final/i.test(value)) return 'REG';
  return null;
}

function extractLive(html, date) {
  const $ = cheerio.load(html);
  const out = [];
  $('.outer-gamebox[data-oid]').each((_, node) => {
    const $box = $(node);
    const oid = $box.attr('data-oid') || '';
    if (!/^NHL_\d{8}_/.test(oid)) return;
    const $preview = $box.find('.js-gamePreviewBox').first();
    const $live = $box.find('.js-gameOnbox').first();
    const gid = (($box.attr('id') || '').match(/(\d+)$/) || [])[1]
      || (($box.find('a[href*="gameid="]').attr('href') || '').match(/gameid=(\d+)/) || [])[1]
      || null;
    const previewVisible = !String($preview.attr('style') || '').includes('display:none');

    let away = clean($live.attr('data-namea'));
    let home = clean($live.attr('data-nameh'));
    if (!away || !home) {
      const teams = $preview.find('table.no_start_team td a, a[href*="teamid="]').toArray().map(a => clean($(a).text())).filter(Boolean);
      away = away || teams[0] || '';
      home = home || teams[1] || '';
    }
    if (!away || !home) return;
    const time = clean($preview.find('.team_cinter').first().text()) || null;

    const tables = $preview.find('table.no_start_datd_is').toArray();
    const cell = (table, row) => table ? clean($(table).find('tr').eq(row).find('td.datd_s').text()) : '';
    const ahAwayRaw = cell(tables[0], 0);
    const ahHomeRaw = cell(tables[1], 0);
    const totalRaw = cell(tables[0], 3);
    const handicap = resolveHandicap({
      ahAwayRaw, ahHomeRaw, awayTeam: away, homeTeam: home,
      aheadPrice: clean($live.attr('data-aheadprice')),
      winTeam: clean($live.find('.teamname_highlight').first().text()),
      betTxt: gid ? clean($live.find(`#${gid}_bet`).text()) : ''
    });

    const score = side => {
      if (!gid) return num($live.find(`[id$="_${side}sr_big"], [id$="_${side}sr"]`).first().text());
      return num($live.find(`#${gid}_${side}sr_big, #${gid}_${side}sr`).first().text());
    };
    const periods = side => {
      const values = [];
      for (let i = 1; i <= 5; i++) {
        const selector = gid ? `#${gid}_${side}s${i}` : `[id$="_${side}s${i}"]`;
        values.push(num($live.find(selector).first().text()));
      }
      while (values.length && values[values.length - 1] == null) values.pop();
      return values;
    };
    const liveText = clean($live.text());
    const finished = /比賽結束|完場|終場|Final/i.test(liveText);
    const postponed = /比賽延期|比賽取消|比賽中止|延賽|順延|保留比賽|裁定/.test(liveText);
    const status = finished ? 'finished' : postponed ? 'postponed' : previewVisible ? 'upcoming' : 'inprogress';
    const awayScore = status === 'upcoming' ? null : score('a');
    const homeScore = status === 'upcoming' ? null : score('h');
    const hhmm = (time || '00:00').replace(':', '');

    out.push({
      // 玩運彩 NHL 的 data-oid 沒有時間尾碼；統一補上台灣時間，供鬧鐘與雙賽分場。
      officialId: `NHL_${date.replace(/-/g, '')}_${away}@${home}_${hhmm}`,
      league: 'NHL', date, time, away, home, gid, status,
      period: status === 'inprogress' ? clean($live.find(gid ? `#${gid}_inning_big, #${gid}_inning` : '[id$="_inning_big"], [id$="_inning"]').first().text()) : '',
      awayScore, homeScore, periodsAway: periods('a'), periodsHome: periods('h'),
      decidedBy: finished ? decidedByText(liveText) : null,
      hdFav: handicap ? handicap.favSide : null,
      hdVal: handicap && handicap.line != null ? handicap.line : null,
      hdSrc: handicap ? handicap.src : null,
      totLine: num(totalRaw), mlOffered: true
    });
  });
  return out;
}

function mergeGames(previous, fresh, scannedDates, cutoff) {
  const oldByDate = {};
  const newByDate = {};
  for (const game of Array.isArray(previous) ? previous : []) if (game && game.date >= cutoff) (oldByDate[game.date] ||= []).push(game);
  for (const game of Array.isArray(fresh) ? fresh : []) if (game && game.date >= cutoff) (newByDate[game.date] ||= []).push(game);
  const out = [];
  const dates = new Set([...Object.keys(oldByDate), ...Object.keys(newByDate)]);
  for (const date of dates) {
    if (scannedDates.has(date)) {
      const rows = newByDate[date] || [];
      out.push(...(rows.length ? rows : oldByDate[date] || []));
    } else out.push(...(oldByDate[date] || []));
  }
  return out.sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`));
}

function mergeSeasonGames(previous, fresh) {
  const byId = new Map((Array.isArray(previous) ? previous : [])
    .filter(game => game && game.date >= SEASON_START)
    .map(game => [game.sid, game]));
  for (const game of Array.isArray(fresh) ? fresh : []) {
    if (!game || game.date < SEASON_START || game.status !== 'finished' || game.awayScore == null || game.homeScore == null || !game.officialId) continue;
    byId.set(game.officialId, {
      sid: game.officialId, date: game.date, league: 'NHL',
      awayTeam: game.away, homeTeam: game.home,
      awayScore: game.awayScore, homeScore: game.homeScore,
      hdFav: game.hdSrc === '運彩' ? game.hdFav : null,
      hdVal: game.hdSrc === '運彩' ? game.hdVal : null,
      totBasis: game.totLine == null ? null : game.totLine,
      mlOffered: game.mlOffered !== false,
      decidedBy: game.decidedBy || null
    });
  }
  return [...byId.values()].sort((a, b) => `${a.date}${a.sid}`.localeCompare(`${b.date}${b.sid}`));
}

function loadJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function saveAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1));
  fs.renameSync(temp, file);
}

function recordSeries(games, observedAt) {
  const store = loadJSON(SERIES, { updated: null, games: {} });
  if (!store.games || typeof store.games !== 'object') store.games = {};
  let changed = 0;
  for (const game of games) {
    if (game.status !== 'upcoming' || game.hdSrc !== '運彩') continue;
    const rows = store.games[game.officialId] ||= [];
    const latest = rows[rows.length - 1];
    const current = { hdFav: game.hdFav || null, hdVal: game.hdVal == null ? null : game.hdVal, totLine: game.totLine == null ? null : game.totLine };
    if (!latest || latest.hdFav !== current.hdFav || latest.hdVal !== current.hdVal || latest.totLine !== current.totLine) {
      rows.push({ at: observedAt, ...current });
      changed++;
    }
  }
  const cutoff = twDate(-KEEP_DAYS).replace(/-/g, '');
  for (const key of Object.keys(store.games)) { const m = /^NHL_(\d{8})_/.exec(key); if (m && m[1] < cutoff) delete store.games[key]; }
  store.updated = observedAt;
  saveAtomic(SERIES, store);
  return changed;
}

async function run() {
  const observedAt = new Date().toISOString();
  const today = twDate(0), tomorrow = twDate(1), yesterday = twDate(-1), twoDaysAgo = twDate(-2);
  const all = [];
  for (const date of [today, tomorrow]) {
    const ymd = date.replace(/-/g, '');
    try {
      const html = await fetchText(`https://www.playsport.cc/livescore/91?gamedate=${ymd}&mode=1&`, HEADERS, 25000);
      const rows = extractLive(html, date);
      all.push(...rows);
      console.log(`NHL livescore ${date}: ${rows.length} 場`);
    } catch (error) { console.log(`NHL livescore ${date} 失敗：${error.message}`); }
    await sleep(1000);
  }

  // 多回看一天：長迴圈或 WAF 失敗整日後仍有第二次補結果機會。
  for (const date of [twoDaysAgo, yesterday, today]) {
    const ymd = date.replace(/-/g, '');
    try {
      const html = await fetchText(`https://www.playsport.cc/gamesData/result?allianceid=91&gametime=${ymd}`, HEADERS, 25000);
      const rows = parseDay(html);
      for (const row of rows) {
        const patch = {
          mlOffered: row.mlOffered !== false,
          hdFav: row.hdAwayLine == null ? null : row.hdAwayLine > 0 ? 'away' : 'home',
          hdVal: row.hdAwayLine == null ? null : Math.abs(row.hdAwayLine),
          totLine: row.totLine == null ? null : row.totLine, hdSrc: '運彩'
        };
        const hit = all.find(game => game.date === date && game.away === row.away && game.home === row.home);
        if (hit) {
          Object.assign(hit, patch);
          if (row.awayScore != null) Object.assign(hit, { awayScore: row.awayScore, homeScore: row.homeScore, status: 'finished' });
        } else if (row.awayScore != null) {
          all.push({
            officialId: `NHL_${ymd}_${row.away}@${row.home}_${(row.time || '00:00').replace(':', '')}`,
            league: 'NHL', date, time: row.time || null, away: row.away, home: row.home, gid: row.gid,
            status: 'finished', period: '', awayScore: row.awayScore, homeScore: row.homeScore,
            periodsAway: [], periodsHome: [], decidedBy: null, ...patch
          });
        }
      }
      console.log(`NHL result ${date}: ${rows.length} 場`);
    } catch (error) { console.log(`NHL result ${date} 失敗：${error.message}`); }
    await sleep(1000);
  }

  if (process.argv.includes('--selftest')) {
    console.log(JSON.stringify(all, null, 1).slice(0, 5000));
    return all;
  }
  const previousFile = loadJSON(OUT, { games: [] });
  const merged = mergeGames(previousFile.games, all, new Set([twoDaysAgo, yesterday, today, tomorrow]), twDate(-KEEP_DAYS));
  const seriesChanged = recordSeries(all, observedAt);
  saveAtomic(OUT, { updated: observedAt, seasonStart: SEASON_START, count: merged.length, rules: { pregameIncludesOvertimeAndShootout: true }, games: merged });
  const oldSeason = loadJSON(SEASON_GAMES, { games: [] });
  const seasonGames = mergeSeasonGames(oldSeason.games, all);
  saveAtomic(SEASON_GAMES, { builtAt: observedAt, seasonStart: SEASON_START, count: seasonGames.length, games: seasonGames });
  console.log(`${OUT}: ${merged.length} 場｜整季 ${seasonGames.length} 場｜台彩序列新增 ${seriesChanged} 點`);
  return merged;
}

module.exports = { extractLive, mergeGames, mergeSeasonGames, decidedByText, recordSeries, run };

if (require.main === module) run().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(shutdown);
