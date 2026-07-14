// nba_lab/pull_official.js — NBA 官方數據拉取（本機執行；stats.nba.com 僅本機可通）
// 輸出: official_team_games.json(隊伍逐場box)、official_player_games.json(球員逐場,精簡欄)、
//       official_advanced.json(官方進階表,對照自算用)、cdn_probe.json(cdn持久性驗證,管線設計依據)
// 用法: node nba_lab/pull_official.js
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126',
  'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com', 'Accept': 'application/json',
  'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true'
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getJson(url, timeoutMs = 60000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: H, signal: c.signal }); if (r.status !== 200) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
// stats.nba.com resultSet → 物件陣列
function rsToRows(rs) { const h = rs.headers; return rs.rowSet.map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; }); }

(async () => {
  // 1) 隊伍逐場 box（例行賽+季後賽）— 自算回合數/攻防效率的原料
  const teamGames = [];
  for (const st of ['Regular Season', 'Playoffs', 'PlayIn']) {
    const url = `https://stats.nba.com/stats/leaguegamelog?Counter=3000&DateFrom=&DateTo=&Direction=ASC&LeagueID=00&PlayerOrTeam=T&Season=2025-26&SeasonType=${encodeURIComponent(st)}&Sorter=DATE`;
    try { const j = await getJson(url); const rows = rsToRows(j.resultSets[0]); rows.forEach(r => r.SEASON_TYPE = st); teamGames.push(...rows); console.log(`✅ 隊伍逐場 ${st}: ${rows.length} rows`); }
    catch (e) { console.log(`❌ 隊伍逐場 ${st}: ${e.message}`); }
    await sleep(1500);
  }
  fs.writeFileSync(path.join(OUT, 'official_team_games.json'), JSON.stringify(teamGames));

  // 2) 球員逐場（精簡欄位）— 球員資料庫地基（得分地板/陣容先驗）
  const KEEP = ['SEASON_YEAR','PLAYER_ID','PLAYER_NAME','TEAM_ID','TEAM_ABBREVIATION','GAME_ID','GAME_DATE','MATCHUP','WL','MIN','FGM','FGA','FG3M','FG3A','FTM','FTA','OREB','DREB','REB','AST','TOV','STL','BLK','PF','PTS','PLUS_MINUS'];
  const playerGames = [];
  for (const st of ['Regular Season', 'Playoffs']) {
    const url = `https://stats.nba.com/stats/playergamelogs?Season=2025-26&SeasonType=${encodeURIComponent(st)}`;
    try {
      const j = await getJson(url, 120000); const rows = rsToRows(j.resultSets[0]);
      for (const r of rows) { const o = {}; KEEP.forEach(k => o[k] = r[k]); o.SEASON_TYPE = st; playerGames.push(o); }
      console.log(`✅ 球員逐場 ${st}: ${rows.length} rows`);
    } catch (e) { console.log(`❌ 球員逐場 ${st}: ${e.message}`); }
    await sleep(1500);
  }
  fs.writeFileSync(path.join(OUT, 'official_player_games.json'), JSON.stringify(playerGames));

  // 3) 官方進階表（net/off/def rating, pace）— 對照自算引擎的標準答案
  try {
    const url = 'https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&LastNGames=0&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2025-26&SeasonSegment=&SeasonType=Regular%20Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=';
    const j = await getJson(url);
    fs.writeFileSync(path.join(OUT, 'official_advanced.json'), JSON.stringify(rsToRows(j.resultSets[0])));
    console.log('✅ 官方進階表 30 隊');
  } catch (e) { console.log(`❌ 進階表: ${e.message}`); }
  await sleep(1500);

  // 4) cdn 持久性驗證（雲端管線設計依據）：舊比賽 boxscore/pbp 是否留存 + schedule 現在裝哪季
  const probe = {};
  const gid = teamGames.length ? teamGames[0].GAME_ID : '0022500001';   // season首場
  for (const [k, u] of Object.entries({
    boxscore_old: `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gid}.json`,
    pbp_old: `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gid}.json`,
    schedule: 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json'
  })) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 60000);
      const r = await fetch(u, { headers: { 'User-Agent': H['User-Agent'], 'Referer': H.Referer, 'Origin': H.Origin }, signal: c.signal });
      const body = await r.text(); clearTimeout(t);
      probe[k] = { status: r.status, bytes: body.length };
      if (k === 'schedule' && r.status === 200) { const m = /"seasonYear"\s*:\s*"([^"]+)"/.exec(body); probe[k].seasonYear = m && m[1]; }
      if (k === 'boxscore_old' && r.status === 200) { const j = JSON.parse(body); probe[k].gameId = j.game && j.game.gameId; probe[k].homeTeam = j.game && j.game.homeTeam && j.game.homeTeam.teamTricode; probe[k].score = j.game ? `${j.game.awayTeam.score}-${j.game.homeTeam.score}` : null; }
    } catch (e) { probe[k] = { error: e.message }; }
    await sleep(1200);
  }
  fs.writeFileSync(path.join(OUT, 'cdn_probe.json'), JSON.stringify(probe, null, 2));
  console.log('cdn 驗證:', JSON.stringify(probe));
  console.log(`\n=== 完成：隊伍逐場 ${teamGames.length}、球員逐場 ${playerGames.length}`);
})();
