// nba_lab/backfill_playsport.js — 玩運彩 NBA(allianceid=3) 2025-26 台彩收盤盤口回補
// 日期清單來自 titan_games.json(GMT+8=台灣日期同值)；每日一頁、快取續跑、節流
// 輸出: nba_lab/ps_lines.json；快取: nba_lab/cache/ps/*.html(不入庫)
// 用法: node nba_lab/backfill_playsport.js
'use strict';
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const OUT = __dirname;
const CACHE = path.join(OUT, 'cache', 'ps');
fs.mkdirSync(CACHE, { recursive: true });
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gap = () => sleep(2500 + Math.floor(Math.random() * 1500));

// 一列範例 teaminfo 全文：「115 V.S. 101 暴龍 溜馬」＝客分 V.S. 主分 客隊 主隊
function parseDay(html) {
  const $ = cheerio.load(html);
  const byGame = {};
  $('table.gamedata-results tr[gameid]').each((i, tr) => { const gid = $(tr).attr('gameid'); if (gid) (byGame[gid] = byGame[gid] || []).push($(tr)); });
  const out = [];
  for (const gid in byGame) {
    const rows = byGame[gid];
    let time = '', tot = null, hdAway = null, hdRaw = '', teamText = '';
    for (const $tr of rows) {
      const t = $tr.find('td.td-gameinfo h4').first().text().trim();
      if (t && !time) { const m = /(AM|PM)?\s*(\d{1,2}):(\d{2})/i.exec(t); if (m) { let h = +m[2]; const ap = (m[1] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; time = `${String(h).padStart(2, '0')}:${m[3]}`; } }
      teamText += ' ' + $tr.find('td.td-teaminfo').text().replace(/\s+/g, ' ').trim();
      const tv = $tr.find('td.td-bank-bet02 .data-wrap > strong').first().text().trim(); if (tv && tot == null) tot = tv;
      if (hdAway == null) {
        const cellTxt = $tr.find('td.td-bank-bet01').text().replace(/\s+/g, '');
        const hm = /([客主])(受讓)?([+-]?\d+(?:\.\d+)?)/.exec(cellTxt);
        if (hm) { hdRaw = cellTxt.slice(0, 30); let v = parseFloat(hm[3]); if (hm[2]) v = Math.abs(v); if (hm[1] === '主') v = -v; hdAway = v; }   // 正=客讓分方(客-x)、負=主讓分方
      }
    }
    // token 切分：去掉數字與 V.S. 後剩兩個隊名 token（客先主後）
    const toks = teamText.split(/\s+/).filter(s => s && !/^\d+$/.test(s) && !/^V\.?S\.?$/i.test(s));
    if (toks.length < 2) continue;
    const sm = /(\d+)\s*V\.?S\.?\s*(\d+)/i.exec(teamText);
    out.push({ gid, time, away: toks[0], home: toks[1],
      awayScore: sm ? parseInt(sm[1], 10) : null, homeScore: sm ? parseInt(sm[2], 10) : null,
      hdAwayLine: (hdAway != null && !isNaN(hdAway)) ? hdAway : null, hdRaw,
      totLine: tot != null && tot !== '' ? parseFloat(tot) : null });
  }
  return out;
}

(async () => {
  const titan = JSON.parse(fs.readFileSync(path.join(OUT, 'titan_games.json'), 'utf8'));
  const days = [...new Set(titan.games.map(g => g.timeBJ.slice(0, 10)))].sort();
  console.log(`日期 ${days.length} 天（${days[0]} ~ ${days[days.length - 1]}）`);
  const store = {}; let fetched = 0, cachedN = 0, emptyDays = 0;
  const nameSet = new Set();
  for (const d of days) {
    const ymd = d.replace(/-/g, '');
    const cf = path.join(CACHE, `ps3_${ymd}.html`);
    let html = null;
    if (fs.existsSync(cf) && fs.statSync(cf).size > 500) { html = fs.readFileSync(cf, 'utf8'); cachedN++; }
    else {
      try {
        const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
        const r = await fetch(`https://www.playsport.cc/gamesData/result?allianceid=3&gametime=${ymd}`, { headers: H, signal: c.signal });
        clearTimeout(t);
        if (r.status !== 200) { console.log(`❌ ${d} HTTP ${r.status}`); await gap(); continue; }
        html = await r.text(); fs.writeFileSync(cf, html); fetched++;
      } catch (e) { console.log(`❌ ${d}: ${e.message}`); await gap(); continue; }
      await gap();
    }
    const games = parseDay(html);
    if (!games.length) emptyDays++;
    for (const g of games) { store[`${d}|${g.away}|${g.home}`] = { date: d, ...g }; nameSet.add(g.away); nameSet.add(g.home); }
    if (fetched % 20 === 0 && fetched > 0) console.log(`  ...${d} 累計 ${Object.keys(store).length} 場 (抓${fetched}/快取${cachedN})`);
  }
  fs.writeFileSync(path.join(OUT, 'ps_lines.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), count: Object.keys(store).length, names: [...nameSet].sort(), store }, null, 1));
  console.log(`\n=== 完成：${Object.keys(store).length} 場｜隊名 ${nameSet.size} 個｜空日 ${emptyDays}｜新抓 ${fetched} 快取 ${cachedN}`);
  console.log('隊名清單:', [...nameSet].sort().join(','));
})();
