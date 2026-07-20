/* odds_lab/build_dataset.js — 賠率走向分析的資料建置（2026-07-20）
   來源：data/odds_log.json（Titan：ml 三家含時戳、hd/ou bet365 無時戳序列；已驗證 0 in-play 污染）
   結果：MLB=statsapi 官方；NPB/KBO/CPBL=data/pregame_data.json 的 git 歷史快照（每台灣日取隔日中午版）
   輸出：odds_lab/audit.json（品質審計）、odds_lab/dataset.json（每場一列的特徵+結果）
   用法：node odds_lab/build_dataset.js  （在 repo 根目錄跑；需網路抓 statsapi） */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOG = require(path.join(ROOT, 'data', 'odds_log.json'));

// ---- 小工具 ----
const twDateOf = iso => { const d = new Date(new Date(iso).getTime() + 8 * 3600e3); return d.toISOString().slice(0, 10); };
const get = url => new Promise((res, rej) => https.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

// 去水隱含主勝率（歐賠）
function impHome(home, away) {
  if (!(home > 1) || !(away > 1)) return null;
  const ih = 1 / home, ia = 1 / away;
  return ih / (ih + ia);
}

// ---- 1) 審計 odds_log ----
const audit = { byLeagueDay: {}, issues: [], summary: {} };
const matches = LOG.matches;
let nArchived = 0, nNoStart = 0;
for (const id in matches) {
  const g = matches[id];
  if (String(id).indexOf('@') >= 0) nArchived++;
  if (!g.startISO) { nNoStart++; continue; }
  const d = twDateOf(g.startISO), k = (g.league || '?') + '|' + d;
  const a = audit.byLeagueDay[k] = audit.byLeagueDay[k] || { n: 0, mlOpen: 0, mlClose2: 0, hd2: 0, ou2: 0, ticks: 0 };
  a.n++;
  const books = ['bet365', 'bwin', '12bet'];
  const hasOpen = books.some(b => g.ml && g.ml[b] && g.ml[b].open);
  const liveN = books.reduce((s, b) => s + ((g.ml && g.ml[b] && g.ml[b].live) ? g.ml[b].live.length : 0), 0);
  if (hasOpen) a.mlOpen++;
  if (liveN >= 2) a.mlClose2++;
  a.ticks += liveN;
  const hd = g.hd && g.hd.bet365, ou = g.ou && g.ou.bet365;
  if (Array.isArray(hd) && hd.length >= 2) a.hd2++;
  if (Array.isArray(ou) && ou.length >= 2) a.ou2++;
}
audit.summary = { totalMatches: Object.keys(matches).length, archivedEntries: nArchived, noStartISO: nNoStart };

// ---- 2) 結果：MLB via statsapi ----
const TEAM_CN = { 108: '天使', 109: '響尾蛇', 110: '金鶯', 111: '紅襪', 112: '小熊', 113: '紅人', 114: '守護者', 115: '落磯', 116: '老虎', 117: '太空人', 118: '皇家', 119: '道奇', 120: '國民', 121: '大都會', 133: '運動家', 134: '海盜', 135: '教士', 136: '水手', 137: '巨人', 138: '紅雀', 139: '光芒', 140: '遊騎兵', 141: '藍鳥', 142: '雙城', 143: '費城人', 144: '勇士', 145: '白襪', 146: '馬林魚', 147: '洋基', 158: '釀酒人' };
async function fetchMlbResults(fromUtc, toUtc) {
  const out = {}; // key: date|away|home (tw date) → {as,hs}
  for (let t = new Date(fromUtc).getTime(); t <= new Date(toUtc).getTime(); t += 86400e3) {
    const d = new Date(t).toISOString().slice(0, 10);
    try {
      const j = JSON.parse(await get('https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + d));
      (j.dates || []).forEach(dd => (dd.games || []).forEach(g => {
        const st = g.status && g.status.detailedState;
        if (st !== 'Final' && st !== 'Completed Early' && st !== 'Game Over') return;
        const a = g.teams.away, h = g.teams.home;
        const aCN = TEAM_CN[a.team.id], hCN = TEAM_CN[h.team.id];
        if (!aCN || !hCN || a.score == null || h.score == null) return;
        out[twDateOf(g.gameDate) + '|' + aCN + '|' + hCN] = { as: a.score, hs: h.score, src: 'statsapi', startTW: twDateOf(g.gameDate) + 'T' + new Date(new Date(g.gameDate).getTime() + 8 * 3600e3).toISOString().slice(11, 16) };
      }));
    } catch (e) { audit.issues.push('statsapi ' + d + ': ' + e.message); }
    await sleep(250);
  }
  return out;
}

// ---- 3) 結果：亞洲聯盟 via pregame_data git 歷史 ----
function asianResultsFromGit(dates) {
  const commits = execSync('git log --format="%H %cI" -- data/pregame_data.json', { cwd: ROOT, maxBuffer: 64e6 })
    .toString().trim().split('\n').map(l => { const [h, ci] = l.split(' '); return { h, t: new Date(ci).getTime() }; })
    .sort((x, y) => x.t - y.t);
  const out = {};
  for (const D of dates) {
    // 取「台灣 D+1 12:00（UTC D+1 04:00）」後的第一個 commit：D 的亞洲場全數完賽
    const cut = new Date(D + 'T04:00:00Z').getTime() + 86400e3;
    const c = commits.find(x => x.t >= cut) || commits[commits.length - 1];
    if (!c) continue;
    let rows;
    try { rows = JSON.parse(execSync('git show ' + c.h + ':data/pregame_data.json', { cwd: ROOT, maxBuffer: 64e6 }).toString()); }
    catch (e) { audit.issues.push('git show ' + D + ': ' + e.message); continue; }
    const arr = Array.isArray(rows) ? rows : (rows.games || []);
    arr.forEach(r => {
      if (r.date !== D || r.status !== 'finished') return;
      if (r.awayScore == null || r.homeScore == null) return;
      if (r.league === 'MLB') return; // MLB 用官方
      (out[D] = out[D] || []).push({ away: r.awayTeam, home: r.homeTeam, time: r.time || '', as: r.awayScore, hs: r.homeScore, src: 'ps:' + c.h.slice(0, 7) });
    });
  }
  return out;   // { 'YYYY-MM-DD': [rows] } — 隊名用包含式配對（板子全名 vs 玩運彩短名）
}
// 隊名包含式比對（同 pregame-integration 的 tmMatch 精神）＋開球時間就近（KBO 雙重賽）
// 別名：兩邊都不互含的特例（板子名 vs 玩運彩名）
const TEAM_ALIAS = { '韓華鷹': '華老鷹' };
const aliasOf = s => TEAM_ALIAS[s] || s;
const tmMatch = (a, b) => { a = aliasOf(String(a || '').trim()); b = aliasOf(String(b || '').trim()); return !!a && !!b && (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0); };
const hhmmToMin = s => { const m = /(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
function findAsianResult(asiaRes, d, away, home, startISO) {
  const cands = (asiaRes[d] || []).filter(r => tmMatch(away, r.away) && tmMatch(home, r.home));
  if (cands.length <= 1) return cands[0] || null;
  const want = hhmmToMin(new Date(new Date(startISO).getTime() + 8 * 3600e3).toISOString().slice(11, 16));
  let best = cands[0], bd = Infinity;
  for (const r of cands) { const t = hhmmToMin(r.time); if (t == null) continue; const dd = Math.abs(t - want); if (dd < bd) { bd = dd; best = r; } }
  return best;
}

// ---- 4) 特徵 ----
function mlFeatures(g) {
  const books = ['bet365', 'bwin', '12bet'];
  const opens = [], closes = [], closeOddsH = [], closeOddsA = [];
  for (const b of books) {
    const m = g.ml && g.ml[b]; if (!m || !m.open) continue;
    const o = impHome(m.open.home, m.open.away); if (o == null) continue;
    const last = (m.live && m.live.length) ? m.live[m.live.length - 1] : m.open;
    const c = impHome(last.home, last.away); if (c == null) continue;
    opens.push(o); closes.push(c); closeOddsH.push(last.home); closeOddsA.push(last.away);
  }
  if (!opens.length) return null;
  const o = mean(opens), c = mean(closes);
  return { open: o, close: c, dir: c - o, favClose: c >= 0.5 ? 'home' : 'away', closeOddsHome: mean(closeOddsH), closeOddsAway: mean(closeOddsA), books: opens.length };
}
// hd：bet365 港賠序列。line 為字串（相對主隊；符號校準由 analyze 端驗證後使用）
function hdFeatures(g) {
  const s = g.hd && g.hd.bet365;
  if (!Array.isArray(s) || s.length < 2) return null;
  const num = x => { const v = parseFloat(x); return isNaN(v) ? null : v; };
  const f = s[0], l = s[s.length - 1];
  const lo = num(f.line), lc = num(l.line);
  if (lo == null || lc == null) return null;
  // 賠差方向（港賠：主方賠率下降=市場錢進主方）
  return { openLine: lo, closeLine: lc, lineMove: lc - lo,
           openHome: num(f.home), openAway: num(f.away), closeHome: num(l.home), closeAway: num(l.away),
           oddsMoveHome: (num(l.home) != null && num(f.home) != null) ? num(l.home) - num(f.home) : null,
           ticks: s.length };
}
function ouFeatures(g) {
  const s = g.ou && g.ou.bet365;
  if (!Array.isArray(s) || s.length < 2) return null;
  const num = x => { const v = parseFloat(x); return isNaN(v) ? null : v; };
  const f = s[0], l = s[s.length - 1];
  const lo = num(f.line), lc = num(l.line);
  if (lo == null || lc == null) return null;
  return { openLine: lo, closeLine: lc, lineMove: lc - lo,
           openOver: num(f.over), closeOver: num(l.over), openUnder: num(f.under), closeUnder: num(l.under),
           overOddsMove: (num(l.over) != null && num(f.over) != null) ? num(l.over) - num(f.over) : null,
           ticks: s.length };
}

// ---- main ----
(async () => {
  const dateSet = new Set();
  for (const id in matches) { const g = matches[id]; if (g.startISO) dateSet.add(twDateOf(g.startISO)); }
  const dates = [...dateSet].sort();
  console.log('日期範圍:', dates[0], '→', dates[dates.length - 1], '(', dates.length, '天 )');

  console.log('抓 MLB 官方結果…');
  // 台灣日 D 的 MLB 場多在 UTC D-1 開打 → UTC 範圍前推一天
  const fromUtc = new Date(new Date(dates[0] + 'T00:00:00Z').getTime() - 86400e3).toISOString().slice(0, 10);
  const mlbRes = await fetchMlbResults(fromUtc, dates[dates.length - 1]);
  console.log('  MLB 結果', Object.keys(mlbRes).length, '筆');
  console.log('重建亞洲結果（git 歷史）…');
  const asiaRes = asianResultsFromGit(dates);
  console.log('  亞洲結果', Object.keys(asiaRes).length, '筆');

  const rows = []; let joined = 0, unjoined = [];
  for (const id in matches) {
    const g = matches[id];
    if (!g.startISO || String(id).indexOf('@') >= 0) continue;   // 歸檔場不重複計（主列已涵蓋）
    const d = twDateOf(g.startISO);
    const key = d + '|' + g.awayTeam + '|' + g.homeTeam;
    const res = (g.league === 'mlb') ? (mlbRes[key] || null) : findAsianResult(asiaRes, d, g.awayTeam, g.homeTeam, g.startISO);
    const ml = mlFeatures(g), hd = hdFeatures(g), ou = ouFeatures(g);
    if (res) joined++; else unjoined.push(g.league + '|' + key);
    rows.push({ id, league: g.league, date: d, away: g.awayTeam, home: g.homeTeam, startISO: g.startISO,
      ml, hd, ou, res });
  }
  audit.summary.rows = rows.length;
  audit.summary.joined = joined;
  audit.summary.joinRate = +(100 * joined / rows.length).toFixed(1);
  audit.summary.unjoinedSample = unjoined.slice(0, 30);
  audit.summary.unjoinedByLeague = unjoined.reduce((m, k) => { const lg = k.split('|')[0]; m[lg] = (m[lg] || 0) + 1; return m; }, {});

  fs.writeFileSync(path.join(__dirname, 'dataset.json'), JSON.stringify({ built: new Date().toISOString(), rows }, null, 1));
  fs.writeFileSync(path.join(__dirname, 'audit.json'), JSON.stringify(audit, null, 1));
  console.log('join率:', audit.summary.joinRate + '%', '| 未join分佈:', JSON.stringify(audit.summary.unjoinedByLeague));
  console.log('✅ odds_lab/dataset.json (', rows.length, '列 ) + audit.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
