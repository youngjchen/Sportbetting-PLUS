/* ============================================================
   實驗 S（小六壬）凍結分析腳本 — 協議附錄 §8 分析合約的逐字實作
   凍結：tag divination-freeze-S-v1；工件雜湊守門見下 FROZEN 表（含 FREEZE_MANIFEST_S.md 自身）。
   用法：
     node xiaoliuren_analysis.js --verify        # 只驗雜湊（不觸結果）
     node xiaoliuren_analysis.js --selftest      # 合成資料統計自測（不觸結果）
     node xiaoliuren_analysis.js --analysis-day  # 正式開盒（單一分析日）
   §8 凍結約定（逐字）：
     - pick∈{大,小,null}；null（空亡/未起卦）排除於分子與分母之外
     - over := totalRuns > totLine（全 .5 線無 push）
     - hit := (pick=='大'&&over)||(pick=='小'&&!over)
     - q := 全合格樣本(16,273)開大率，單一常數雙臂共用，不得條件化
     - p₀_臂 = f_臂·q+(1−f_臂)(1−q)，f 用凍結 ledger 計數之精確分數（顯示值 .6007/.5949）
     - 主檢＝精確二項雙尾(2·min尾,封頂1)＋置換共同主檢(B=10,000,種子固定)；α 各臂 2.5%
     - TOST ±5pp；絆線＝ledger 重算計數與凍結計數精確相等（凍結資料不容漂移）
     - 跨臂一致性＝限共同 cast 場集之 exploratory（無 α）
   統計慣例（凍結）：雙尾=2·min(下尾,上尾)；置換=打亂結果向量(Fisher-Yates,mulberry32 種子 20260713)；
   Wilson 95% CI；上行排除=單尾 97.5%（z=1.960）；檢定力/MDE 用 se₀=√(p₀(1−p₀)/n)、z_{α/2}=2.241。
   ============================================================ */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

// ── 凍結雜湊守門（FREEZE_MANIFEST_S.md v1＋manifest 自身）──
const FROZEN = [
  ['xiaoliuren_engine.js', '0bec05260d205e7f0235da81b0a84e0719865a73bcbd187d06e1e54ae97f4aec'],
  ['xiaoliuren_cert.js', 'ab4697063a320fdf198d6c306ac18de84aaf61ec31a22ba40b06bab479bb6747'],
  ['xiaoliuren_beacon_backfill.js', '1a5986c29d9301675dd958c25c28c5518d08893e23625a26685eeb655848101f'],
  ['meihua_engine.js', '4144e9e08e25232629c6def17c8af8c0b1183e66b358957b491c31e05779e551'],
  ['lunar.js', '9750324bfe1aa63c146f8c72b1143df924466c11c8a5277d7d9225c541a18aaa'],
  ['divination_lab/xiaoliuren_casts_time.json', 'd81a244be561ad864c900c97ccfd98f00bee3ed811391ed6c248d77d46389e50'],
  ['divination_lab/xiaoliuren_casts_rand.json', '0b8a59e361607e7ee934f36296ee0a7c2352b3d60f69ecf50a5426f3c1aa6636'],
  ['divination_lab/xiaoliuren_cert_time.json', 'f91c6df0669346ec03243abdfcc81fa956b675dd684acea29e9a1bf948c34900'],
  ['divination_lab/protocol_S_annex_v0.md', 'ea856205c7c6a6f6eb38e68d947845e19cd8dcae7e29fbbe75247b9d0cd966d1'],
  ['divination_lab/FREEZE_MANIFEST_S.md', '067bed2321f1d8f481c181823acd934f1ebf3031746695cc2c5a47d21e4ecabb'],
];
// 凍結計數（ledger 導出鎖值；絆線=分析日重算須精確相等）
const LOCK = {
  eligible: 16273,
  time: { big: 8095, small: 5381, abstain: 2797, active: 13476 },
  rand: { big: 6747, small: 4594, abstain: 2247, cast: 13588, missedPulse: 2475, fetchFail: 210, active: 11341 },
};
const ALPHA = 0.025, TOST_MARGIN = 0.05, PERM_B = 10000, PERM_SEED = 20260713;

function verifyFrozen() {
  let bad = 0;
  for (const [f, want] of FROZEN) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const ok = got === want;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${f}${ok ? '' : `\n      want ${want}\n      got  ${got}`}`);
    if (!ok) bad++;
  }
  if (bad) throw new Error(`凍結守門失敗：${bad} 檔雜湊不符（凍結後遭改動，拒跑）`);
  console.log('凍結守門：10/10 全符 ✅\n');
}

// ── 數值工具 ──
function lgamma(x) { // Lanczos
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function binomTwoSided(k, n, p) { // 精確二項雙尾 = 2·min(P(X≤k),P(X≥k))，封頂 1
  const lp = Math.log(p), lq = Math.log(1 - p), lgn = lgamma(n + 1);
  const pmf = (i) => Math.exp(lgn - lgamma(i + 1) - lgamma(n - i + 1) + i * lp + (n - i) * lq);
  let lo = 0, hi = 0;
  for (let i = 0; i <= n; i++) { const v = pmf(i); if (i <= k) lo += v; if (i >= k) hi += v; }
  return Math.min(1, 2 * Math.min(lo, hi));
}
function normCdf(z) { // erf 級數（精度 ~1e-7）
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429, p = 0.2316419;
  const az = Math.abs(z), t = 1 / (1 + p * az);
  const pdf = Math.exp(-az * az / 2) / Math.sqrt(2 * Math.PI);
  const tail = pdf * (b1 * t + b2 * t * t + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);
  return z >= 0 ? 1 - tail : tail;
}
function wilson(k, n, z = 1.959964) {
  const p = k / n, z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return [c - h, c + h];
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function permTest(picksBig, overs, B, seed) { // 打亂結果向量；統計量=hit 數；雙尾
  const n = overs.length, rng = mulberry32(seed);
  const ov = overs.slice();
  const hitCount = (o) => { let h = 0; for (let i = 0; i < n; i++) h += (picksBig[i] ? o[i] : !o[i]) ? 1 : 0; return h; };
  const obs = hitCount(ov);
  // 期望值（置換分布均值）：E = (nBig·O + nSmall·(n−O))/n
  const O = ov.reduce((s, x) => s + (x ? 1 : 0), 0), nBig = picksBig.reduce((s, x) => s + (x ? 1 : 0), 0);
  const E = (nBig * O + (n - nBig) * (n - O)) / n;
  let extreme = 0;
  for (let b = 0; b < B; b++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = ov[i]; ov[i] = ov[j]; ov[j] = tmp; }
    if (Math.abs(hitCount(ov) - E) >= Math.abs(obs - E) - 1e-9) extreme++;
  }
  return { p: (extreme + 1) / (B + 1), obsHits: obs, E };
}
function tost(pHat, n, p0, margin, alpha) {
  const se = Math.sqrt(pHat * (1 - pHat) / n) || 1e-12;
  const pLow = 1 - normCdf((pHat - (p0 - margin)) / se);   // H1: p > p0−m
  const pHigh = 1 - normCdf(((p0 + margin) - pHat) / se);  // H1: p < p0+m
  return { pass: Math.max(pLow, pHigh) < alpha, pLow, pHigh };
}
const pct = (x) => (100 * x).toFixed(2) + '%';

// ── 主分析（一臂）──
function analyzeArm(name, entries, outcomeByPk, q, lock) {
  // 絆線：重算計數 vs 凍結計數精確相等
  const big = entries.filter(e => e.pick === '大').length;
  const small = entries.filter(e => e.pick === '小').length;
  const abstain = entries.filter(e => e.pick == null).length;
  if (big !== lock.big || small !== lock.small) throw new Error(`${name} 絆線：計數漂移 big=${big}/${lock.big} small=${small}/${lock.small}`);
  const active = entries.filter(e => e.pick != null);
  const f = lock.big / lock.active;                       // 凍結 f（精確分數）
  const p0 = f * q + (1 - f) * (1 - q);                   // §8
  let hits = 0; const picksBig = [], overs = [];
  const byYear = {};
  for (const e of active) {
    const o = outcomeByPk.get(e.gamePk);
    if (!o) throw new Error(`${name}：gamePk ${e.gamePk} 無結果列（join 破損）`);
    const over = o.totalRuns > o.totLine;                 // §8
    const hit = (e.pick === '大' && over) || (e.pick === '小' && !over);
    hits += hit ? 1 : 0;
    picksBig.push(e.pick === '大'); overs.push(over);
    const y = e.officialDate.slice(0, 4);
    (byYear[y] ||= { n: 0, h: 0 }); byYear[y].n++; byYear[y].h += hit ? 1 : 0;
  }
  const n = active.length, pHat = hits / n;
  const se0 = Math.sqrt(p0 * (1 - p0) / n);
  const pBinom = binomTwoSided(hits, n, p0);
  const perm = permTest(picksBig, overs, PERM_B, PERM_SEED);
  const [lo, hi] = wilson(hits, n);
  const ts = tost(pHat, n, p0, TOST_MARGIN, ALPHA);
  const upperExcl = (pHat + 1.959964 * Math.sqrt(pHat * (1 - pHat) / n)) - p0; // 單尾97.5%上界
  const zab = 2.241403, z80 = 0.841621;                    // α/2=1.25% 雙尾、80% 檢定力
  const mde80 = (zab + z80) * se0;
  console.log(`\n══ ${name} ══`);
  console.log(`  n(有表態)=${n}  棄場=${abstain}  命中=${hits}  p̂=${pct(pHat)}  p₀=${pct(p0)}（f=${pct(f)}, q=${pct(q)}）`);
  console.log(`  精確二項雙尾 p=${pBinom.toExponential(3)}  ${pBinom < ALPHA ? '＜α=2.5% ⇒ 拒絕H₀' : '≥α=2.5% ⇒ 不拒絕H₀'}`);
  console.log(`  置換共同主檢 p=${perm.p.toFixed(4)}（B=${PERM_B}, seed=${PERM_SEED}）  ${perm.p < ALPHA ? '拒絕' : '不拒絕'}`);
  console.log(`  Wilson95% CI=[${pct(lo)}, ${pct(hi)}]  效應=p̂−p₀=${(100 * (pHat - p0)).toFixed(2)}pp`);
  console.log(`  TOST±5pp：${ts.pass ? '等效成立（±5pp 內）' : '等效不成立'}（pLow=${ts.pLow.toExponential(2)}, pHigh=${ts.pHigh.toExponential(2)}）`);
  console.log(`  上行效應 ≥${(100 * upperExcl).toFixed(2)}pp 被排除（單尾97.5%）；MDE(80%力,α2.5%)=${(100 * mde80).toFixed(2)}pp`);
  console.log(`  逐年命中率：`);
  for (const y of Object.keys(byYear).sort()) {
    const v = byYear[y];
    console.log(`    ${y}: ${v.h}/${v.n} = ${pct(v.h / v.n)}${v.n < 300 ? '（樣本不足、不判讀）' : ''}`);
  }
  return { name, n, abstain, hits, pHat, p0, f, pBinom, pPerm: perm.p, ci: [lo, hi], tost: ts.pass, upperExclPp: 100 * upperExcl, mde80Pp: 100 * mde80, byYear };
}

// ── 自測（合成資料，零結果觸碰）──
function selftest() {
  let fail = 0; const ok = (s, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${s}${c ? '' : ' ← ' + d}`); if (!c) fail++; };
  const rng = mulberry32(42);
  const mkNull = (n, fBig, q) => { // 真 H₀：pick⊥over 各自獨立生成（初版曾直接抽 hit 回推＝植入相關，自測抓到已修）
    const picksBig = [], overs = [];
    for (let i = 0; i < n; i++) { picksBig.push(rng() < fBig); overs.push(rng() < q); }
    return { picksBig, overs };
  };
  // 1) α 校準：null p₀ 下拒絕率 ≈ 2.5%
  const n1 = 13476, q = 0.4926, f = 0.6007, p0 = f * q + (1 - f) * (1 - q);
  let rej = 0; const REPS = 1000;
  for (let r = 0; r < REPS; r++) {
    let h = 0; for (let i = 0; i < n1; i++) h += rng() < p0 ? 1 : 0;
    if (binomTwoSided(h, n1, p0) < ALPHA) rej++;
  }
  ok(`α校準：null 拒絕率 ${(100 * rej / REPS).toFixed(1)}% ∈ [1.4%,3.6%]`, rej / REPS >= 0.014 && rej / REPS <= 0.036, rej / REPS);
  // 2) 檢定力：+2pp 植入 → 拒絕率 > 95%
  let rej2 = 0;
  for (let r = 0; r < 200; r++) {
    let h = 0; for (let i = 0; i < n1; i++) h += rng() < p0 + 0.02 ? 1 : 0;
    if (binomTwoSided(h, n1, p0) < ALPHA) rej2++;
  }
  ok(`檢定力：+2pp 拒絕率 ${(100 * rej2 / 200).toFixed(1)}% > 95%`, rej2 / 200 > 0.95, rej2 / 200);
  // 3) 置換檢定校準與檢定力（性質測試，非單組數字巧合）：
  //    (a) 真 H₀ 下 100 組小樣本，5% 水準拒絕率 ∈ [1%,11%]；(b) 植入強關聯 → p 極小
  let rej3 = 0;
  for (let r = 0; r < 100; r++) {
    const d = mkNull(800, 0.6, q);
    if (permTest(d.picksBig, d.overs, 500, 100 + r).p < 0.05) rej3++;
  }
  ok(`置換校準：null 拒絕率 ${rej3}% ∈ [1%,11%]`, rej3 >= 1 && rej3 <= 11, rej3);
  const strong = { picksBig: [], overs: [] };
  for (let i = 0; i < 2000; i++) { const b = rng() < 0.6; strong.picksBig.push(b); strong.overs.push(rng() < (b ? 0.60 : 0.40)); } // 植入 20pp 關聯
  const pStrong = permTest(strong.picksBig, strong.overs, 2000, 9).p;
  ok(`置換檢定力：植入關聯 p=${pStrong.toFixed(4)} < 0.01`, pStrong < 0.01, pStrong);
  // 4) TOST：null 大樣本 → 等效成立；+8pp → 不成立
  const t1 = tost(p0 + 0.001, n1, p0, TOST_MARGIN, ALPHA), t2 = tost(p0 + 0.08, n1, p0, TOST_MARGIN, ALPHA);
  ok('TOST：null 等效成立、+8pp 不成立', t1.pass && !t2.pass, JSON.stringify([t1.pass, t2.pass]));
  // 5) 絆線：計數漂移必炸
  let threw = false;
  try { analyzeArm('絆線測試', [{ pick: '大', gamePk: 1, officialDate: '2020-01-01' }], new Map(), q, LOCK.time); } catch (e) { threw = true; }
  ok('絆線：漂移計數拒跑', threw, '未拋錯');
  console.log(fail === 0 ? '\n自測全部通過 ✅' : `\n${fail} 項失敗 ❌`);
  process.exit(fail === 0 ? 0 : 1);
}

// ── 進入點 ──
const MODE = process.argv[2] || '--verify';
if (MODE === '--verify') { verifyFrozen(); console.log('（僅守門驗證；未觸任何結果資料）'); }
else if (MODE === '--selftest') { selftest(); }
else if (MODE === '--analysis-day') {
  verifyFrozen();
  const J = require('./data/divination_joined.json');
  const rows = J.filter(o => o.gamePk && o.gameType === 'R' && !o.flags.notFinal && !o.flags.sevenInning && !o.flags.noLine && !o.flags.push && !o.flags.ambiguous && o.totalRuns != null);
  if (rows.length !== LOCK.eligible) throw new Error(`合格樣本 ${rows.length} ≠ 凍結 ${LOCK.eligible}（上游資料變動，拒跑）`);
  const outcomeByPk = new Map(rows.map(r => [r.gamePk, r]));
  const q = rows.filter(r => r.totalRuns > r.totLine).length / rows.length;  // §8：全樣本單一常數
  console.log(`分析日 ${new Date().toISOString()}｜合格 ${rows.length}｜q(全樣本開大率)=${pct(q)}｜α=各臂2.5%(Bonferroni)`);

  const timeLedger = JSON.parse(fs.readFileSync('divination_lab/xiaoliuren_casts_time.json', 'utf8'));
  const randLedgerAll = JSON.parse(fs.readFileSync('divination_lab/xiaoliuren_casts_rand.json', 'utf8'));
  const randCast = randLedgerAll.filter(e => e.status === 'cast');
  if (randCast.length !== LOCK.rand.cast) throw new Error(`S-rand cast ${randCast.length} ≠ 凍結 ${LOCK.rand.cast}`);

  const rTime = analyzeArm('S-time（時間起課臂）', timeLedger, outcomeByPk, q, LOCK.time);
  const rRand = analyzeArm('S-rand（信標報數臂）', randCast, outcomeByPk, q, LOCK.rand);

  // 跨臂一致性（§8 exploratory，無 α）：共同 cast 且雙方有表態
  const timeByPk = new Map(timeLedger.map(e => [e.gamePk, e]));
  let agree = 0, both = 0, bothHit = { agreeH: 0, agreeN: 0 };
  for (const e of randCast) {
    const t = timeByPk.get(e.gamePk);
    if (!t || t.pick == null || e.pick == null) continue;
    both++;
    if (t.pick === e.pick) {
      agree++;
      const o = outcomeByPk.get(e.gamePk); const over = o.totalRuns > o.totLine;
      bothHit.agreeN++; bothHit.agreeH += ((e.pick === '大' && over) || (e.pick === '小' && !over)) ? 1 : 0;
    }
  }
  console.log(`\n══ 跨臂（exploratory，無α）══`);
  console.log(`  共同有表態 ${both} 場｜同向 ${agree}（${pct(agree / both)}；獨立臂理論≈f²+(1−f)²≈52%）｜同向場命中 ${bothHit.agreeH}/${bothHit.agreeN}=${pct(bothHit.agreeH / bothHit.agreeN)}`);

  const result = { analysisDay: new Date().toISOString(), q, alpha: ALPHA, arms: [rTime, rRand], crossArm: { both, agree, agreeHit: bothHit } };
  fs.writeFileSync('divination_lab/xiaoliuren_analysis_result.json', JSON.stringify(result, null, 2));
  console.log('\n已寫 divination_lab/xiaoliuren_analysis_result.json');
} else { throw new Error('未知模式：' + MODE); }
