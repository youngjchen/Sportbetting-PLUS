// nba_lab/join_audit.js — 三源聯合稽核（階段1守門）
// ① 主客方向實證(titan teamA/B 誰是主場——用官方比分雙假設檢定,不賭慣例)
// ② titan 收盤讓分正負號語義實證(對玩運彩 客/主 前綴 + 實際勝負)
// ③ 三源比分一致率、配對率  ④ 盤口分布(基準線守門值)  ⑤ 基準率(主勝/讓分方過盤/開大)
// 輸出: nba_lab/audit.json + nba_lab/AUDIT_REPORT.md
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';

const titan = R('titan_games.json');
const tmap = R('nba_team_map.json');
const off = R('official_team_games.json');
const ps = R('ps_lines.json');

const byTitanId = {}; for (const t of tmap.teams) if (t.titanId != null) byTitanId[t.titanId] = t;
const byTri = {}; for (const t of tmap.teams) byTri[t.tricode] = t;
const psDict = tmap.psNameDict;

// 官方: 每 GAME_ID 兩列(隊/對手) → 一場一筆 {dateUS, homeTri, awayTri, homePts, awayPts}
const offRaw = {};
for (const r of off) (offRaw[r.GAME_ID] = offRaw[r.GAME_ID] || []).push(r);
const offList = [];
for (const gid in offRaw) {
  const rows = offRaw[gid]; if (rows.length !== 2) continue;
  const vs = rows.find(r => r.MATCHUP.includes(' vs. '));
  let home, away, neutral = false;
  if (vs) { home = vs; away = rows.find(r => r !== vs); }
  else {
    // 中立場(墨西哥城/NBA盃/歐洲賽): 兩列皆 "@" 互為鏡像 → 任取列0解析 "X @ Y",Y=名義主場
    // 主客真偽由後續比分雙假設檢定裁定,任意指派無害
    neutral = true;
    const m = /@\s+([A-Z]{3})/.exec(rows[0].MATCHUP);
    home = m && rows[1].TEAM_ABBREVIATION === m[1] ? rows[1] : rows[0];
    away = home === rows[0] ? rows[1] : rows[0];
  }
  offList.push({ id: gid, dateUS: home.GAME_DATE, st: home.SEASON_TYPE, neutral,
    homeTri: home.TEAM_ABBREVIATION, homePts: home.PTS, awayTri: away.TEAM_ABBREVIATION, awayPts: away.PTS });
}

// 官方日期=美國日 → 台灣日通常 +1（GMT+8 上午）；titan timeBJ 已是 GMT+8
// 官方 join 鍵: 兩隊 tricode + ±1 天容忍;同鍵存「候選清單」防連日同對戰重賽碰撞(last-win 曾造成 9 場錯配)
const offKey = {};
for (const g of offList) {
  for (const dd of [0, 1]) {
    const d = new Date(g.dateUS + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + dd);
    const k = `${d.toISOString().slice(0, 10)}|${g.awayTri}|${g.homeTri}`;
    (offKey[k] = offKey[k] || []).push(g);
  }
}

// ① 方向雙假設
let hypA = 0, hypB = 0, joined = 0, scoreMismatch = 0;
const joinedGames = [];
for (const tg of titan.games) {
  const A = byTitanId[tg.teamA], B = byTitanId[tg.teamB];
  if (!A || !B) continue;
  const d = tg.timeBJ.slice(0, 10);
  // 假設A: teamA=主 → 候選中找比分精確吻合者;假設B 同理(候選清單防連日重賽錯配)
  const candA = offKey[`${d}|${B.tricode}|${A.tricode}`] || [];
  const candB = offKey[`${d}|${A.tricode}|${B.tricode}`] || [];
  if (!candA.length && !candB.length) continue;
  joined++;
  const gA = candA.find(g => +tg.scoreA === +g.homePts && +tg.scoreB === +g.awayPts);
  const gB = candB.find(g => +tg.scoreA === +g.awayPts && +tg.scoreB === +g.homePts);
  if (gA) { hypA++; joinedGames.push({ tg, off: gA, homeIsA: true }); }
  else if (gB) { hypB++; joinedGames.push({ tg, off: gB, homeIsA: false }); }
  else scoreMismatch++;
}
const homeIsA = hypA >= hypB;   // 實證方向
const orient = { joined, hypA, hypB, scoreMismatch, verdict: homeIsA ? 'teamA=主場' : 'teamA=客場' };

// ② 讓分符號語義: 用「讓分方是否為較強隊(實際淨勝)」的一致性 + 玩運彩前綴比對
// 候選語義: 負=客讓(棒球慣例) vs 負=主讓
let sgnAgree = { negAway: 0, negHome: 0, n: 0 };
let psJoin = 0, psScoreOk = 0, psSpreadCompared = 0, psSpreadSameSide = 0;
const psStore = ps.store;
for (const { tg, off: g, homeIsA: hA } of joinedGames) {
  const home = hA ? tg.teamA : tg.teamB;
  const spread = parseFloat(tg.closeSpread);
  if (!isNaN(spread) && spread !== 0) {
    const margin = (+g.homePts) - (+g.awayPts);            // 主隊淨勝
    // 語義1: 負=客讓 → 客為讓分方(強) → 期望 margin<0 較常
    sgnAgree.n++;
    if (spread < 0 ? margin < 0 : margin > 0) sgnAgree.negAway++;   // 負=客讓 且客真的贏
    if (spread < 0 ? margin > 0 : margin < 0) sgnAgree.negHome++;
  }
  // 玩運彩 join: 台灣日 + 短名
  const d = tg.timeBJ.slice(0, 10);
  const homeT = byTri[hA ? byTitanId[tg.teamA].tricode : byTitanId[tg.teamB].tricode];
  const awayT = byTri[hA ? byTitanId[tg.teamB].tricode : byTitanId[tg.teamA].tricode];
  for (const an of awayT.psNames) for (const hn of homeT.psNames) {
    const p = psStore[`${d}|${an}|${hn}`];
    if (p) {
      psJoin++;
      if (p.awayScore != null && +p.awayScore === +(hA ? tg.scoreB : tg.scoreA) && +p.homeScore === +(hA ? tg.scoreA : tg.scoreB)) psScoreOk++;
      // 讓分方向比對: ps hdAwayLine 正=客讓 | titan spread 語義待定 → 比「誰是讓分方」
      if (p.hdAwayLine != null && !isNaN(spread) && spread !== 0) {
        psSpreadCompared++;
        const psAwayFav = p.hdAwayLine < 0;                    // 「客-5.5」=客讓 → parseDay 存負值
        const titanAwayFavIfNegAway = spread < 0;
        if (psAwayFav === titanAwayFavIfNegAway) psSpreadSameSide++;
      }
      break;
    }
  }
}

// ③④⑤ 用實證方向重整所有場次
const games = [];
for (const { tg, off: g, homeIsA: hA } of joinedGames) {
  const spread = parseFloat(tg.closeSpread), total = parseFloat(tg.closeTotal);
  const homePts = +g.homePts, awayPts = +g.awayPts;
  games.push({ id: tg.id, date: tg.timeBJ.slice(0, 10), stage: tg.stage,
    home: g.homeTri, away: g.awayTri, homePts, awayPts,
    spread: isNaN(spread) ? null : spread, total: isNaN(total) ? null : total });
}
const reg = games.filter(g => g.stage.startsWith('regular'));
const withSp = games.filter(g => g.spread != null && g.spread !== 0);
const withTot = games.filter(g => g.total != null);
// 語義按多數決定: awayFavWhenNeg
const negAwaySemantics = sgnAgree.negAway >= sgnAgree.negHome;
const favMargin = (g) => negAwaySemantics ? (g.spread < 0 ? (g.awayPts - g.homePts) : (g.homePts - g.awayPts))
                                          : (g.spread < 0 ? (g.homePts - g.awayPts) : (g.awayPts - g.homePts));
let homeWins = 0, favWins = 0, favCovers = 0, overs = 0, pushes = 0;
for (const g of reg) { if (g.homePts > g.awayPts) homeWins++; }
for (const g of withSp) {
  const fm = favMargin(g); const line = Math.abs(g.spread);
  if (fm > 0) favWins++;
  if (fm - line > 0) favCovers++; else if (fm - line === 0) pushes++;
}
for (const g of withTot) if (g.homePts + g.awayPts > g.total) overs++;

const absSp = withSp.map(g => Math.abs(g.spread)).sort((a, b) => a - b);
const tots = withTot.map(g => g.total).sort((a, b) => a - b);
const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
const dist = {
  spread: { n: absSp.length, min: absSp[0], p25: q(absSp, .25), med: q(absSp, .5), p75: q(absSp, .75), p95: q(absSp, .95), max: absSp[absSp.length - 1] },
  total: { n: tots.length, min: tots[0], p25: q(tots, .25), med: q(tots, .5), p75: q(tots, .75), p95: q(tots, .95), max: tots[tots.length - 1] },
  nonHalfSpread: withSp.filter(g => Math.abs(g.spread * 2) % 2 !== 1).length,
  nonHalfTotal: withTot.filter(g => (g.total * 2) % 2 !== 1).length
};

const audit = {
  builtAt: new Date().toISOString(),
  counts: { titan: titan.count, official: offList.length, joined, psGames: ps.count, psJoin },
  orientation: orient,
  spreadSemantics: { negAway: sgnAgree.negAway, negHome: sgnAgree.negHome, n: sgnAgree.n,
    verdict: negAwaySemantics ? '負=客讓分方(同棒球)' : '負=主讓分方(與棒球相反)',
    psAgreement: { compared: psSpreadCompared, sameSide: psSpreadSameSide, rate: pct(psSpreadSameSide, psSpreadCompared) } },
  scoreCheck: { psScoreOk, psJoin, rate: pct(psScoreOk, psJoin) },
  baselines: {
    homeWinPct_regular: pct(homeWins, reg.length),
    favWinPct: pct(favWins, withSp.length),
    favCoverPct: pct(favCovers, withSp.length),
    overPct: pct(overs, withTot.length),
    pushes
  },
  distributions: dist
};
fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify({ audit, games }, null, 1));

const md = `# NBA 2025-26 回補聯合稽核報告
產出 ${audit.builtAt}

## 配對
- 球探網 ${titan.count} 場 / 官方 ${offList.length} 場 / 三源 join ${joined} 場（比分不符 ${scoreMismatch}）
- 玩運彩 ${ps.count} 場,與 join 集合對上 ${psJoin} 場,比分一致 ${audit.scoreCheck.rate}

## 方向與符號（實證,非慣例假設）
- titan 主客: 假設A(teamA=主) ${hypA} vs 假設B ${hypB} → **${orient.verdict}**
- titan 收盤讓分符號: 負=客讓 ${sgnAgree.negAway} vs 負=主讓 ${sgnAgree.negHome}（讓分方勝場一致法,n=${sgnAgree.n}）→ **${audit.spreadSemantics.verdict}**
- 與玩運彩讓分方同側率: ${audit.spreadSemantics.psAgreement.rate}（${psSpreadSameSide}/${psSpreadCompared},跨書真實差異屬正常）

## 基準率（例行賽 ${reg.length} 場）
- 主場勝率 **${audit.baselines.homeWinPct_regular}**
- 收盤讓分方勝率 ${audit.baselines.favWinPct} / 過盤率 **${audit.baselines.favCoverPct}**（push ${pushes}）
- 開大率 **${audit.baselines.overPct}**（titan 收盤大小線）

## 盤口分布（基準線守門值依據）
- |讓分| min ${dist.spread.min} / 中位 ${dist.spread.med} / p95 ${dist.spread.p95} / max ${dist.spread.max}
- 大小 min ${dist.total.min} / 中位 ${dist.total.med} / p95 ${dist.total.p95} / max ${dist.total.max}
- 非半分線: 讓分 ${dist.nonHalfSpread} 場 / 大小 ${dist.nonHalfTotal} 場（bet365 有整數線；台彩/STAKE 半分制,板上輸入欄仍鎖半分）
- **建議守門**: 讓分輸入 0.5~${Math.ceil(dist.spread.max) + 3}.5、大小 ${Math.floor(dist.total.min - 10)}~${Math.ceil(dist.total.max + 10)}
`;
fs.writeFileSync(path.join(OUT, 'AUDIT_REPORT.md'), md);
console.log(md);
