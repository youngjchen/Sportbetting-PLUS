// nba_lab/pull_pbp.js — cdn.nba.com play-by-play 回補（垃圾時間過濾原料,T8）
// 每場抽最小欄位事件流存 cache/pbp/{gid}.json（不入庫）；斷點續跑；節流
// 用法: node nba_lab/pull_pbp.js
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const DIR = path.join(OUT, 'cache', 'pbp');
fs.mkdirSync(DIR, { recursive: true });
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const off = JSON.parse(fs.readFileSync(path.join(OUT, 'official_team_games.json'), 'utf8'));
  const gids = [...new Set(off.filter(r => r.SEASON_TYPE === 'Regular Season').map(r => r.GAME_ID))].sort();
  console.log(`目標 ${gids.length} 場`);
  let ok = 0, skip = 0, fail = 0;
  for (const gid of gids) {
    const f = path.join(DIR, `${gid}.json`);
    if (fs.existsSync(f) && fs.statSync(f).size > 1000) { skip++; continue; }
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
      const r = await fetch(`https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gid}.json`, { headers: H, signal: c.signal });
      clearTimeout(t);
      if (r.status !== 200) { fail++; console.log(`❌ ${gid} HTTP ${r.status}`); await sleep(400); continue; }
      const j = await r.json();
      const acts = (j.game && j.game.actions || []).map(a => [a.period, a.clock, a.scoreHome, a.scoreAway, a.teamId || 0, a.actionType, a.subType || '']);
      fs.writeFileSync(f, JSON.stringify({ gid, n: acts.length, acts }));
      ok++;
      if (ok % 100 === 0) console.log(`  ...${ok} 場完成`);
    } catch (e) { fail++; console.log(`❌ ${gid}: ${e.message}`); }
    await sleep(400);
  }
  console.log(`=== PBP 完成: 新抓 ${ok} / 快取 ${skip} / 失敗 ${fail}`);
})();
