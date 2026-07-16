// nba_lab/player_props_floor.js — 球員全市場地板 v2（對應 STAKE 球員盤全品項）
// 市場: 得分/籃板/助攻/PRA/PR/PA/RA/三分命中/三分出手/罰球命中/罰球出手/犯規/抄截/火鍋/失誤
// 每人每市場: p10/p25/p50/p75/mean —— 對照 STAKE 開的線直接查「地板在哪」
'use strict';
const fs = require('fs'); const path = require('path');
const R = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const pg = R('official_player_games.json').filter(r => r.SEASON_TYPE === 'Regular Season' && r.MIN > 0);
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
const MKTS = {
  pts: r => r.PTS, reb: r => r.REB, ast: r => r.AST,
  pra: r => r.PTS + r.REB + r.AST, pr: r => r.PTS + r.REB, pa: r => r.PTS + r.AST, ra: r => r.REB + r.AST,
  fg3m: r => r.FG3M, fg3a: r => r.FG3A, ftm: r => r.FTM, fta: r => r.FTA,
  pf: r => r.PF, stl: r => r.STL, blk: r => r.BLK, tov: r => r.TOV
};
const byP = {};
for (const r of pg) { const p = byP[r.PLAYER_ID] = byP[r.PLAYER_ID] || { name: r.PLAYER_NAME, team: {}, rows: [] };
  p.rows.push(r); p.team[r.TEAM_ABBREVIATION] = (p.team[r.TEAM_ABBREVIATION] || 0) + 1; }
const out = [];
for (const pid in byP) {
  const p = byP[pid]; if (p.rows.length < 25) continue;
  const mins = p.rows.map(r => r.MIN); if (q(mins, 0.5) < 20) continue;
  const rec = { pid: +pid, name: p.name, team: Object.keys(p.team).sort((a, b) => p.team[b] - p.team[a])[0],
    G: p.rows.length, traded: Object.keys(p.team).length > 1, medMin: +q(mins, 0.5).toFixed(1), mkts: {} };
  for (const m in MKTS) {
    const v = p.rows.map(MKTS[m]);
    rec.mkts[m] = { p10: q(v, .10), p25: q(v, .25), p50: q(v, .50), p75: q(v, .75), mean: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) };
  }
  out.push(rec);
}
fs.writeFileSync(path.join(__dirname, 'player_props_floor.json'), JSON.stringify({ builtAt: new Date().toISOString(), markets: Object.keys(MKTS), players: out }, null, 1));
console.log(`完成 ${out.length} 人 × ${Object.keys(MKTS).length} 市場 → player_props_floor.json`);
const ex = out.find(r => r.name.includes('Harden')) || out[0];
console.log(`示範(${ex.name} ${ex.team} ${ex.G}場):`);
for (const m of ['pts', 'reb', 'ast', 'pra', 'fg3m', 'ftm']) console.log(` ${m}: p10=${ex.mkts[m].p10} p25=${ex.mkts[m].p25} 中位=${ex.mkts[m].p50}`);
