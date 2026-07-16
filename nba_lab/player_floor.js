// nba_lab/player_floor.js — 得分地板分布分析（使用者策略:二三當家、穩定、選低分檔押「大於」）
// 方法: 百分位(無常態假設);條件=該場有出賽;地板=p10/p25;另給 P(PTS≥10/12/15) 直接對應低分檔下注
// 篩選: 出賽≥25場、中位上場≥20分鐘;「二三當家帶」=球隊得分排名第2-4
'use strict';
const fs = require('fs'); const path = require('path');
const R = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const pg = R('official_player_games.json').filter(r => r.SEASON_TYPE === 'Regular Season' && r.MIN > 0);
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
const byP = {};
for (const r of pg) {
  const p = byP[r.PLAYER_ID] = byP[r.PLAYER_ID] || { name: r.PLAYER_NAME, teams: {}, pts: [], min: [], dates: [] };
  p.pts.push(r.PTS); p.min.push(r.MIN); p.dates.push(r.GAME_DATE);
  p.teams[r.TEAM_ABBREVIATION] = (p.teams[r.TEAM_ABBREVIATION] || 0) + 1;
}
const rows = [];
for (const pid in byP) {
  const p = byP[pid]; const G = p.pts.length;
  if (G < 25) continue;
  const medMin = q(p.min, 0.5); if (medMin < 20) continue;
  const team = Object.keys(p.teams).sort((a, b) => p.teams[b] - p.teams[a])[0];
  const mean = p.pts.reduce((s, x) => s + x, 0) / G;
  const sd = Math.sqrt(p.pts.reduce((s, x) => s + (x - mean) ** 2, 0) / G);
  const minSd = Math.sqrt(p.min.reduce((s, x) => s + (x - q(p.min, 0.5)) ** 2, 0) / G);
  rows.push({ pid, name: p.name, team, G, traded: Object.keys(p.teams).length > 1,
    medMin: +medMin.toFixed(1), minSd: +minSd.toFixed(1),
    p10: q(p.pts, 0.10), p25: q(p.pts, 0.25), p50: q(p.pts, 0.50), p75: q(p.pts, 0.75),
    mean: +mean.toFixed(1), sd: +sd.toFixed(1),
    ge10: +(100 * p.pts.filter(x => x >= 10).length / G).toFixed(1),
    ge12: +(100 * p.pts.filter(x => x >= 12).length / G).toFixed(1),
    ge15: +(100 * p.pts.filter(x => x >= 15).length / G).toFixed(1) });
}
// 球隊得分排名(以 p50 排)
const byTeam = {};
for (const r of rows) (byTeam[r.team] = byTeam[r.team] || []).push(r);
for (const t in byTeam) { byTeam[t].sort((a, b) => b.p50 - a.p50); byTeam[t].forEach((r, i) => r.rankInTeam = i + 1); }
// 二三當家帶 = 隊內第2-4、中位得分 10-22
const zone = rows.filter(r => r.rankInTeam >= 2 && r.rankInTeam <= 4 && r.p50 >= 10 && r.p50 <= 22);
zone.sort((a, b) => b.ge10 - a.ge10 || b.p10 - a.p10);
fs.writeFileSync(path.join(__dirname, 'player_floor.json'), JSON.stringify({ builtAt: new Date().toISOString(), all: rows, zone }, null, 1));

let md = `# 得分地板分析（25-26 例行賽;出賽≥25場、中位上場≥20分;n=${rows.length} 人,二三當家帶 ${zone.length} 人）
> 用法對應你的策略: 「P(≥10)」=整季有出賽的場次中得分≥10的比例——低分檔押大於的直接參考。
> ⚠️ 全部是條件機率(該場有出賽);傷停缺陣不算輸,但要注意「先發不確定」場次自帶風險。

## 二三當家帶 地板王 TOP 25（隊內得分第2-4位、中位數10-22分;按 P(≥10)→p10 排序）
| 球員 | 隊 | 場 | 中位分鐘 | p10 | p25 | 中位 | P(≥10) | P(≥12) | P(≥15) | 分鐘波動 |
|---|---|---|---|---|---|---|---|---|---|---|
`;
for (const r of zone.slice(0, 25))
  md += `| ${r.name}${r.traded ? '⇄' : ''} | ${r.team} | ${r.G} | ${r.medMin} | ${r.p10} | ${r.p25} | ${r.p50} | ${r.ge10}% | ${r.ge12}% | ${r.ge15}% | ±${r.minSd} |\n`;
md += `\n（⇄=季內被交易,跨隊樣本混合需留意;完整 ${rows.length} 人資料在 player_floor.json,可依任何門檻重排）\n`;
fs.writeFileSync(path.join(__dirname, 'PLAYER_FLOOR_REPORT.md'), md);
console.log(md.split('\n').slice(0, 22).join('\n'));
console.log(`... 完整表 ${zone.length} 人見 PLAYER_FLOOR_REPORT.md`);
