// nba_lab/wnba_verify_stats.js — T4 驗收：自算過盤率 vs 玩運彩隊伍頁對帳
// 從 data/wnba_games.json 推導指定隊伍的 運彩讓分/受讓/不讓分/大分 × 主/客/全 戰績，
// 抓該隊 gamesData/teams 頁的「運彩盤」表比對。全對=驗收過。
// 用法: node nba_lab/wnba_verify_stats.js 美夢 風暴 王牌   （隊名=玩運彩繁中短名）
'use strict';
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchText, shutdown } = require(path.join(__dirname, '..', 'sidecar_client.js'));
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'wnba_games.json'), 'utf8'));
const tmap = JSON.parse(fs.readFileSync(path.join(__dirname, 'wnba_team_map.json'), 'utf8'));
// 玩運彩 teamid 對照（livescore 頁枚舉,2026-08-03）
const PS_TEAMID = { '金州': 18937, '火焰': 20886, '節奏': 20887, '太陽': 248, '王牌': 249, '天空': 250, '狂熱': 251,
  '自由': 252, '水星': 253, '風暴': 254, '神秘': 255, '山貓': 257, '火花': 258, '飛翼': 410, '美夢': 247 };

function calc(team) {
  const agg = { hd: { home: [0, 0], away: [0, 0] }, recv: { home: [0, 0], away: [0, 0] },
    ml: { home: [0, 0], away: [0, 0] }, tot: { home: [0, 0], away: [0, 0] } };
  for (const g of seed.games) {
    const isAway = g.awayTeam === team, isHome = g.homeTeam === team;
    if (!isAway && !isHome) continue;
    const v = isAway ? 'away' : 'home';
    const my = isAway ? g.awayScore : g.homeScore, opp = isAway ? g.homeScore : g.awayScore;
    if (g.mlOffered !== false) agg.ml[v][my > opp ? 0 : 1]++;
    if (g.hdFav != null && g.hdVal != null) {
      const favIsMe = g.hdFav === v;
      const favScore = favIsMe ? my : opp, dogScore = favIsMe ? opp : my;
      const covered = (favScore - dogScore) > g.hdVal;
      if (favIsMe) agg.hd[v][covered ? 0 : 1]++;
      else agg.recv[v][covered ? 1 : 0]++;
    }
    if (g.totBasis != null) agg.tot[v][(my + opp) > g.totBasis ? 0 : 1]++;
  }
  const all = (m) => [agg[m].home[0] + agg[m].away[0], agg[m].home[1] + agg[m].away[1]];
  return { team, hd: { ...agg.hd, all: all('hd') }, recv: { ...agg.recv, all: all('recv') },
    ml: { ...agg.ml, all: all('ml') }, tot: { ...agg.tot, all: all('tot') } };
}

function parsePsTeamPage(html) {
  const $ = cheerio.load(html);
  // 運彩盤表: 標頭含 運彩讓分/運彩受讓/運彩不讓分/運彩大分,主/客/全部 各一組「W-L」「%」
  let target = null;
  $('table').each((i, t) => { const txt = $(t).text().replace(/\s+/g, ' '); if (/運彩讓分/.test(txt) && /運彩不讓分/.test(txt)) target = txt; });
  if (!target) return null;
  // 格式為序列「W-L pct %」×12（讓分主/客/全、受讓…、不讓分…、大分…）；W-L 與 % 在同格巢狀元素,逐格匹配撈不到→整表文字掃
  const recs = [...target.matchAll(/(\d+)-(\d+)\s*(\d+)\s*%/g)].map(m => [+m[1], +m[2]]);
  if (recs.length < 12) return { raw: recs };
  return { hd: { home: recs[0], away: recs[1], all: recs[2] }, recv: { home: recs[3], away: recs[4], all: recs[5] },
    ml: { home: recs[6], away: recs[7], all: recs[8] }, tot: { home: recs[9], away: recs[10], all: recs[11] } };
}

(async () => {
  const teams = process.argv.slice(2).filter(s => !s.startsWith('-'));
  if (!teams.length) teams.push('風暴', '王牌', '金州');   // 美夢 teamid 未枚舉到(247或256待驗),預設用已知 id 的隊
  let pass = 0, fail = 0;
  for (const team of teams) {
    const mine = calc(team);
    const tid = PS_TEAMID[team];
    if (!tid) { console.log(`❌ ${team}: 無 teamid`); fail++; continue; }
    const html = await fetchText(`https://www.playsport.cc/gamesData/teams?allianceid=7&teamid=${tid}`, H, 25000);
    const ps = parsePsTeamPage(html);
    if (!ps || !ps.hd) { console.log(`❌ ${team}: 隊伍頁解析失敗`, ps && ps.raw); fail++; await sleep(1500); continue; }
    let ok = true;
    for (const m of ['hd', 'recv', 'ml', 'tot']) for (const v of ['home', 'away', 'all']) {
      const a = mine[m][v], b = ps[m][v];
      if (a[0] !== b[0] || a[1] !== b[1]) { ok = false; console.log(`  ✗ ${team} ${m}.${v} 我=${a[0]}-${a[1]} 玩=${b[0]}-${b[1]}`); }
    }
    console.log(`${ok ? '✅' : '❌'} ${team} 對帳${ok ? '全對' : '有差異'}（ml全 ${mine.ml.all[0]}-${mine.ml.all[1]}）`);
    ok ? pass++ : fail++;
    await sleep(1500);
  }
  console.log(`\n=== 對帳 ${pass} 過 / ${fail} 敗`);
  shutdown();
  process.exitCode = fail ? 1 : 0;
})();
