// nba_lab/backfill_titan.js — 球探網 NBA 2025-26 整季賽果+收盤線回補
// 來源: nba.titan007.com jsData 月檔(例行賽) + l1_2.js(季後賽/附加賽/NBA盃決賽)
// 輸出: nba_lab/titan_games.json (所有場次), nba_lab/titan_teams.json (隊名對照原料)
// 用法: node nba_lab/backfill_titan.js
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const BASE = 'https://nba.titan007.com/jsData/matchResult/25-26/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://nba.titan007.com/' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
  try { const r = await fetch(url, { headers: HEADERS, signal: c.signal }); if (r.status !== 200) return { status: r.status, text: null }; return { status: 200, text: await r.text() }; }
  finally { clearTimeout(t); }
}

// 月檔/季後賽檔都是 var 宣告的 JS；沙箱 eval 取變數
function evalVars(js) {
  const sandbox = {};
  const fn = new Function('sandbox', `
    var arrLeague, arrTeam, arrData, ymList, playoffsList, pfData, lastUpdateTime;
    ${js.replace(/^﻿/, '')}
    sandbox.arrLeague = typeof arrLeague !== 'undefined' ? arrLeague : null;
    sandbox.arrTeam = typeof arrTeam !== 'undefined' ? arrTeam : null;
    sandbox.arrData = typeof arrData !== 'undefined' ? arrData : null;
    sandbox.ymList = typeof ymList !== 'undefined' ? ymList : null;
    sandbox.playoffsList = typeof playoffsList !== 'undefined' ? playoffsList : null;
    sandbox.pfData = typeof pfData !== 'undefined' ? pfData : null;
  `);
  fn(sandbox);
  return sandbox;
}

// arrData 列: [id, kind, 'Y-M-D H:m', teamA, teamB, scoreA, scoreB, halfA, halfB, ?, closeSpread, closeTotal, ...]
// 注意: A/B 誰主誰客、讓分正負號語義 —— 由 join_audit.js 對玩運彩+官方資料實證後定案，這裡照原始序存
function rowToGame(row, stage) {
  return { id: row[0], kind: row[1], timeBJ: row[2], teamA: row[3], teamB: row[4],
    scoreA: row[5], scoreB: row[6], halfA: row[7], halfB: row[8], flag9: row[9],
    closeSpread: row[10], closeTotal: row[11], stage, raw12: row[12], raw13: row[13], raw14: row[14] };
}

(async () => {
  const games = []; let teams = null; let league = null;
  // 例行賽 2025/10 ~ 2026/4
  const months = [[2025,10],[2025,11],[2025,12],[2026,1],[2026,2],[2026,3],[2026,4]];
  for (const [y, m] of months) {
    const url = `${BASE}l1_1_${y}_${m}.js`;
    const { status, text } = await fetchText(url);
    if (status !== 200) { console.log(`❌ ${y}-${m} HTTP ${status}`); continue; }
    const v = evalVars(text);
    if (v.arrTeam && !teams) teams = v.arrTeam;
    if (v.arrLeague && !league) league = v.arrLeague;
    const n = (v.arrData || []).length;
    for (const row of v.arrData || []) games.push(rowToGame(row, `regular_${y}_${String(m).padStart(2,'0')}`));
    console.log(`✅ 例行賽 ${y}-${m}: ${n} 場`);
    await sleep(900);
  }
  // 季後賽檔（NBA盃決賽/附加賽=扁平陣列；系列賽=巢狀 [t1,t2,w1,w2,[games]]）
  const { status, text } = await fetchText(`${BASE}l1_2.js`);
  if (status === 200) {
    const v = evalVars(text);
    if (v.arrTeam && !teams) teams = v.arrTeam;
    const roundNames = {}; for (const r of v.playoffsList || []) roundNames['P' + r[0]] = r[3];
    let po = 0;
    for (const key of Object.keys(v.pfData || {})) {
      const val = v.pfData[key]; const rn = roundNames[key] || key;
      const flat = [];
      for (const item of val) {
        if (Array.isArray(item) && Array.isArray(item[4])) flat.push(...item[4]);      // 系列賽巢狀
        else if (Array.isArray(item) && typeof item[2] === 'string') flat.push(item);   // 扁平場次
      }
      for (const row of flat) { games.push(rowToGame(row, `post_${rn.replace(/\s+/g, '_')}`)); po++; }
    }
    console.log(`✅ 季後賽/附加賽/NBA盃: ${po} 場`);
  } else console.log(`❌ 季後賽檔 HTTP ${status}`);

  // 去重（NBA盃決賽等可能同時出現在月檔）
  const seen = new Set(); const uniq = [];
  for (const g of games) { if (seen.has(g.id)) continue; seen.add(g.id); uniq.push(g); }
  uniq.sort((a, b) => a.timeBJ < b.timeBJ ? -1 : 1);

  // 隊名表: [id, cn, tw, en, cnShort, twShort, enShort]
  const teamRows = (teams || []).map(t => ({ id: t[0], cn: t[1], tw: t[2], en: t[3], cnS: t[4], twS: t[5], enS: t[6] }));
  fs.writeFileSync(path.join(OUT, 'titan_games.json'), JSON.stringify({ league, fetchedAt: new Date().toISOString(), count: uniq.length, games: uniq }, null, 1));
  fs.writeFileSync(path.join(OUT, 'titan_teams.json'), JSON.stringify(teamRows, null, 1));

  const reg = uniq.filter(g => g.stage.startsWith('regular')).length;
  const post = uniq.length - reg;
  const noSpread = uniq.filter(g => g.closeSpread == null || g.closeSpread === '' || isNaN(g.closeSpread)).length;
  console.log(`\n=== 總計 ${uniq.length} 場（例行賽 ${reg} / 季後賽系 ${post}）｜缺收盤讓分 ${noSpread}｜隊伍 ${teamRows.length}`);
  console.log(`例行賽期望 1230 場 → ${reg === 1230 ? '✅ 吻合' : '⚠️ 不符，需查'}`);
})();
