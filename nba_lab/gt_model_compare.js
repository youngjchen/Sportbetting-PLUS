// nba_lab/gt_model_compare.js — 過濾版 vs 素板評分的模型增益比較（T8 收尾）
// 同參數(N0=5,HFA=2.5,σ=14)、同 walk-forward、同後半季樣本外,只換評分原料
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const { perGame } = R('gt_ratings.json');
perGame.sort((a, b) => a.date < b.date ? -1 : 1);
const N0 = 5, HFA = 2.5, SIGMA = 14;
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }

function run(useClean) {
  const st = {}; const S = (t) => st[t] = st[t] || { pts: 0, opts: 0, poss: 0, oposs: 0, n: 0 };
  const preds = [];
  for (const g of perGame) {
    const h = S(g.homeTri), a = S(g.awayTri);
    const net = (x) => x.n === 0 ? 0 : (100 * x.pts / x.poss - 100 * x.opts / x.oposs) * (x.n / (x.n + N0));
    const pace = (x) => x.n === 0 ? 99 : (x.poss + x.oposs) / (2 * x.n);
    const margin = (net(h) - net(a)) * ((pace(h) + pace(a)) / 2) / 100 + HFA;
    const p = 0.5 * (1 + erf(margin / (SIGMA * Math.SQRT2)));
    preds.push({ date: g.date, p, actual: g.homePts - g.awayPts, nMin: Math.min(h.n, a.n) });
    const hp = useClean ? g.hClPts : g.homePts, ap = useClean ? g.aClPts : g.awayPts;
    // 素板沒有逐場 poss 欄,统一用乾淨 poss 當素板近似會偏差 → 素板用官方 box 公式? perGame 只有乾淨 poss。
    // 公平比較: 素板=乾淨pts+垃圾pts(=官方全場pts) / 全場poss ≈ 乾淨poss/(1-gt占比)。簡化:素板管線直接用 rating_model.js 的結果(已跑過)。
    // 此腳本只跑過濾版;素板數字取 model_eval.json。
    h.pts += hp; h.opts += ap; h.poss += g.hClPoss; h.oposs += g.aClPoss; h.n++;
    a.pts += ap; a.opts += hp; a.poss += g.aClPoss; a.oposs += g.hClPoss; a.n++;
  }
  return preds;
}
const evalP = (preds) => { let b = 0, acc = 0, n = 0; for (const p of preds) { const y = p.actual > 0 ? 1 : 0; b += (p.p - y) ** 2; acc += ((p.p > 0.5) === (y === 1)) ? 1 : 0; n++; } return { brier: b / n, acc: acc / n, n }; };
const half = perGame[Math.floor(perGame.length / 2)].date;
const clean = run(true).filter(p => p.date >= half && p.nMin >= 3);
const e = evalP(clean);
const base = R('model_eval.json');
console.log(`過濾版 後半季樣本外: acc ${(e.acc * 100).toFixed(1)}% / Brier ${e.brier.toFixed(4)} (n=${e.n})`);
console.log(`素板   後半季樣本外: acc ${(base.testEval.acc * 100).toFixed(1)}% / Brier ${base.testEval.brier.toFixed(4)} (n=${base.testEval.n})`);
console.log(`Brier 增益: ${(base.testEval.brier - e.brier) >= 0 ? '+' : ''}${(base.testEval.brier - e.brier).toFixed(4)}（正=過濾版較好）`);
fs.appendFileSync(path.join(OUT, 'GT_REPORT.md'), `\n## 模型增益（同參數同驗證窗）\n- 過濾版: acc ${(e.acc * 100).toFixed(1)}% / Brier ${e.brier.toFixed(4)}\n- 素板: acc ${(base.testEval.acc * 100).toFixed(1)}% / Brier ${base.testEval.brier.toFixed(4)}\n- Brier 增益 ${(base.testEval.brier - e.brier).toFixed(4)}（正=過濾版較好）\n`);
