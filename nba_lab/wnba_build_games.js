// nba_lab/wnba_build_games.js — 稽核通過後合成板面種子 data/wnba_games.json（doc.games 格式）
// 輸入: wnba_audit.json（join 後已正規化 home/away + 台彩線）
// 規則:
//  · 只收例行賽（聯盟盃決賽不計戰績,同 NBA 盃慣例;stage=post_* 剔除）
//  · 台彩缺線場: hdFav/hdVal/totBasis 留 null（統計引擎自動略過該市場,分母口徑=玩運彩隊伍頁）
//  · sid = WNBA_YYYYMMDD_客_主_HHMM（隊名用玩運彩繁中短名=板面隊名）
// 用法: node nba_lab/wnba_build_games.js
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const audit = JSON.parse(fs.readFileSync(path.join(OUT, 'wnba_audit.json'), 'utf8'));

const games = [];
let cupSkipped = 0, noHd = 0, noTot = 0;
for (const g of audit.games) {
  if (!g.stage.startsWith('regular')) { cupSkipped++; continue; }
  const ymd = g.date.replace(/-/g, '');
  const hhmm = (g.time || '00:00').slice(0, 5).replace(':', '');
  const hdAway = g.psHdAway;
  if (hdAway == null) noHd++;
  if (g.psTot == null) noTot++;
  games.push({
    sid: `WNBA_${ymd}_${g.psAway}_${g.psHome}_${hhmm}`,
    date: g.date, league: 'WNBA',
    awayTeam: g.psAway, homeTeam: g.psHome,
    awayScore: g.awayPts, homeScore: g.homePts,
    hdFav: hdAway == null ? null : (hdAway < 0 ? 'away' : 'home'),
    hdVal: hdAway == null ? null : Math.abs(hdAway),
    totBasis: g.psTot == null ? null : g.psTot,
    mlOffered: g.psMlOffered !== false   // false=台彩未開獨贏盤(超大熱門),獨贏統計不計該場（口徑=玩運彩隊伍頁）
  });
}
games.sort((a, b) => a.date < b.date ? -1 : 1);
const payload = { builtAt: new Date().toISOString(), league: 'WNBA', season: '2026', count: games.length, games };
fs.writeFileSync(path.join(OUT, '..', 'data', 'wnba_games.json'), JSON.stringify(payload, null, 1));
console.log(`data/wnba_games.json：${games.length} 場（剔聯盟盃 ${cupSkipped}｜台彩缺讓分 ${noHd}｜缺大小 ${noTot}）`);
console.log(`日期 ${games[0].date} ~ ${games[games.length - 1].date}`);
const teams = new Set(); for (const g of games) { teams.add(g.awayTeam); teams.add(g.homeTeam); }
console.log(`隊伍 ${teams.size}: ${[...teams].sort().join(',')}`);
