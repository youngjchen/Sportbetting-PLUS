/* ============================================================
   模組：MLB 官方 Stats API → 賽事清單 spine + 先發投手 + 生日表 + 官方日夜
   來源：statsapi.mlb.com（免費官方 JSON，無 DOM 脆弱性）
   每場輸出（鍵=台灣 date+兩隊+gameTime，與盤面/賠率/奇門同一套唯一鍵）：
     date(台灣)、gameTime(台灣 HH:MM)、away/home(中文隊名)、awayEN/homeEN、
     usDate、gameDateUTC、status、awayScore/homeScore、dayNight(官方)、
     doubleHeader、gameNumber、awayPitcher{id,name}、homePitcher{id,name}、gamePk
   另產出投手生日表：{ pitcherId: {name, birthDate, birthCity, throws} }
   設計依驗證結論：歷史 probablePitcher 即實際先發 → 用 schedule、不抓 boxscore（快）。
   （臨時換投訊號歷史無法還原，未來場次可由每日快照比對補。）
   用法：
     node mlb_fetch.js --from 2026-04-01 --to 2026-06-25 \
        [--out data/mlb_games.json] [--birthdays data/pitcher_birthdays.json]
   時間慣例：gameDate(UTC) + 8 小時 = 台灣 date+gameTime（與盤面一致；雙重賽靠不同開賽時間分開）。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API = 'https://statsapi.mlb.com/api/v1';
const UA = 'qimen-research/1.0 (personal analysis)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// MLB teamId → 中文隊名（用穩定數字 ID 對應最保險）
const TEAM_CN = {
  108: '天使', 109: '響尾蛇', 110: '金鶯', 111: '紅襪', 112: '小熊', 113: '紅人',
  114: '守護者', 115: '落磯', 116: '老虎', 117: '太空人', 118: '皇家', 119: '道奇',
  120: '國民', 121: '大都會', 133: '運動家', 134: '海盜', 135: '教士', 136: '水手',
  137: '巨人', 138: '紅雀', 139: '光芒', 140: '遊騎兵', 141: '藍鳥', 142: '雙城',
  143: '費城人', 144: '勇士', 145: '白襪', 146: '馬林魚', 147: '洋基', 158: '釀酒人',
};
const unmapped = new Set();

function arg(k, d) { const i = process.argv.indexOf(k); if (i >= 0) return process.argv[i + 1]; const h = process.argv.find(a => a.startsWith(k + '=')); return h ? h.split('=').slice(1).join('=') : d; }
function loadJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }
const get = (u) => axios.get(u, { headers: { 'User-Agent': UA }, timeout: 20000, validateStatus: () => true });

function usDateList(from, to) {
  const mk = (s) => new Date(s.replace(/\//g, '-') + 'T00:00:00Z');
  const out = []; let d = mk(from); const end = mk(to);
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}
// UTC ISO → 台灣 {date, time}
function toTaiwan(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}
function teamCN(team) { const cn = TEAM_CN[team.id]; if (!cn) unmapped.add(team.id + ':' + team.name); return cn || team.name; }
function gameKey(date, away, home, time) { return `${date}|${[away, home].sort().join('@')}|${time}`; }

async function fetchSchedule(usDate) {
  const r = await get(`${API}/schedule?sportId=1&date=${usDate}&hydrate=probablePitcher,team`);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return (r.data.dates && r.data.dates[0]) ? r.data.dates[0].games : [];
}

async function main() {
  const from = arg('--from'), to = arg('--to');
  if (!from || !to) { console.error('需要 --from YYYY-MM-DD --to YYYY-MM-DD'); process.exit(1); }
  const outPath = arg('--out', path.join('data', 'mlb_games.json'));
  const bdayPath = arg('--birthdays', path.join('data', 'pitcher_birthdays.json'));

  const dates = usDateList(from, to);
  const store = {};                                  // key → record
  for (const g of loadJson(outPath, [])) store[g.key] = g;   // 既有 → 續跑
  const bdays = loadJson(bdayPath, {});              // pitcherId → {...}
  const beforeG = Object.keys(store).length;
  let added = 0, fail = 0;
  const pitcherIds = new Set();

  console.log(`MLB spine ${from}~${to}（${dates.length} 天）→ ${outPath}\n`);
  for (let i = 0; i < dates.length; i++) {
    try {
      const games = await fetchSchedule(dates[i]);
      for (const g of games) {
        const tw = toTaiwan(g.gameDate);
        const aCN = teamCN(g.teams.away.team), hCN = teamCN(g.teams.home.team);
        const ap = g.teams.away.probablePitcher, hp = g.teams.home.probablePitcher;
        if (ap && ap.id) pitcherIds.add(ap.id);
        if (hp && hp.id) pitcherIds.add(hp.id);
        const key = gameKey(tw.date, aCN, hCN, tw.time);
        store[key] = {
          key, date: tw.date, gameTime: tw.time, away: aCN, home: hCN,
          awayEN: g.teams.away.team.name, homeEN: g.teams.home.team.name,
          usDate: dates[i], gameDateUTC: g.gameDate, gamePk: g.gamePk,
          status: g.status.detailedState,
          awayScore: g.teams.away.score != null ? g.teams.away.score : null,
          homeScore: g.teams.home.score != null ? g.teams.home.score : null,
          dayNight: g.dayNight || null,
          doubleHeader: g.doubleHeader || 'N', gameNumber: g.gameNumber || 1,
          awayPitcher: ap ? { id: ap.id, name: ap.fullName } : null,
          homePitcher: hp ? { id: hp.id, name: hp.fullName } : null,
        };
        added++;
      }
      console.log(`  ${dates[i]}  ${games.length} 場`);
    } catch (e) { fail++; console.warn(`  ${dates[i]} ⚠ ${e.message}`); }
    if (i % 10 === 9) fs.writeFileSync(outPath, JSON.stringify(Object.values(store)));
    await sleep(400);
  }
  fs.writeFileSync(outPath, JSON.stringify(Object.values(store)));

  // 生日表（一次性、已抓過略過）
  const need = [...pitcherIds].filter(id => !bdays[id]);
  console.log(`\n投手生日：已存 ${Object.keys(bdays).length}、待抓 ${need.length}`);
  for (let i = 0; i < need.length; i++) {
    try {
      const r = await get(`${API}/people/${need[i]}`);
      const p = r.data.people && r.data.people[0];
      if (p) bdays[need[i]] = { name: p.fullName, birthDate: p.birthDate || null, birthCity: p.birthCity || null, throws: (p.pitchHand && p.pitchHand.code) || null };
    } catch (e) { /* 略過單筆失敗 */ }
    if (i % 25 === 24) { fs.writeFileSync(bdayPath, JSON.stringify(bdays)); console.log(`   ...生日 ${i + 1}/${need.length}`); }
    await sleep(300);
  }
  fs.writeFileSync(bdayPath, JSON.stringify(bdays));

  console.log(`\n完成。賽事 ${Object.keys(store).length} 場（原 ${beforeG}，本次處理 ${added}，失敗日 ${fail}）`);
  console.log(`生日表 ${Object.keys(bdays).length} 位 → ${bdayPath}`);
  if (unmapped.size) console.log(`⚠ 未對應隊伍ID（已用英文名暫存，請補進 TEAM_CN）: ${[...unmapped].join(', ')}`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
