/* ============================================================
   映射對稱性模擬（協議 v0.2 §3 前提；statistical-analyst 判準）
   用「實際賽程時刻（台北）」跑梅花引擎，統計押大比例與五關係分布。
   判準：|押大% − 50%| ≤ 0.5pp。超標 → 依協議 §6 預定規則改「排除比和場」，並檢驗排除後偏差。
   紀律：輸入檔只有 日期/時間/隊名/盤口線，**不含任何比賽結果**——本模擬全程結果盲。
   用法：node meihua_symmetry.js
   ============================================================ */
'use strict';
const eng = require('./meihua_engine.js');
const rows = require('./data/playsport_totals_history.json');

let n = 0, skip = 0, nEx = 0;
const rel = {}, pick = { 體: 0, 用: 0 }, pickEx = { 體: 0, 用: 0 };
const cells = new Set();          // 獨立起卦格 = 日期×時辰（同格比賽共享同一卦 → 聚類資訊）
const byYearBig = {}, byYearN = {};

for (const g of rows) {
  if (!g.date || !g.time) { skip++; continue; }
  const [Y, M, D] = g.date.split('-').map(Number);
  const [h, mi] = g.time.split(':').map(Number);
  let r;
  try { r = eng.castFromTaipei(Y, M, D, h, mi); } catch (e) { skip++; continue; }
  n++;
  rel[r.relation] = (rel[r.relation] || 0) + 1;
  pick[r.pick]++;
  cells.add(g.date + '#' + r.nHour);
  const y = g.date.slice(0, 4);
  byYearN[y] = (byYearN[y] || 0) + 1; if (r.pick === '體') byYearBig[y] = (byYearBig[y] || 0) + 1;
  if (r.relation !== '比和') { nEx++; pickEx[r.pick]++; }
}

const pct = (a, b) => (100 * a / b).toFixed(2) + '%';
console.log(`樣本 ${n}（跳過無時間/轉換失敗 ${skip}）  獨立起卦格(日×時辰) ${cells.size}`);
console.log('五關係分布:', JSON.stringify(rel));
console.log(`規則A（比和→體方）   押大 ${pct(pick.體, n)}  押小 ${pct(pick.用, n)}`);
console.log(`規則B（排除比和）     押大 ${pct(pickEx.體, nEx)}  押小 ${pct(pickEx.用, nEx)}  保留 ${nEx} (${pct(nEx, n)})`);
const yearly = {}; for (const y in byYearN) yearly[y] = pct(byYearBig[y], byYearN[y]);
console.log('規則A 各年押大%:', JSON.stringify(yearly));
const devA = Math.abs(100 * pick.體 / n - 50), devB = Math.abs(100 * pickEx.體 / nEx - 50);
console.log(`\n判準 |押大−50%| ≤ 0.5pp：規則A 偏差 ${devA.toFixed(2)}pp → ${devA <= 0.5 ? '通過' : '不通過'}；規則B 偏差 ${devB.toFixed(2)}pp → ${devB <= 0.5 ? '通過' : '不通過'}`);
