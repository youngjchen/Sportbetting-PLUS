/* ============================================================
   一鍵分析腳本（divination-lab 實驗 M・凍結後單次執行）
   ── 凍結守門：沒有正確的 --frozen-sha256 對得上 --protocol 檔案雜湊，本腳本拒絕跑真實資料。
   跑法（凍結後）：
     node analysis_oneshot.js --protocol <凍結協議.md> --frozen-sha256 <hex> --i-confirm-frozen
   自測（不碰真實結果，隨時可跑）：
     node analysis_oneshot.js --selftest
   內容（全部照協議 §3/§4 預註冊）：
     合格樣本（R/Final/非7局/有線/非push/非ambiguous）→ gamePk 唯一性硬斷言 →
     梅花起卦（排除比和）→ p̂側/P̂over 於「合格樣本」重算 → p₀ 調整虛無值 →
     精確式二項（常態近似+連續性校正，雙尾）＋ Wilson 95% CI ＋ TOST(±5pp) ＋
     日期分層置換檢定（共同主檢，10,000 次，seed=協議雜湊 → 可重現）＋
     對照臂（HMAC）完整性檢查 ＋ 絆線（押向 vs 認證值 ±2pp）＋ 年度/前後段分解 ＋
     §4 結論模板三選一（只准填空）。輸出 data/analysis_result.json。
   ============================================================ */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const eng = require('./meihua_engine.js');
const ctrl = require('./control_arm_gen.js');

// ── 統計原語 ──
const erf = (x) => { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function binomTwoSided(x, n, p0) { const mu = n * p0, sd = Math.sqrt(n * p0 * (1 - p0)); const z = (Math.abs(x - mu) - 0.5) / sd; return { z: (x - mu) / sd, p: Math.max(0, Math.min(1, 2 * (1 - phi(Math.max(0, z))))) }; }
function wilson(x, n, zc = 1.96) { const p = x / n, z2 = zc * zc; const c = p + z2 / (2 * n), d = zc * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n), e = 1 + z2 / n; return [(c - d) / e, (c + d) / e]; }
function tost(x, n, p0, delta = 0.05) { const p = x / n, se = Math.sqrt(p * (1 - p) / n); const zl = (p - (p0 - delta)) / se, zh = (p - (p0 + delta)) / se; return { pass: zl >= 1.645 && zh <= -1.645, zl, zh }; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── 合格樣本 ──
function eligibleRows(J) {
  const rows = J.filter(o => o.gamePk && o.gameType === 'R' && !o.flags.notFinal && !o.flags.sevenInning && !o.flags.noLine && !o.flags.push && !o.flags.ambiguous && o.totalRuns != null);
  const seen = new Set();
  for (const r of rows) { if (seen.has(r.gamePk)) throw new Error('gamePk 重複於合格樣本: ' + r.gamePk + '（硬斷言失敗，禁止分析）'); seen.add(r.gamePk); }
  return rows;
}

// ── 主分析（凍結後才可達） ──
function runAnalysis(protoPath, rng) {
  const J = JSON.parse(fs.readFileSync('data/divination_joined.json', 'utf8'));
  const rows = eligibleRows(J);
  const key = ctrl.keyFromProtocol(protoPath);

  const recs = [];
  for (const r of rows) {
    const [Y, M, D] = r.date.split('-').map(Number); const [h, mi] = r.time.split(':').map(Number);
    const cast = eng.castFromTaipei(Y, M, D, h, mi);
    if (cast.relation === '比和') continue;                       // 預定規則：排除比和
    const pickBig = cast.pick === '體';                            // 極性：體=「大」方
    const over = r.totalRuns > r.totLine;                          // 全 .5 線，無 push
    const cc = ctrl.genCast(key, String(r.gamePk));
    recs.push({ date: r.date, year: r.date.slice(0, 4), pickBig, over, hit: pickBig === over, cPick: cc.relation === '比和' ? null : (cc.pick === '體'), cHit: cc.relation === '比和' ? null : ((cc.pick === '體') === over) });
  }
  const n = recs.length, hits = recs.filter(r => r.hit).length;
  const pSide = recs.filter(r => r.pickBig).length / n;            // p̂側（合格樣本重算，非認證快照）
  const pOver = recs.filter(r => r.over).length / n;
  const p0 = pSide * pOver + (1 - pSide) * (1 - pOver);
  const bin = binomTwoSided(hits, n, p0), ci = wilson(hits, n), tt = tost(hits, n, p0);

  // 日期分層置換（共同主檢）
  const byDate = {}; recs.forEach((r, i) => (byDate[r.date] ||= []).push(i));
  const obs = hits; let asExtreme = 0; const PERMS = 10000;
  const outc = recs.map(r => r.over);
  const permHits = () => { let hcount = 0; for (const d in byDate) { const idxs = byDate[d]; for (let i = idxs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const a = idxs[i], b = idxs[j]; const t = outc[a]; outc[a] = outc[b]; outc[b] = t; } } for (let i = 0; i < recs.length; i++) if (recs[i].pickBig === outc[i]) hcount++; return hcount; };
  const permDist = [];
  for (let k = 0; k < PERMS; k++) permDist.push(permHits());
  const permMean = permDist.reduce((s, v) => s + v, 0) / PERMS;
  for (const v of permDist) if (Math.abs(v - permMean) >= Math.abs(obs - permMean)) asExtreme++;
  const pPerm = asExtreme / PERMS;

  // 對照臂
  const cRecs = recs.filter(r => r.cHit != null);
  const cHits = cRecs.filter(r => r.cHit).length, cSide = cRecs.filter(r => r.cPick).length / cRecs.length;

  // 絆線
  const trip = [];
  if (Math.abs(100 * pSide - 54.68) > 2) trip.push(`梅花押大 ${(100 * pSide).toFixed(2)}% 偏離認證值 54.68% 逾 2pp`);
  if (Math.abs(100 * cSide - 50) > 2) trip.push(`對照臂押大 ${(100 * cSide).toFixed(2)}% 偏離認證值 50% 逾 2pp`);

  // 分解
  const byYear = {}; for (const r of recs) { (byYear[r.year] ||= { n: 0, h: 0 }); byYear[r.year].n++; if (r.hit) byYear[r.year].h++; }
  const era = (cut) => { const a = recs.filter(r => r.year <= cut), b = recs.filter(r => r.year > cut); return { early: [a.filter(r => r.hit).length, a.length], late: [b.filter(r => r.hit).length, b.length] }; };

  // §4 結論模板三選一
  const sig = bin.p < 0.05, ciLow = ci[0], ciHigh = ci[1];
  let conclusion;
  if (sig && (ciLow > p0 || ciHigh < p0)) conclusion = '模板一：此映射存在未被排除的訊號 → 觸發協議 §10 預註冊複製程序。不得表述為「占卜有效」。';
  else if (!sig && tt.pass) conclusion = `模板二：在本樣本（n=${n}）下，此映射效應被排除在 ±5pp 之外＝實務上無效。`;
  else conclusion = '模板三：無資訊結果，僅報告 CI。不得表述為「證偽」。';

  const result = { n, hits, hitRate: hits / n, pSide, pOver, p0, z: bin.z, pBinom: bin.p, ci95: ci, tost: tt, pPerm, control: { n: cRecs.length, hits: cHits, rate: cHits / cRecs.length, side: cSide }, tripwires: trip, byYear, eraSplit: era('2022'), conclusion };
  fs.writeFileSync('data/analysis_result.json', JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  console.log('\n==== 結論（依 §4 模板，只准填空）====\n' + conclusion + (trip.length ? '\n⚠ 絆線觸發：' + trip.join('；') + ' → 依協議凍結調查' : ''));
}

// ── 自測（合成資料，驗證統計實作本身；不讀真實 joined 檔） ──
function selftest() {
  let fail = 0; const ok = (m, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${c ? '' : ' ← ' + d}`); if (!c) fail++; };
  const rng = mulberry32(0xC0FFEE);
  const simBinom = (n, p) => { let x = 0; for (let i = 0; i < n; i++) if (rng() < p) x++; return x; };
  const P0 = 0.55 * 0.49 + 0.45 * 0.51;   // 合成 p̂側=55%、P̂over=49% → p₀=0.499
  // 1) α 校準：H0 下 400 次模擬的拒絕率 ≈ 5%
  let rej = 0; for (let s = 0; s < 400; s++) if (binomTwoSided(simBinom(16000, P0), 16000, P0).p < 0.05) rej++;
  ok(`α校準 拒絕率 ${(rej / 4).toFixed(1)}%（應≈5%，容忍 2.5–8%）`, rej / 400 >= 0.025 && rej / 400 <= 0.08, rej);
  // 2) 檢定力：真效應 +1.1pp（=MDE）→ 拒絕率應落 60–95%
  let rej2 = 0; for (let s = 0; s < 200; s++) if (binomTwoSided(simBinom(16000, P0 + 0.011), 16000, P0).p < 0.05) rej2++;
  ok(`MDE 檢定力 ${(rej2 / 2).toFixed(1)}%（應≈80%，容忍 60–95%）`, rej2 / 200 >= 0.60 && rej2 / 200 <= 0.95, rej2);
  // 3) TOST：真效應=0、n=16000、±5pp → 幾乎必過；n=200 → 幾乎必不過
  let tp = 0; for (let s = 0; s < 200; s++) if (tost(simBinom(16000, P0), 16000, P0).pass) tp++;
  ok(`TOST 等效通過率(n=16000) ${(tp / 2).toFixed(1)}%（應≈100%）`, tp / 200 >= 0.98, tp);
  let tp2 = 0; for (let s = 0; s < 200; s++) if (tost(simBinom(200, P0), 200, P0).pass) tp2++;
  ok(`TOST 等效通過率(n=200) ${(tp2 / 2).toFixed(1)}%（應≈0%，樣本不足不得宣稱等效）`, tp2 / 200 <= 0.05, tp2);
  // 4) 置換 vs 二項一致性：同一份合成資料兩法 p 值應接近
  const days = 120, per = 80; const recs = [];
  for (let d = 0; d < days; d++) for (let g = 0; g < per; g++) { const pickBig = rng() < 0.55; const over = rng() < 0.49; recs.push({ date: 'D' + d, pickBig, over, hit: pickBig === over }); }
  const n = recs.length, hits = recs.filter(r => r.hit).length;
  const pS = recs.filter(r => r.pickBig).length / n, pO = recs.filter(r => r.over).length / n;
  const p0 = pS * pO + (1 - pS) * (1 - pO);
  const pB = binomTwoSided(hits, n, p0).p;
  const byDate = {}; recs.forEach((r, i) => (byDate[r.date] ||= []).push(i));
  const outc = recs.map(r => r.over); let asX = 0; const P = 2000; const dist = [];
  for (let k = 0; k < P; k++) { for (const d in byDate) { const idxs = byDate[d]; for (let i = idxs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = outc[idxs[i]]; outc[idxs[i]] = outc[idxs[j]]; outc[idxs[j]] = t; } } let h = 0; for (let i = 0; i < n; i++) if (recs[i].pickBig === outc[i]) h++; dist.push(h); }
  const m = dist.reduce((s, v) => s + v, 0) / P; for (const v of dist) if (Math.abs(v - m) >= Math.abs(hits - m)) asX++;
  const pP = asX / P;
  ok(`置換p=${pP.toFixed(3)} vs 二項p=${pB.toFixed(3)}（差<0.06）`, Math.abs(pP - pB) < 0.06, `${pP} vs ${pB}`);
  console.log(fail === 0 ? '\n統計實作自測全過 ✅' : `\n${fail} 項失敗 ❌`); process.exit(fail ? 1 : 0);
}

// ── 入口與凍結守門 ──
(function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const gp = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  const protoPath = gp('--protocol'), sha = gp('--frozen-sha256');
  if (!protoPath || !sha || !process.argv.includes('--i-confirm-frozen')) {
    console.error('拒絕執行：真實分析需要 --protocol <凍結協議檔> --frozen-sha256 <hex> --i-confirm-frozen。\n自測請用 --selftest。');
    process.exit(2);
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(protoPath)).digest('hex');
  if (actual.toLowerCase() !== sha.toLowerCase()) { console.error(`拒絕執行：協議雜湊不符。\n 檔案 = ${actual}\n 宣告 = ${sha}`); process.exit(3); }
  const rng = mulberry32(parseInt(actual.slice(0, 8), 16));       // 置換 seed=協議雜湊 → 可重現
  runAnalysis(protoPath, rng);
})();
