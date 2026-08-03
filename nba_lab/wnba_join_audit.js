// nba_lab/wnba_join_audit.js — WNBA 雙源聯合稽核（階段0守門）
// ① titan teamA/B 誰是主場：對玩運彩(客/主標定明確)用「日期+比分」雙假設檢定，不賭慣例
// ② titan 收盤讓分正負號語義實證（讓分方勝場一致法 + 玩運彩同側比對）
// ③ 配對率/比分一致  ④ 盤口分布(台彩+titan 守門值)  ⑤ 基準率  ⑥ 自動反推隊名對照表
// 輸入: wnba_titan_games.json + wnba_ps_lines.json
// 輸出: wnba_audit.json + wnba_team_map.json + WNBA_AUDIT_REPORT.md
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';

const titan = R('wnba_titan_games.json');
const teams = R('wnba_titan_teams.json');
const ps = R('wnba_ps_lines.json');
const tName = {}; for (const t of teams) tName[t.id] = t.twS || t.tw;

const played = titan.games.filter(g => g.scoreA != null && g.scoreA !== '' && !isNaN(+g.scoreA));
const psByDate = {};
for (const k in ps.store) { const p = ps.store[k]; (psByDate[p.date] = psByDate[p.date] || []).push(p); }

// ① 日期+比分雙假設（候選清單制；同日同比分對碰=ambiguous 剔除）
// 日期容忍 ±1 天（7/14 23:00 陽光vs火焰案：titan 記 7/14、玩運彩歸 7/15）；比分精確匹配防連日重賽錯配
let hypA = 0, hypB = 0, ambiguous = 0, unmatched = 0;
const joined = [];
const dShift = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
for (const tg of played) {
  const d = tg.timeBJ.slice(0, 10);
  let matched = false;
  for (const cands of [psByDate[d] || [], [...(psByDate[dShift(d, 1)] || []), ...(psByDate[dShift(d, -1)] || [])]]) {   // 同日優先、無中才退±1日
    const mA = cands.filter(p => +p.homeScore === +tg.scoreA && +p.awayScore === +tg.scoreB);   // 假設A: teamA=主
    const mB = cands.filter(p => +p.awayScore === +tg.scoreA && +p.homeScore === +tg.scoreB);   // 假設B: teamA=客
    if (mA.length + mB.length === 0) continue;
    matched = true;
    if (mA.length === 1 && mB.length === 0) { hypA++; joined.push({ tg, p: mA[0], homeIsA: true }); }
    else if (mB.length === 1 && mA.length === 0) { hypB++; joined.push({ tg, p: mB[0], homeIsA: false }); }
    else ambiguous++;
    break;
  }
  if (!matched) unmatched++;
}
const homeIsA = hypA >= hypB;
const orient = { played: played.length, psGames: ps.count, joined: joined.length, hypA, hypB, ambiguous, unmatched,
  verdict: homeIsA ? 'teamA=主場' : 'teamA=客場' };

// ⑥ 隊名對照反推（用實證方向；每 titan id 應收斂到單一玩運彩名）
const mapVotes = {};
for (const { tg, p, homeIsA: hA } of joined) {
  const pairs = hA ? [[tg.teamA, p.home], [tg.teamB, p.away]] : [[tg.teamA, p.away], [tg.teamB, p.home]];
  for (const [id, nm] of pairs) { mapVotes[id] = mapVotes[id] || {}; mapVotes[id][nm] = (mapVotes[id][nm] || 0) + 1; }
}
let mapConflicts = 0;
const teamMap = [];
for (const id in mapVotes) {
  const entries = Object.entries(mapVotes[id]).sort((a, b) => b[1] - a[1]);
  if (entries.length > 1) mapConflicts++;
  teamMap.push({ titanId: +id, titanTw: tName[id] || null, psName: entries[0][0], votes: entries[0][1],
    others: entries.slice(1).map(e => e[0] + 'x' + e[1]) });
}
teamMap.sort((a, b) => a.titanId - b.titanId);

// ② 讓分符號語義（titan closeSpread）＋玩運彩同側率
let sgn = { negAway: 0, negHome: 0, n: 0 };
let psSpreadCompared = 0, psSameSide = 0, psTotCompared = 0, psTotDiffSum = 0;
for (const { tg, p, homeIsA: hA } of joined) {
  const spread = parseFloat(tg.closeSpread);
  const homePts = hA ? +tg.scoreA : +tg.scoreB, awayPts = hA ? +tg.scoreB : +tg.scoreA;
  const margin = homePts - awayPts;
  if (!isNaN(spread) && spread !== 0) {
    sgn.n++;
    if (spread < 0 ? margin < 0 : margin > 0) sgn.negAway++;   // 語義1: 負=客讓 且客真的贏
    if (spread < 0 ? margin > 0 : margin < 0) sgn.negHome++;
    if (p.hdAwayLine != null) {
      psSpreadCompared++;
      const psAwayFav = p.hdAwayLine < 0;                       // 玩運彩(台彩): 負=客讓（selftest 實證）
      if (psAwayFav === (spread < 0)) psSameSide++;             // 對「負=客讓」語義的同側
    }
  }
  const tot = parseFloat(tg.closeTotal);
  if (!isNaN(tot) && p.totLine != null) { psTotCompared++; psTotDiffSum += Math.abs(tot - p.totLine); }
}
const negAwaySemantics = sgn.negAway >= sgn.negHome;

// ③④⑤ 基準率與分布（例行賽已打場；聯盟盃決賽 post_ 段另列不入基準）
const regJoined = joined.filter(j => j.tg.stage.startsWith('regular'));
const cupGames = joined.filter(j => !j.tg.stage.startsWith('regular'));
let homeWins = 0, favWins = 0, favCovers = 0, pushes = 0, overs = 0, totPushes = 0;
const absSpT = [], totT = [], absSpPs = [], totPs = [];
let nonHalfT = 0, nonHalfPs = 0;
for (const { tg, p, homeIsA: hA } of regJoined) {
  const homePts = hA ? +tg.scoreA : +tg.scoreB, awayPts = hA ? +tg.scoreB : +tg.scoreA;
  const margin = homePts - awayPts;
  if (margin > 0) homeWins++;
  const spread = parseFloat(tg.closeSpread);
  if (!isNaN(spread) && spread !== 0) {
    const favM = negAwaySemantics ? (spread < 0 ? -margin : margin) : (spread < 0 ? margin : -margin);
    const line = Math.abs(spread);
    if (favM > 0) favWins++;
    if (favM - line > 0) favCovers++; else if (favM - line === 0) pushes++;
    absSpT.push(line); if ((line * 2) % 2 !== 1) nonHalfT++;
  }
  const tot = parseFloat(tg.closeTotal);
  if (!isNaN(tot)) { totT.push(tot); if (homePts + awayPts > tot) overs++; else if (homePts + awayPts === tot) totPushes++; }
  if (p.hdAwayLine != null) { absSpPs.push(Math.abs(p.hdAwayLine)); if ((Math.abs(p.hdAwayLine) * 2) % 2 !== 1) nonHalfPs++; }
  if (p.totLine != null) totPs.push(p.totLine);
}
const q = (arr, p2) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(p2 * (a.length - 1))] : null; };
const distOf = (arr) => ({ n: arr.length, min: q(arr, 0), p25: q(arr, .25), med: q(arr, .5), p75: q(arr, .75), p95: q(arr, .95), max: q(arr, 1) });

const audit = {
  builtAt: new Date().toISOString(),
  orientation: orient,
  spreadSemantics: { negAway: sgn.negAway, negHome: sgn.negHome, n: sgn.n,
    verdict: negAwaySemantics ? '負=客讓分方' : '負=主讓分方',
    psAgreement: { compared: psSpreadCompared, sameSide: psSameSide, rate: pct(psSameSide, psSpreadCompared) } },
  totalsCrossCheck: { compared: psTotCompared, meanAbsDiff: psTotCompared ? (psTotDiffSum / psTotCompared).toFixed(2) : null },
  teamMap: { teams: teamMap.length, conflicts: mapConflicts },
  cupGames: cupGames.map(j => ({ id: j.tg.id, date: j.tg.timeBJ, stage: j.tg.stage })),
  baselines: {
    n: regJoined.length,
    homeWinPct: pct(homeWins, regJoined.length),
    favWinPct: pct(favWins, absSpT.length), favCoverPct: pct(favCovers, absSpT.length), pushes,
    overPct: pct(overs, totT.length), totPushes
  },
  distributions: {
    titanSpread: distOf(absSpT), titanTotal: distOf(totT), nonHalfTitanSpread: nonHalfT,
    psSpread: distOf(absSpPs), psTotal: distOf(totPs), nonHalfPsSpread: nonHalfPs,
    psSpreadMissing: regJoined.filter(j => j.p.hdAwayLine == null).length,
    psTotalMissing: regJoined.filter(j => j.p.totLine == null).length
  }
};
fs.writeFileSync(path.join(OUT, 'wnba_audit.json'), JSON.stringify({ audit,
  games: joined.map(({ tg, p, homeIsA: hA }) => ({ id: tg.id, date: p.date, time: p.time || tg.timeBJ.slice(11), titanDate: tg.timeBJ.slice(0, 10), stage: tg.stage,
    home: hA ? (tName[tg.teamA] || tg.teamA) : (tName[tg.teamB] || tg.teamB), away: hA ? (tName[tg.teamB] || tg.teamB) : (tName[tg.teamA] || tg.teamA),
    psHome: p.home, psAway: p.away, homePts: hA ? +tg.scoreA : +tg.scoreB, awayPts: hA ? +tg.scoreB : +tg.scoreA,
    titanSpread: parseFloat(tg.closeSpread), titanTotal: parseFloat(tg.closeTotal),
    psHdAway: p.hdAwayLine, psTot: p.totLine, psMlOffered: p.mlOffered !== false })) }, null, 1));
fs.writeFileSync(path.join(OUT, 'wnba_team_map.json'), JSON.stringify({ builtAt: audit.builtAt, verdict: orient.verdict, teams: teamMap }, null, 1));

const d = audit.distributions;
const md = `# WNBA 2026 回補雙源稽核報告
產出 ${audit.builtAt}

## 配對（titan 已打 ${orient.played} 場 vs 玩運彩 ${orient.psGames} 場）
- join **${orient.joined}** 場｜比分歧義 ${orient.ambiguous}｜對不上 ${orient.unmatched}
- 主客方向: 假設A(teamA=主) ${hypA} vs 假設B(teamA=客) ${hypB} → **${orient.verdict}**
- 隊名對照自動反推 ${audit.teamMap.teams} 隊，衝突 ${audit.teamMap.conflicts}（wnba_team_map.json）
- 聯盟盃/季後賽檔場次: ${audit.cupGames.length} 場（不入例行賽基準）

## 讓分符號（實證）
- titan 收盤讓分: 負=客讓 ${sgn.negAway} vs 負=主讓 ${sgn.negHome}（n=${sgn.n}）→ **${audit.spreadSemantics.verdict}**
- 與台彩(玩運彩)讓分方同側率: ${audit.spreadSemantics.psAgreement.rate}（${psSameSide}/${psSpreadCompared}）
- 大小線交叉: ${audit.totalsCrossCheck.compared} 場、平均絕對差 ${audit.totalsCrossCheck.meanAbsDiff} 分

## 基準率（例行賽 join ${audit.baselines.n} 場）
- 主場勝率 **${audit.baselines.homeWinPct}**
- 讓分方勝率 ${audit.baselines.favWinPct} / 過盤率 **${audit.baselines.favCoverPct}**（push ${pushes}）
- 開大率 **${audit.baselines.overPct}**（titan 收盤線；平大小 ${totPushes}）

## 盤口分布（守門值依據）
- titan |讓分| min ${d.titanSpread.min} / 中位 ${d.titanSpread.med} / p95 ${d.titanSpread.p95} / max ${d.titanSpread.max}（整數線 ${d.nonHalfTitanSpread} 場）
- titan 大小 min ${d.titanTotal.min} / 中位 ${d.titanTotal.med} / max ${d.titanTotal.max}
- 台彩 |讓分| min ${d.psSpread.min} / 中位 ${d.psSpread.med} / max ${d.psSpread.max}（整數線 ${d.nonHalfPsSpread} 場；缺線 ${d.psSpreadMissing} 場）
- 台彩 大小 min ${d.psTotal.min} / 中位 ${d.psTotal.med} / max ${d.psTotal.max}（缺線 ${d.psTotalMissing} 場）
- **建議守門**: 讓分輸入 0.5~${d.titanSpread.max != null ? Math.ceil(d.titanSpread.max) + 3 : '?'}.5、大小 ${d.titanTotal.min != null ? Math.floor(Math.min(d.titanTotal.min, d.psTotal.min == null ? Infinity : d.psTotal.min) - 10) : '?'}~${d.titanTotal.max != null ? Math.ceil(Math.max(d.titanTotal.max, d.psTotal.max == null ? -Infinity : d.psTotal.max) + 10) : '?'}
`;
fs.writeFileSync(path.join(OUT, 'WNBA_AUDIT_REPORT.md'), md);
console.log(md);
