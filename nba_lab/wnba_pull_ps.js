// nba_lab/wnba_pull_ps.js — 玩運彩 WNBA(allianceid=7) 2026 台彩收盤盤口+賽果回補
// 日期清單來自 wnba_titan_games.json 的「已打場」(有比分)日期；每日一頁、快取續跑、節流
// 輸出: nba_lab/wnba_ps_lines.json；快取: nba_lab/cache/ps7/*.html(不入庫)
// 解析器沿 NBA backfill_playsport.js（客先主後、客分V.S.主分；讓分 正=客讓/負=主讓；td-bank-bet02=大小線）
// 用法: node nba_lab/wnba_pull_ps.js [--selftest 20260801]
'use strict';
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchText, shutdown } = require(path.join(__dirname, '..', 'sidecar_client.js')); // WAF 對策：curl 優先、403 自動切隱形瀏覽器
const OUT = __dirname;
const CACHE = path.join(OUT, 'cache', 'ps7');
fs.mkdirSync(CACHE, { recursive: true });
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gap = () => sleep(2500 + Math.floor(Math.random() * 1500));

function parseDay(html) {
  const $ = cheerio.load(html);
  const byGame = {};
  $('table.gamedata-results tr[gameid]').each((i, tr) => { const gid = $(tr).attr('gameid'); if (gid) (byGame[gid] = byGame[gid] || []).push($(tr)); });
  const out = [];
  for (const gid in byGame) {
    const rows = byGame[gid];
    let time = '', tot = null, hdAway = null, hdRaw = '', teamText = '', mlSeen = false;
    for (const $tr of rows) {
      const t = $tr.find('td.td-gameinfo h4').first().text().trim();
      if (t && !time) { const m = /(AM|PM)?\s*(\d{1,2}):(\d{2})/i.exec(t); if (m) { let h = +m[2]; const ap = (m[1] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; time = `${String(h).padStart(2, '0')}:${m[3]}`; } }
      teamText += ' ' + $tr.find('td.td-teaminfo').text().replace(/\s+/g, ' ').trim();
      const tv = $tr.find('td.td-bank-bet02 .data-wrap > strong').first().text().trim(); if (tv && tot == null) tot = tv;
      if (/[客主]\s*\d/.test($tr.find('td.td-bank-bet03').text().replace(/\s+/g, ''))) mlSeen = true;   // 台彩不讓分欄（超大熱門不開盤時空白→隊伍頁不計分母）
      if (hdAway == null) {
        const cellTxt = $tr.find('td.td-bank-bet01').text().replace(/\s+/g, '');
        const hm = /([客主])(受讓)?([+-]?\d+(?:\.\d+)?)/.exec(cellTxt);
        if (hm) { hdRaw = cellTxt.slice(0, 30); let v = parseFloat(hm[3]); if (hm[2]) v = Math.abs(v); if (hm[1] === '主') v = -v; hdAway = v; }   // 正=客讓分方(客-x)、負=主讓分方
      }
    }
    const toks = teamText.split(/\s+/).filter(s => s && !/^\d+$/.test(s) && !/^V\.?S\.?$/i.test(s));
    if (toks.length < 2) continue;
    const sm = /(\d+)\s*V\.?S\.?\s*(\d+)/i.exec(teamText);
    out.push({ gid, time, away: toks[0], home: toks[1],
      awayScore: sm ? parseInt(sm[1], 10) : null, homeScore: sm ? parseInt(sm[2], 10) : null,
      hdAwayLine: (hdAway != null && !isNaN(hdAway)) ? hdAway : null, hdRaw,
      totLine: tot != null && tot !== '' ? parseFloat(tot) : null, mlOffered: mlSeen });
  }
  return out;
}

async function fetchDay(ymd) {
  const cf = path.join(CACHE, `ps7_${ymd}.html`);
  if (fs.existsSync(cf) && fs.statSync(cf).size > 500) return { html: fs.readFileSync(cf, 'utf8'), cached: true };
  const html = await fetchText(`https://www.playsport.cc/gamesData/result?allianceid=7&gametime=${ymd}`, H, 25000);
  fs.writeFileSync(cf, html);
  return { html, cached: false };
}

module.exports = { parseDay, fetchDay };
if (require.main === module) (async () => {
  const selfIdx = process.argv.indexOf('--selftest');
  if (selfIdx >= 0) {
    const ymd = process.argv[selfIdx + 1] || '20260801';
    const { html, cached } = await fetchDay(ymd);
    const games = parseDay(html);
    console.log(`selftest ${ymd}（${cached ? '快取' : '新抓'}）→ ${games.length} 場`);
    for (const g of games) console.log(' ', JSON.stringify(g));
    shutdown();
    return;
  }
  const titan = JSON.parse(fs.readFileSync(path.join(OUT, 'wnba_titan_games.json'), 'utf8'));
  const played = titan.games.filter(g => g.scoreA != null && g.scoreA !== '' && !isNaN(g.scoreA));
  const days = [...new Set(played.map(g => g.timeBJ.slice(0, 10)))].sort();
  console.log(`已打日期 ${days.length} 天（${days[0]} ~ ${days[days.length - 1]}）`);
  const store = {}; let fetched = 0, cachedN = 0, emptyDays = 0;
  const nameSet = new Set();
  for (const d of days) {
    const ymd = d.replace(/-/g, '');
    let html;
    try { const r = await fetchDay(ymd); html = r.html; r.cached ? cachedN++ : fetched++; if (!r.cached) await gap(); }
    catch (e) { console.log(`❌ ${d}: ${e.message}`); await gap(); continue; }
    const games = parseDay(html);
    if (!games.length) emptyDays++;
    for (const g of games) { store[`${d}|${g.away}|${g.home}`] = { date: d, ...g }; nameSet.add(g.away); nameSet.add(g.home); }
    if (fetched > 0 && fetched % 20 === 0) console.log(`  ...${d} 累計 ${Object.keys(store).length} 場 (抓${fetched}/快取${cachedN})`);
  }
  fs.writeFileSync(path.join(OUT, 'wnba_ps_lines.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), count: Object.keys(store).length, names: [...nameSet].sort(), store }, null, 1));
  console.log(`\n=== 完成：${Object.keys(store).length} 場｜隊名 ${nameSet.size} 個｜空日 ${emptyDays}｜新抓 ${fetched} 快取 ${cachedN}`);
  console.log('隊名清單:', [...nameSet].sort().join(','));
  shutdown();
})();
