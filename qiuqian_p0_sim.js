/* ============================================================
   求籤臂 p₀ 認證（divination-lab 實驗 Q）
   兩路並行、必須吻合（M/L 慣例：理論 × 模擬交叉驗證）：
   A) 解析解：籤號均勻 ⇒ 各層傾向 = 表上 吉/凶/棄 計數 ÷ 60（精確）；
      p₀(層,市場) = [c吉·B + c凶·(1−B)] / (c吉+c凶)，B=該市場「吉方向」歷史基準率
      （totals=over 率、ml=主勝率、hd=熱門過盤率；divination_lab/qiuqian_base_rates.json）
   B) 蒙地卡羅：qiuqian_engine 全儀式 ×N（含允筊/確筊、D3′ 改日再問棄場、拒絕采樣）
      → 驗證籤號均勻、棄場率、傾向與解析解一致（容差 3σ）。
   輸出：divination_lab/qiuqian_p0_certification.json（凍結清單成員）
   用法：node qiuqian_p0_sim.js [--mc 1000000] [--allow-unfrozen]
   ============================================================ */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const eng = require('./qiuqian_engine.js');

const N = (() => { const i = process.argv.indexOf('--mc'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 1000000; })();
const ALLOW_UNFROZEN = process.argv.includes('--allow-unfrozen');

const tabsMain = JSON.parse(fs.readFileSync('divination_lab/qiuqian_layer_tables.json', 'utf8'));
const tabs3 = JSON.parse(fs.readFileSync('divination_lab/qiuqian_layer3_table.json', 'utf8'));
if (!ALLOW_UNFROZEN && (!tabsMain.frozen || !tabs3.frozen)) { console.error('層表未凍結；正式認證須在凍結後執行（暫跑加 --allow-unfrozen）'); process.exit(1); }
const tables = { layer1: tabsMain.layer1, layer2: tabsMain.layer2, layer3: tabs3.layer3 };
const base = JSON.parse(fs.readFileSync('divination_lab/qiuqian_base_rates.json', 'utf8'));
const B = { totals: base.totals.overRate, ml: base.ml.homeWinRate, hd: base.hd.favCoverRate };

// ── A) 解析解 ──
const analytic = {};
for (const L of ['layer1', 'layer2', 'layer3']) {
  const c = { 吉: 0, 凶: 0, 棄: 0 };
  for (let n = 1; n <= 60; n++) {
    const v = tables[L] && tables[L].byLot && tables[L].byLot[n] ? tables[L].byLot[n].verdict : null;
    c[v === '吉' || v === '凶' ? v : '棄']++;
  }
  const dec = c['吉'] + c['凶'];
  analytic[L] = { counts: c, pDecidedGivenLot: dec / 60, pJiGivenDecided: dec ? c['吉'] / dec : null,
    p0: {} };
  for (const mk of ['totals', 'ml', 'hd']) analytic[L].p0[mk] = dec ? (c['吉'] * B[mk] + c['凶'] * (1 - B[mk])) / dec : null;
}

// ── B) 蒙地卡羅 ──
const lotCount = new Array(61).fill(0);
let aborts = 0, abortsYun = 0;
const mcVerdict = { layer1: { 吉: 0, 凶: 0, 棄: 0 }, layer2: { 吉: 0, 凶: 0, 棄: 0 }, layer3: { 吉: 0, 凶: 0, 棄: 0 } };
for (let i = 0; i < N; i++) {
  const ov = crypto.createHash('sha256').update('p0cert|' + i).digest('hex');
  const r = eng.castRitual(ov, 900000 + i, 'totals');
  if (r.aborted) { aborts++; if (r.aborted === 'oracle-yun') abortsYun++; continue; }
  lotCount[r.lot]++;
  const lv = eng.applyLayers(r.lot, tables);
  for (const L of ['layer1', 'layer2', 'layer3']) { const v = lv[L]; mcVerdict[L][v === '吉' || v === '凶' ? v : '棄']++; }
}
const drawn = N - aborts;
let maxDevZ = 0;
for (let n = 1; n <= 60; n++) maxDevZ = Math.max(maxDevZ, Math.abs(lotCount[n] - drawn / 60) / Math.sqrt(drawn / 60));

// ── 吻合檢查（3σ） ──
const checks = { lotUniformMaxZ: maxDevZ, lotUniformOK: maxDevZ < 5, tendencyOK: true, detail: {} };
for (const L of ['layer1', 'layer2', 'layer3']) {
  const pMC = mcVerdict[L]['吉'] / drawn, pAn = analytic[L].counts['吉'] / 60;
  const se = Math.sqrt(pAn * (1 - pAn) / drawn) || 1e-9;
  const z = Math.abs(pMC - pAn) / se;
  checks.detail[L] = { pJi_mc: pMC, pJi_analytic: pAn, z };
  if (z > 3) checks.tendencyOK = false;
}

const out = {
  generatedAt: new Date().toISOString(), mcN: N,
  tablesFrozen: !!(tabsMain.frozen && tabs3.frozen),
  tableHashes: { layer_tables: sha256File('divination_lab/qiuqian_layer_tables.json'), layer3_table: sha256File('divination_lab/qiuqian_layer3_table.json') },
  baseRates: B, baseRateNs: { totals: base.totals.n, ml: base.ml.n, hd: base.hd.n },
  ritual: { abortRate: aborts / N, abortYunShare: aborts ? abortsYun / aborts : null },
  layers: analytic,
  crossCheck: checks,
  sampleBudget: { note: '全季約2,430場×(1−棄場率)×各層有表態率', perLayerEffectivePerSeason: Object.fromEntries(['layer1', 'layer2', 'layer3'].map(L => [L, Math.round(2430 * (1 - aborts / N) * analytic[L].pDecidedGivenLot)])) },
  tripwires: { note: '前瞻各層傾向對本認證值 ±3pp（同 L）；籤號分布 χ² 年檢' }
};
function sha256File(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; } }
fs.writeFileSync('divination_lab/qiuqian_p0_certification.json', JSON.stringify(out, null, 1), 'utf8');
console.log(JSON.stringify({ abortRate: out.ritual.abortRate, lotMaxZ: +maxDevZ.toFixed(2), tendencyOK: checks.tendencyOK }, null, 0));
for (const L of ['layer1', 'layer2', 'layer3']) console.log(L, JSON.stringify(analytic[L].counts), 'p0:', Object.fromEntries(Object.entries(analytic[L].p0).map(([k, v]) => [k, v == null ? null : +v.toFixed(4)])));
console.log('寫出 divination_lab/qiuqian_p0_certification.json');
