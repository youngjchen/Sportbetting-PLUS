/* odds_lab/forward_check.js — 讓分「反向」的樣本外前瞻檢核（2026-07-31）
   背景：2026-07-20 的 REPORT.md 把「讓分反向＝吃被推走的一邊 @收盤」列為唯一正期望候選
   （in-sample 56.8%/ROI+9.8%），並寫明下一步=前瞻驗證。規則當日已凍結成文字，
   本檔對 7/21 起的比賽（規則從沒看過的資料）套用同一條規則，一字不改。
   邏輯逐字取自 analyze.js（符號校準/homeCover/hdSide/mlSide），只有窗口不同。
   用法：node odds_lab/forward_check.js */
'use strict';
const path = require('path');
const DS = require(path.join(__dirname, 'dataset.json'));

const IS_FROM = '2026-06-17', IS_TO = '2026-07-20';        // in-sample（7/20 報告的窗）
const OOS_FROM = '2026-07-21', OOS_TO = '2026-07-31';      // 樣本外（規則凍結之後）

const all = DS.rows.filter(r => r.res);

// ---- 符號校準：用「全部」資料算（與 analyze.js 同法；符號是資料格式屬性，非可調參數）----
let neg = 0, pos = 0;
all.forEach(r => {
  if (!r.ml || !r.hd || r.ml.close < 0.60) return;
  if (r.hd.closeLine < 0) neg++; else if (r.hd.closeLine > 0) pos++;
});
const HOME_GIVE_SIGN = neg >= pos ? -1 : 1;
const normLine = L => HOME_GIVE_SIGN === -1 ? L : -L;
const homeCover = (r, L) => { const m = (r.res.hs - r.res.as) + normLine(L); return m === 0 ? null : m > 0; };

const ML_TH = 0.015;
function mlSide(r) { if (!r.ml || r.ml.books < 2) return null; const d = r.ml.dir; return Math.abs(d) < ML_TH ? null : (d > 0 ? 'home' : 'away'); }
function hdSide(r) {
  if (!r.hd) return null;
  const lm = normLine(r.hd.closeLine) - normLine(r.hd.openLine);
  if (lm !== 0) return lm < 0 ? 'home' : 'away';
  const om = r.hd.oddsMoveHome;
  if (om == null || om === 0) return null;
  return om < 0 ? 'home' : 'away';
}

function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
const pct = x => (100 * x).toFixed(1) + '%';

function mkCell() { return { n: 0, k: 0, roi: 0, odds: [], push: 0 }; }
function addHit(c, ok, odds, isPush) {
  if (isPush) { c.push++; return; }
  c.n++; if (ok) c.k++;
  if (odds != null) { c.odds.push(odds); c.roi += ok ? odds : -1; }
}
function fmt(c) {
  if (!c.n) return '（無樣本）';
  const p = c.k / c.n, [lo, hi] = wilson(c.k, c.n);
  const avg = c.odds.length ? c.odds.reduce((s, x) => s + x, 0) / c.odds.length : null;
  const be = avg != null ? 1 / (1 + avg) : null;
  const roi = c.odds.length ? c.roi / c.n : null;
  let z = null;
  if (be != null && c.n >= 10) z = (p - be) / Math.sqrt(be * (1 - be) / c.n);
  return `${c.k}/${c.n}${c.push ? '(走' + c.push + ')' : ''}  ${pct(p)} [${pct(lo)},${pct(hi)}]  兩平${be != null ? pct(be) : '—'}  ROI ${roi != null ? (100 * roi).toFixed(1) + '%' : '—'}${z != null ? '  z=' + z.toFixed(2) : ''}`;
}

function runWindow(from, to) {
  const rows = all.filter(r => r.date >= from && r.date <= to);
  const T = {
    fadeAll: mkCell(), followAll: mkCell(),
    fadeMoved: mkCell(), fadeOddsOnly: mkCell(),
    fadeMlb: mkCell(), fadeNpb: mkCell(), fadeKbo: mkCell(), fadeCpbl: mkCell(),
    conflictHdMl: mkCell(),
  };
  for (const r of rows) {
    const hs = hdSide(r);
    if (hs && r.hd) {
      const cov = homeCover(r, r.hd.closeLine);
      if (cov != null) {
        const okFollow = hs === 'home' ? cov : !cov;
        const followOdds = hs === 'home' ? r.hd.closeHome : r.hd.closeAway;
        const fadeOdds = hs === 'home' ? r.hd.closeAway : r.hd.closeHome;
        addHit(T.followAll, okFollow, followOdds, false);
        addHit(T.fadeAll, !okFollow, fadeOdds, false);
        const lineMoved = normLine(r.hd.closeLine) !== normLine(r.hd.openLine);
        addHit(lineMoved ? T.fadeMoved : T.fadeOddsOnly, !okFollow, fadeOdds, false);
        const lgCell = { mlb: T.fadeMlb, npb: T.fadeNpb, kbo: T.fadeKbo, cpbl: T.fadeCpbl }[r.league];
        if (lgCell) addHit(lgCell, !okFollow, fadeOdds, false);
      }
    }
    // 矛盾場：獨贏×讓分反推、讓分注跟獨贏側
    const ms = mlSide(r);
    if (ms && hs && ms !== hs && r.hd) {
      const cov = homeCover(r, r.hd.closeLine);
      if (cov != null) {
        const ok = ms === 'home' ? cov : !cov;
        addHit(T.conflictHdMl, ok, ms === 'home' ? r.hd.closeHome : r.hd.closeAway, false);
      }
    }
  }
  return { rows: rows.length, T };
}

const IS = runWindow(IS_FROM, IS_TO);
const OOS = runWindow(OOS_FROM, OOS_TO);

console.log('hd 線符號校準（全資料）：主讓=' + (HOME_GIVE_SIGN < 0 ? '負' : '正') + `（負${neg}/正${pos}）`);
console.log('');
console.log('════════ 讓分「反向」前瞻檢核：in-sample（規則誕生的窗） vs 樣本外（規則凍結後） ════════');
console.log(`in-sample ${IS_FROM}～${IS_TO}：${IS.rows} 場有結果`);
console.log(`樣本外    ${OOS_FROM}～${OOS_TO}：${OOS.rows} 場有結果`);
console.log('');
const P = (label, k) => {
  console.log('◆ ' + label);
  console.log('   in-sample  ' + fmt(IS.T[k]));
  console.log('   樣本外     ' + fmt(OOS.T[k]));
};
P('反向全體（吃被推走的一邊 @收盤）', 'fadeAll');
P('反向・只取線有動', 'fadeMoved');
P('反向・只賠率動', 'fadeOddsOnly');
P('反向・MLB', 'fadeMlb');
P('反向・NPB', 'fadeNpb');
P('反向・KBO', 'fadeKbo');
P('反向・CPBL', 'fadeCpbl');
P('（對照）順向全體＝跟走向側', 'followAll');
P('矛盾場・讓分注跟獨贏側', 'conflictHdMl');
