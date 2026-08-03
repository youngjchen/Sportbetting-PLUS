// nba_lab/wnba_pull_titan.js — 球探網 WNBA 2026 整季賽果+收盤線回補
// 來源: nba.titan007.com jsData 月檔 matchResult/26/l2_1_2026_{m}.js（WNBA=聯盟2、單年季資料夾'26'）
// 輸出: nba_lab/wnba_titan_games.json, nba_lab/wnba_titan_teams.json
// 用法: node nba_lab/wnba_pull_titan.js
// 欄位映射沿 NBA backfill_titan.js（同構已比對）：[id,kind,'Y-M-D H:m',teamA,teamB,scoreA,scoreB,halfA,halfB,flag9,closeSpread,closeTotal,...]
// A/B 誰主誰客、讓分正負號語義由 wnba_join_audit.js 實證後定案，這裡照原始序存。
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const BASE = 'https://nba.titan007.com/jsData/matchResult/26/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://nba.titan007.com/' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
  try { const r = await fetch(url, { headers: HEADERS, signal: c.signal }); if (r.status !== 200) return { status: r.status, text: null }; return { status: 200, text: await r.text() }; }
  finally { clearTimeout(t); }
}

function evalVars(js) {
  const sandbox = {};
  const fn = new Function('sandbox', `
    var arrLeague, arrTeam, arrData, ymList, playoffsList, pfData, lastUpdateTime;
    ${js.replace(/^﻿/, '')}
    sandbox.arrLeague = typeof arrLeague !== 'undefined' ? arrLeague : null;
    sandbox.arrTeam = typeof arrTeam !== 'undefined' ? arrTeam : null;
    sandbox.arrData = typeof arrData !== 'undefined' ? arrData : null;
    sandbox.playoffsList = typeof playoffsList !== 'undefined' ? playoffsList : null;
    sandbox.pfData = typeof pfData !== 'undefined' ? pfData : null;
  `);
  fn(sandbox);
  return sandbox;
}

function rowToGame(row, stage) {
  return { id: row[0], kind: row[1], timeBJ: row[2], teamA: row[3], teamB: row[4],
    scoreA: row[5], scoreB: row[6], halfA: row[7], halfB: row[8], flag9: row[9],
    closeSpread: row[10], closeTotal: row[11], stage, raw12: row[12], raw13: row[13], raw14: row[14] };
}

(async () => {
  const games = []; let teams = null; let league = null;
  const months = [[2026, 5], [2026, 6], [2026, 7], [2026, 8]];
  for (const [y, m] of months) {
    const url = `${BASE}l2_1_${y}_${m}.js`;
    const { status, text } = await fetchText(url);
    if (status !== 200) { console.log(`❌ ${y}-${m} HTTP ${status}`); continue; }
    const v = evalVars(text);
    if (v.arrTeam && !teams) teams = v.arrTeam;
    if (v.arrLeague && !league) league = v.arrLeague;
    const n = (v.arrData || []).length;
    for (const row of v.arrData || []) games.push(rowToGame(row, `regular_${y}_${String(m).padStart(2, '0')}`));
    console.log(`✅ 例行賽 ${y}-${m}: ${n} 場`);
    await sleep(900);
  }
  // 季後賽檔（9月才有；404=正常）
  const { status, text } = await fetchText(`${BASE}l2_2.js`);
  if (status === 200) {
    const v = evalVars(text);
    let po = 0;
    for (const key of Object.keys(v.pfData || {})) {
      const flat = [];
      for (const item of v.pfData[key]) {
        if (Array.isArray(item) && Array.isArray(item[4])) flat.push(...item[4]);
        else if (Array.isArray(item) && typeof item[2] === 'string') flat.push(item);
      }
      for (const row of flat) { games.push(rowToGame(row, `post_${key}`)); po++; }
    }
    console.log(`✅ 季後賽檔: ${po} 場`);
  } else console.log(`（季後賽檔 HTTP ${status}＝尚未開打，正常）`);

  const seen = new Set(); const uniq = [];
  for (const g of games) { if (seen.has(g.id)) continue; seen.add(g.id); uniq.push(g); }
  uniq.sort((a, b) => a.timeBJ < b.timeBJ ? -1 : 1);

  const teamRows = (teams || []).map(t => ({ id: t[0], cn: t[1], tw: t[2], en: t[3], cnS: t[4], twS: t[5], enS: t[6] }));
  fs.writeFileSync(path.join(OUT, 'wnba_titan_games.json'), JSON.stringify({ league, fetchedAt: new Date().toISOString(), count: uniq.length, games: uniq }, null, 1));
  fs.writeFileSync(path.join(OUT, 'wnba_titan_teams.json'), JSON.stringify(teamRows, null, 1));

  const noSpread = uniq.filter(g => g.closeSpread == null || g.closeSpread === '' || isNaN(g.closeSpread)).length;
  const dates = uniq.map(g => g.timeBJ.slice(0, 10));
  console.log(`\n=== 總計 ${uniq.length} 場（${dates[0]} ~ ${dates[dates.length - 1]}）｜缺收盤讓分 ${noSpread}｜隊伍 ${teamRows.length}`);
})();
