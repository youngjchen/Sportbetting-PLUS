// nba_lab/rating_model.js — 球隊評分引擎 + 模型%校準考試（階段1任務7+8）
// A) 自算回合數/攻防效率(box score 公式) → 對官方進階表對答案（引擎正確性）
// B) walk-forward 逐日評分(貝葉斯收縮) → 預期分差 → 常態轉勝率（Stern 模型）
//    → 分檔校準 / 準確率 / Brier / 對收盤線 MAE（模型%上卡片的資格考）
// 嚴格賽前資訊: 每場只用該場開打前的資料。N0/HFA/σ 用網格在前半季擬合、後半季驗證。
// 輸出: nba_lab/MODEL_REPORT.md + model_eval.json
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));

const off = R('official_team_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');
const adv = R('official_advanced.json');
const { games: auditGames } = R('audit.json');   // 已实证方向的场次(含 titan 收盘线)

// ---------- A) 引擎: 每隊-場回合數與效率 ----------
// possessions ≈ FGA − OREB + TOV + 0.44×FTA
const poss = (r) => r.FGA - r.OREB + r.TOV + 0.44 * r.FTA;
const byGame = {};
for (const r of off) (byGame[r.GAME_ID] = byGame[r.GAME_ID] || []).push(r);
const teamAgg = {};   // tri -> {pts, opts, poss, oposs, n}
const gameRows = [];  // {date, homeTri, awayTri, homePts, awayPts}
for (const gid in byGame) {
  const pair = byGame[gid]; if (pair.length !== 2) continue;
  const [x, y] = pair;
  for (const [me, opp] of [[x, y], [y, x]]) {
    const a = teamAgg[me.TEAM_ABBREVIATION] = teamAgg[me.TEAM_ABBREVIATION] || { pts: 0, opts: 0, poss: 0, oposs: 0, n: 0 };
    a.pts += me.PTS; a.opts += opp.PTS; a.poss += poss(me); a.oposs += poss(opp); a.n++;
  }
  const home = x.MATCHUP.includes(' vs. ') ? x : y;
  const away = home === x ? y : x;
  gameRows.push({ gid, date: home.GAME_DATE, homeTri: home.TEAM_ABBREVIATION, awayTri: away.TEAM_ABBREVIATION,
    homePts: home.PTS, awayPts: away.PTS,
    homePoss: poss(home), awayPoss: poss(away) });
}
gameRows.sort((a, b) => a.date < b.date ? -1 : 1);

// 對官方進階表對答案
let mae = 0, n30 = 0, lines = [];
for (const r of adv) {
  const tri = Object.keys(teamAgg).find(t => {
    const rows = off.filter(o => o.TEAM_ID === r.TEAM_ID); return rows.length && rows[0].TEAM_ABBREVIATION === t;
  });
  if (!tri) continue;
  const a = teamAgg[tri];
  const myOff = 100 * a.pts / a.poss, myDef = 100 * a.opts / a.oposs, myNet = myOff - myDef;
  mae += Math.abs(myNet - r.NET_RATING); n30++;
  lines.push({ tri, myNet: +myNet.toFixed(2), official: r.NET_RATING });
}
mae /= n30;
lines.sort((a, b) => b.myNet - a.myNet);

// ---------- B) walk-forward 校準 ----------
// 逐日狀態: 每隊累計 pts/opts/poss/oposs → 賽前 net rating(每百回合) + 收縮 netShrunk = net * n/(n+N0)
function walkForward(N0, HFA, SIGMA) {
  const st = {}; const preds = [];
  const S = (t) => st[t] = st[t] || { pts: 0, opts: 0, poss: 0, oposs: 0, n: 0 };
  for (const g of gameRows) {
    const h = S(g.homeTri), a = S(g.awayTri);
    const net = (x) => x.n === 0 ? 0 : (100 * x.pts / x.poss - 100 * x.opts / x.oposs) * (x.n / (x.n + N0));
    const pace = (x) => x.n === 0 ? 99 : (x.poss + x.oposs) / (2 * x.n);
    const expPoss = (pace(h) + pace(a)) / 2;
    const margin = (net(h) - net(a)) * expPoss / 100 + HFA;
    const p = 0.5 * (1 + erf(margin / (SIGMA * Math.SQRT2)));
    preds.push({ date: g.date, gid: g.gid, p, margin, actual: g.homePts - g.awayPts, nMin: Math.min(h.n, a.n) });
    // 更新
    h.pts += g.homePts; h.opts += g.awayPts; h.poss += g.homePoss; h.oposs += g.awayPoss; h.n++;
    a.pts += g.awayPts; a.opts += g.homePts; a.poss += g.awayPoss; a.oposs += g.homePoss; a.n++;
  }
  return preds;
}
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const evalPreds = (preds) => {
  let brier = 0, acc = 0, n = 0;
  for (const p of preds) { const y = p.actual > 0 ? 1 : 0; brier += (p.p - y) ** 2; acc += ((p.p > 0.5) === (y === 1)) ? 1 : 0; n++; }
  return { brier: brier / n, acc: acc / n, n };
};

// 網格擬合(前半季) → 後半季驗證
const half = gameRows[Math.floor(gameRows.length / 2)].date;
let best = null;
for (const N0 of [5, 10, 15, 20]) for (const HFA of [1.5, 2, 2.5, 3]) for (const SIGMA of [11, 12, 13, 14]) {
  const preds = walkForward(N0, HFA, SIGMA).filter(p => p.date < half && p.nMin >= 3);
  const e = evalPreds(preds);
  if (!best || e.brier < best.e.brier) best = { N0, HFA, SIGMA, e };
}
const { N0, HFA, SIGMA } = best;
const all = walkForward(N0, HFA, SIGMA);
const test = all.filter(p => p.date >= half);
const testEval = evalPreds(test);

// 分檔校準(全季, 排除前3場冷啟動)
const buckets = {};
for (const p of all.filter(p => p.nMin >= 3)) {
  const b = Math.min(9, Math.floor(Math.max(p.p, 1 - p.p) * 10));   // 以熱門方 0.5~1.0 分檔
  const key = `${(b * 10)}-${(b + 1) * 10}%`;
  const B = buckets[key] = buckets[key] || { n: 0, hit: 0 };
  B.n++; if ((p.p > 0.5) === (p.actual > 0)) B.hit++;
}

// 對收盤線 MAE: audit.games 有 titan 收盤讓分(已实证语义) → 轉主隊預期分差
const spreadByGid = {};   // 先把 audit games join 官方 gid: 依 date+teams
const key2gid = {}; for (const g of gameRows) key2gid[`${g.homeTri}|${g.awayTri}|${g.homePts}|${g.awayPts}`] = g.gid;
let mkt = { n: 0, modelMAE: 0, marketMAE: 0, modelAcc: 0, marketAcc: 0 };
const audit = R('audit.json').audit;
const negAway = audit.spreadSemantics.verdict.includes('客');
const predByGid = {}; for (const p of all) predByGid[p.gid] = p;
for (const g of auditGames.filter(g => g.stage.startsWith('regular') && g.spread != null)) {
  const gid = key2gid[`${g.home}|${g.away}|${g.homePts}|${g.awayPts}`]; if (!gid) continue;
  const p = predByGid[gid]; if (!p || p.nMin < 3) continue;
  // 市場預期主隊淨勝: 負=客讓→主隊預期 -|sp| 若客讓 / +|sp| 若主讓
  const awayFav = negAway ? g.spread < 0 : g.spread > 0;
  const mktMargin = awayFav ? -Math.abs(g.spread) : Math.abs(g.spread);
  const act = g.homePts - g.awayPts;
  mkt.n++;
  mkt.modelMAE += Math.abs(p.margin - act); mkt.marketMAE += Math.abs(mktMargin - act);
  if ((p.margin > 0) === (act > 0)) mkt.modelAcc++;
  if ((mktMargin > 0) === (act > 0)) mkt.marketAcc++;
}
if (mkt.n) { mkt.modelMAE /= mkt.n; mkt.marketMAE /= mkt.n; mkt.modelAcc /= mkt.n; mkt.marketAcc /= mkt.n; }

const report = `# NBA 模型%引擎 校準報告（2025-26 walk-forward）
產出 ${new Date().toISOString()}

## A) 自算效率引擎 vs 官方進階表
- 30 隊 net rating 自算 vs 官方 MAE = **${mae.toFixed(2)}**（回合數公式估計 vs 官方精確計數,<1.5 即合格）
- Top3: ${lines.slice(0, 3).map(l => `${l.tri} ${l.myNet}(官方${l.official})`).join(' / ')}

## B) 模型%資格考（嚴格賽前資訊,前半季擬合/後半季驗證）
- 擬合參數: 收縮先驗 N0=**${N0} 場**、主場優勢 HFA=**${HFA} 分**、分差σ=**${SIGMA}**
- 後半季 out-of-sample: 勝負準確率 **${(testEval.acc * 100).toFixed(1)}%**、Brier **${testEval.brier.toFixed(4)}**（n=${testEval.n}）
- 對照市場(titan 收盤線): 模型分差 MAE **${mkt.modelMAE.toFixed(2)}** vs 市場 **${mkt.marketMAE.toFixed(2)}**;
  勝負準確率 模型 **${(mkt.modelAcc * 100).toFixed(1)}%** vs 市場讓分方 **${(mkt.marketAcc * 100).toFixed(1)}%**（n=${mkt.n}）

## 分檔校準（模型說 X% 時實際中率;上卡片資格的核心）
${Object.keys(buckets).sort().map(k => `- ${k}: 實際 ${(100 * buckets[k].hit / buckets[k].n).toFixed(1)}% (n=${buckets[k].n})`).join('\n')}

## 判讀
- 模型% 定位=卡片參考欄(對照盤口%找異常),非下注優勢;預期就是輸市場 1-2 分 MAE。
- 冷啟動: nMin<3 的場次已排除;正式版開季前 N 場標「樣本不足」,陣容先驗(球員層)為既定升級路線。
`;
fs.writeFileSync(path.join(OUT, 'MODEL_REPORT.md'), report);
fs.writeFileSync(path.join(OUT, 'model_eval.json'), JSON.stringify({ params: { N0, HFA, SIGMA }, engineMAE: mae, testEval, buckets, market: mkt }, null, 1));
console.log(report);
