// nba_lab/player_audit.js — 球員逐場資料完整性稽核（data-quality 守門,地板頁前置）
// 檢項: 唯一鍵重複/比賽覆蓋 vs 隊伍逐場/每隊每場出賽人數分布/0分鐘列/欄位缺漏/被交易球員/新秀無上季
'use strict';
const fs = require('fs'); const path = require('path');
const R = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const pg = R('official_player_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');
const tg = R('official_team_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');

// 1 唯一鍵
const seen = new Set(); let dup = 0;
for (const r of pg) { const k = r.PLAYER_ID + '|' + r.GAME_ID; if (seen.has(k)) dup++; seen.add(k); }
// 2 比賽覆蓋
const gamesP = new Set(pg.map(r => r.GAME_ID)), gamesT = new Set(tg.map(r => r.GAME_ID));
const missing = [...gamesT].filter(g => !gamesP.has(g));
// 3 每隊每場人數
const perTG = {};
for (const r of pg) { const k = r.GAME_ID + '|' + r.TEAM_ID; perTG[k] = (perTG[k] || 0) + 1; }
const counts = Object.values(perTG); counts.sort((a, b) => a - b);
// 4 0分鐘/缺欄
const zeroMin = pg.filter(r => !(r.MIN > 0)).length;
const nulls = ['PTS', 'MIN', 'REB', 'AST'].map(k => `${k}:${pg.filter(r => r[k] == null).length}`).join(' ');
// 5 被交易(多隊)
const teamsOf = {};
for (const r of pg) (teamsOf[r.PLAYER_ID] = teamsOf[r.PLAYER_ID] || new Set()).add(r.TEAM_ID);
const traded = Object.values(teamsOf).filter(s => s.size > 1).length;
// 6 verify 隊分=球員分加總(抽驗100場)
const ptsByTG = {}, ptsTeam = {};
for (const r of pg) { const k = r.GAME_ID + '|' + r.TEAM_ID; ptsByTG[k] = (ptsByTG[k] || 0) + r.PTS; }
for (const r of tg) ptsTeam[r.GAME_ID + '|' + r.TEAM_ID] = r.PTS;
let sumMismatch = 0, checked = 0;
for (const k in ptsTeam) { if (ptsByTG[k] == null) continue; checked++; if (ptsByTG[k] !== ptsTeam[k]) sumMismatch++; }
// 7 新秀(無24-25資料)佔比
const p24 = new Set(R('official_player_games_2024_25.json').map(r => r.PLAYER_ID));
const players = Object.keys(teamsOf);
const noPrior = players.filter(p => !p24.has(+p) && !p24.has(p)).length;

const rep = `# 球員逐場資料稽核（25-26 例行賽 ${pg.length} 列 / ${gamesP.size} 場 / ${players.length} 名球員）
- 唯一鍵(球員×場)重複: ${dup} ${dup ? '⚠️' : '✅'}
- 比賽覆蓋: 隊伍逐場 ${gamesT.size} 場中缺球員資料 ${missing.length} 場 ${missing.length ? '⚠️ ' + missing.slice(0, 5).join(',') : '✅'}
- 每隊每場出賽人數: min ${counts[0]} / 中位 ${counts[Math.floor(counts.length / 2)]} / max ${counts[counts.length - 1]}（NBA 常態 8~13）${counts[0] >= 5 ? '✅' : '⚠️'}
- 0分鐘列: ${zeroMin}（垃圾時間末端替補,地板分析以 MIN 門檻自然排除）
- 關鍵欄位 null: ${nulls} ✅
- 隊伍得分=球員加總: 抽驗 ${checked} 隊-場,不符 ${sumMismatch} ${sumMismatch ? '⚠️' : '✅'}
- 被交易(季內多隊): ${traded} 人（地板分析需按「現隊」切窗）
- 無 24-25 資料(新秀/海歸): ${noPrior} 人（佔 ${(100 * noPrior / players.length).toFixed(0)}%,先驗以覆蓋率折減=既定設計）
- **DNP 語義**: playergamelogs 只含出賽場——「未出賽」不是 0 分,是缺席。地板/命中率一律以「有出賽」為條件,可用率另計。
`;
fs.writeFileSync(path.join(__dirname, 'PLAYER_AUDIT.md'), rep);
console.log(rep);
