// nba_lab/debug_residuals.js — 殘差調查（只收證據,不修任何東西）
// 殘差1: 官方 1321 場應有、offList 只 1316 → 5 場配對不完整,列出原始 MATCHUP
// 殘差2: join 後 9 場比分不符 → 三源並列(titan/官方/玩運彩),玩運彩當仲裁
// 殘差3: titan 6 場沒對上官方 → 列名
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const titan = R('titan_games.json');
const tmap = R('nba_team_map.json');
const off = R('official_team_games.json');
const ps = R('ps_lines.json');

// ---- 殘差1: 官方配對不完整的場 ----
const byGid = {};
for (const r of off) (byGid[r.GAME_ID] = byGid[r.GAME_ID] || []).push(r);
console.log('=== 殘差1: 官方 GAME_ID 配對異常 ===');
let bad = 0;
for (const gid in byGid) {
  const rows = byGid[gid];
  const vs = rows.filter(r => r.MATCHUP.includes(' vs. '));
  const at = rows.filter(r => r.MATCHUP.includes(' @ '));
  if (rows.length !== 2 || vs.length !== 1 || at.length !== 1) {
    bad++;
    console.log(`${gid} rows=${rows.length} | ${rows.map(r => `${r.GAME_DATE} ${r.TEAM_ABBREVIATION} "${r.MATCHUP}" ${r.PTS}分 ${r.SEASON_TYPE}`).join(' || ')}`);
  }
}
console.log(`共 ${bad} 場異常\n`);

// ---- 重建 join(與 join_audit 同邏輯) 抓 mismatch 與 unmatched ----
const byTitanId = {}; for (const t of tmap.teams) if (t.titanId != null) byTitanId[t.titanId] = t;
const byTri = {}; for (const t of tmap.teams) byTri[t.tricode] = t;
const offGames = {};
for (const r of off) {
  const g = offGames[r.GAME_ID] = offGames[r.GAME_ID] || { id: r.GAME_ID, dateUS: r.GAME_DATE, st: r.SEASON_TYPE };
  if (r.MATCHUP.includes(' vs. ')) { g.homeTri = r.TEAM_ABBREVIATION; g.homePts = r.PTS; } else { g.awayTri = r.TEAM_ABBREVIATION; g.awayPts = r.PTS; }
}
const offList = Object.values(offGames).filter(g => g.homeTri && g.awayTri);
const offKey = {};
for (const g of offList) for (const dd of [0, 1]) {
  const d = new Date(g.dateUS + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dd);
  offKey[`${d.toISOString().slice(0, 10)}|${g.awayTri}|${g.homeTri}`] = g;
}
const psLook = (d, awayTri, homeTri) => {
  for (const an of (byTri[awayTri] ? byTri[awayTri].psNames : [])) for (const hn of (byTri[homeTri] ? byTri[homeTri].psNames : [])) {
    const p = ps.store[`${d}|${an}|${hn}`]; if (p) return p;
  } return null;
};
console.log('=== 殘差2: 比分不符場（三源並列,titan teamA=主 已實證）===');
const unmatched = [];
for (const tg of titan.games) {
  const A = byTitanId[tg.teamA], B = byTitanId[tg.teamB];
  if (!A || !B) { unmatched.push({ tg, why: '隊名未對照' }); continue; }
  const d = tg.timeBJ.slice(0, 10);
  const gA = offKey[`${d}|${B.tricode}|${A.tricode}`];   // teamA=主
  const gB = offKey[`${d}|${A.tricode}|${B.tricode}`];
  const g = gA || gB;
  if (!g) { unmatched.push({ tg, why: '官方無此場' }); continue; }
  const okA = gA && +tg.scoreA === +gA.homePts && +tg.scoreB === +gA.awayPts;
  const okB = gB && +tg.scoreA === +gB.awayPts && +tg.scoreB === +gB.homePts;
  if (!okA && !okB) {
    const p = gA ? psLook(d, gA.awayTri, gA.homeTri) : psLook(d, gB.awayTri, gB.homeTri);
    console.log(`${d} ${tg.stage} titan#${tg.id} ${A.tricode}(A) vs ${B.tricode}(B)`);
    console.log(`  titan A:B = ${tg.scoreA}:${tg.scoreB} | 官方 主${(gA||gB).homeTri} ${(gA||gB).homePts}:${(gA||gB).awayPts}客${(gA||gB).awayTri} | 玩運彩 ${p ? `客${p.awayScore}:主${p.homeScore} (${p.away}@${p.home})` : '查無'}`);
  }
}
console.log('\n=== 殘差3: titan 沒對上官方的場 ===');
for (const { tg, why } of unmatched) {
  const A = byTitanId[tg.teamA], B = byTitanId[tg.teamB];
  console.log(`${tg.timeBJ} ${tg.stage} #${tg.id} ${A ? A.tricode : tg.teamA} vs ${B ? B.tricode : tg.teamB} ${tg.scoreA}:${tg.scoreB} — ${why}`);
}
