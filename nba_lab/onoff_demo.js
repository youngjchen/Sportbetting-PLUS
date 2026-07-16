// nba_lab/onoff_demo.js — 明星缺陣影響量化 示範版（出賽/缺陣 分組對照,25-26 例行賽）
// 方法: 球隊在「該球員有出賽」vs「缺陣」場次的 勝率/得分/失分/籃板 差
// ⚠️ 觀察性估計非因果: 缺陣期對手強度/其他隊友傷病/擺爛時點都混雜;小樣本;只當判讀輔助
'use strict';
const fs = require('fs'); const path = require('path');
const R = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const pg = R('official_player_games.json').filter(r => r.SEASON_TYPE === 'Regular Season' && r.MIN > 0);
const tg = R('official_team_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');
const byGid = {};
for (const r of tg) (byGid[r.GAME_ID] = byGid[r.GAME_ID] || []).push(r);

// 候選: 場均分前段且缺陣 ≥12 場的球員
const byP = {};
for (const r of pg) { const p = byP[r.PLAYER_ID] = byP[r.PLAYER_ID] || { name: r.PLAYER_NAME, team: {}, games: new Set(), pts: 0, g: 0 };
  p.games.add(r.GAME_ID); p.pts += r.PTS; p.g++; p.team[r.TEAM_ABBREVIATION] = (p.team[r.TEAM_ABBREVIATION] || 0) + 1; }
const cands = [];
for (const pid in byP) {
  const p = byP[pid]; const ppg = p.pts / p.g;
  const tri = Object.keys(p.team).sort((a, b) => p.team[b] - p.team[a])[0];
  const teamGames = tg.filter(r => r.TEAM_ABBREVIATION === tri).map(r => r.GAME_ID);
  const missed = teamGames.filter(g => !p.games.has(g));
  if (p.g >= 30 && missed.length >= 12 && ppg >= 18) cands.push({ pid, name: p.name, tri, ppg, played: [...p.games], missed, teamGames });
}
cands.sort((a, b) => b.ppg - a.ppg);
let out = `# 明星缺陣影響 示範量化（25-26;球隊在其出賽 vs 缺陣場的表現差;觀察性估計非因果）\n`;
out += `| 球員(場均分) | 隊 | 出賽場:勝率/得/失/籃板 | 缺陣場:勝率/得/失/籃板 | 差(得分) |\n|---|---|---|---|---|\n`;
for (const c of cands.slice(0, 6)) {
  const stat = (gids) => {
    let w = 0, pts = 0, opp = 0, reb = 0, m = 0;
    for (const gid of gids) { const pair = byGid[gid]; if (!pair || pair.length !== 2) continue;
      const me = pair.find(r => r.TEAM_ABBREVIATION === c.tri), op = pair.find(r => r !== me); if (!me) continue;
      m++; if (me.WL === 'W') w++; pts += me.PTS; opp += op.PTS; reb += me.REB; }
    return m ? { m, w: (100 * w / m).toFixed(0), pts: (pts / m).toFixed(1), opp: (opp / m).toFixed(1), reb: (reb / m).toFixed(1) } : null;
  };
  const on = stat(c.played.filter(g => c.teamGames.includes(g))), off = stat(c.missed);
  if (!on || !off) continue;
  out += `| ${c.name}(${c.ppg.toFixed(1)}) | ${c.tri} | n=${on.m}: ${on.w}%/${on.pts}/${on.opp}/${on.reb} | n=${off.m}: ${off.w}%/${off.pts}/${off.opp}/${off.reb} | ${(on.pts - off.pts).toFixed(1)} |\n`;
}
out += `\n結論寫在主報告;此表=方法可行性證明。正式版=陣容先驗引擎按「該員上場分鐘×貢獻」細算,而非整場二分。\n`;
fs.writeFileSync(path.join(__dirname, 'ONOFF_DEMO.md'), out);
console.log(out);
