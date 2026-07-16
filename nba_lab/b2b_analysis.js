// nba_lab/b2b_analysis.js — 背靠背(B2B)對三市場的影響檢測（25-26 例行賽,使用者指定題）
// B2B=該隊昨天也有比賽(休0天);對照=休≥1天。三市場: 勝率(SU)/讓分過盤(vs titan收盤線)/大小
// 關鍵問題: B2B 效應是否「已被盤口定價」——原始勝率差≠可下注優勢,過盤率才是
'use strict';
const fs = require('fs'); const path = require('path');
const R = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const wilson = (x, n) => { if (!n) return [0, 0]; const p = x / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [100 * Math.max(0, c - h), 100 * Math.min(1, c + h)]; };
const F = (x, n) => { const [a, b] = wilson(x, n); return `${x}/${n}=${n ? (100 * x / n).toFixed(1) : '-'}% CI[${a.toFixed(0)},${b.toFixed(0)}]`; };

const tg = R('official_team_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');
// 每隊按日期排 → 休息天數
const byTeam = {};
for (const r of tg) (byTeam[r.TEAM_ABBREVIATION] = byTeam[r.TEAM_ABBREVIATION] || []).push(r);
const rest = {};   // GAME_ID|tri -> 休息天數(前一場到本場-1)
for (const tri in byTeam) {
  const rows = byTeam[tri].sort((a, b) => a.GAME_DATE < b.GAME_DATE ? -1 : 1);
  for (let i = 0; i < rows.length; i++) {
    const d = i === 0 ? null : Math.round((new Date(rows[i].GAME_DATE) - new Date(rows[i - 1].GAME_DATE)) / 86400000) - 1;
    rest[rows[i].GAME_ID + '|' + tri] = d;
  }
}
// join audit games(有收盤線) → gid
const { games } = R('audit.json');
const gidBy = {};
const byGid = {};
for (const r of tg) (byGid[r.GAME_ID] = byGid[r.GAME_ID] || []).push(r);
for (const gid in byGid) { const p = byGid[gid]; if (p.length !== 2) continue;
  gidBy[`${p[0].TEAM_ABBREVIATION}|${p[1].TEAM_ABBREVIATION}|${p[0].PTS}|${p[1].PTS}`] = gid;
  gidBy[`${p[1].TEAM_ABBREVIATION}|${p[0].TEAM_ABBREVIATION}|${p[1].PTS}|${p[0].PTS}`] = gid; }
const negAway = true;   // audit 實證: 負=客讓
const cells = { awayB2B: { su: [0, 0], ats: [0, 0], ov: [0, 0], pts: [], tot: [] }, homeB2B: { su: [0, 0], ats: [0, 0], ov: [0, 0], pts: [], tot: [] },
  both: { ov: [0, 0], tot: [] }, none: { su: [0, 0], ats: [0, 0], ov: [0, 0], tot: [] } };
let n = 0;
for (const g of games.filter(g => g.stage.startsWith('regular') && g.spread != null && g.total != null)) {
  const gid = gidBy[`${g.home}|${g.away}|${g.homePts}|${g.awayPts}`]; if (!gid) continue;
  const hr = rest[gid + '|' + g.home], ar = rest[gid + '|' + g.away];
  if (hr == null || ar == null) continue;
  n++;
  const hB = hr === 0, aB = ar === 0;
  const tot = g.homePts + g.awayPts;
  const over = tot > g.total;
  // 該隊過盤: away 線=spread(負=客讓) → away+line>home 過
  const awayCovers = g.awayPts + g.spread - g.homePts > 0;
  const suAway = g.awayPts > g.homePts;
  if (aB && !hB) { const c = cells.awayB2B; c.su[1]++; if (suAway) c.su[0]++; c.ats[1]++; if (awayCovers) c.ats[0]++; c.ov[1]++; if (over) c.ov[0]++; c.pts.push(g.awayPts); c.tot.push(tot); }
  else if (hB && !aB) { const c = cells.homeB2B; c.su[1]++; if (!suAway) c.su[0]++; c.ats[1]++; if (!awayCovers) c.ats[0]++; c.ov[1]++; if (over) c.ov[0]++; c.pts.push(g.homePts); c.tot.push(tot); }
  else if (hB && aB) { const c = cells.both; c.ov[1]++; if (over) c.ov[0]++; c.tot.push(tot); }
  else { const c = cells.none; c.su[1]++; if (!suAway) c.su[0]++; c.ats[1]++; if (!awayCovers) c.ats[0]++; c.ov[1]++; if (over) c.ov[0]++; c.tot.push(tot); }
}
const avg = (a) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : '-';
const rep = `# 背靠背(B2B)三市場影響檢測（25-26 例行賽,可 join 收盤線 ${n} 場）
> B2B=昨天也打(休0天)。核心問題:效應是否已被盤口「定價」——看過盤率,不是看勝率。

| 情境 | n | 勝率(B2B隊/主隊) | 讓分過盤(同隊) | 開大率 | 合計分均 |
|---|---|---|---|---|---|
| 客隊B2B、主隊休 | ${cells.awayB2B.su[1]} | ${F(...cells.awayB2B.su)} | ${F(...cells.awayB2B.ats)} | ${F(...cells.awayB2B.ov)} | ${avg(cells.awayB2B.tot)} |
| 主隊B2B、客隊休 | ${cells.homeB2B.su[1]} | ${F(...cells.homeB2B.su)} | ${F(...cells.homeB2B.ats)} | ${F(...cells.homeB2B.ov)} | ${avg(cells.homeB2B.tot)} |
| 雙方都B2B | ${cells.both.ov[1]} | – | – | ${F(...cells.both.ov)} | ${avg(cells.both.tot)} |
| 雙方都休(基準) | ${cells.none.su[1]} | ${F(...cells.none.su)}(主隊) | ${F(...cells.none.ats)}(主隊) | ${F(...cells.none.ov)} | ${avg(cells.none.tot)} |
`;
fs.writeFileSync(path.join(__dirname, 'B2B_REPORT.md'), rep);
console.log(rep);
