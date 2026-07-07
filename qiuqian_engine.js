/* ============================================================
   求籤引擎（divination-lab 實驗 Q・北港朝天宮六十甲子籤）
   儀式 = (beacon outputValue, gamePk, market) 的純函數。
   流程（凍結規格 divination_lab/QIUQIAN_PROTOCOL_DRAFT_v0.md §2–§4）：
     允筊：擲筊累積 3 聖杯（朝天宮線上程序）
     D3′：任一筊階段「連續 5 次非聖」→ 插問「弟子是否改日再問？」一筊，聖=棄場留痕
     抽籤：6 bit 均勻抽 1..60（60–63 拒絕重取——不可用 mod，會偏 1–4 號）
     確筊：對所抽之籤再累積 3 聖杯；D3′ 同樣適用（棄場時籤號留審計、不作判讀）
   筊模型（D4）：2 bit → 聖 1/2、笑 1/4、陰 1/4（理想化；廟方線上版等效偽隨機）
   位元流：HMAC-SHA256(outputValue, "qiuqian|{gamePk}|{market}|{block}")，各市場獨立、
           與實驗 L 之 SHA256(outputValue|gamePk) 推導不相交。
   層表判讀為查表制：表凍結前 cast 只記原始儀式結果（picks 於凍結後由籤號決定性重導）。
   用法：node qiuqian_engine.js  → 自測
   ============================================================ */
'use strict';
const crypto = require('crypto');

const MAX_BLOCKS = 10000;   // 防呆上限（幾何分布下觸及機率 ≈ 0）
const D3_RUN = 5;           // D3′ 凍結值：連續非聖次數門檻

function makeStream(outputValue, gamePk, market) {
  let block = 0, buf = null, bitPos = 256, blocksUsed = 0;
  function bits(k) {
    let v = 0;
    for (let i = 0; i < k; i++) {
      if (bitPos >= 256) {
        buf = crypto.createHmac('sha256', outputValue).update('qiuqian|' + gamePk + '|' + market + '|' + block).digest();
        block++; blocksUsed++; bitPos = 0;
        if (blocksUsed > MAX_BLOCKS) throw new Error('bit stream overrun');
      }
      v = (v << 1) | ((buf[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  }
  return { bits, used: () => blocksUsed };
}

// 一擲：聖(00,01)=1/2、笑(10)=1/4、陰(11)=1/4
function throwJiao(st) { const v = st.bits(2); return v <= 1 ? '聖' : (v === 2 ? '笑' : '陰'); }

// 筊階段：累積 need 個聖；連續 D3_RUN 非聖 → meta 一筊（聖=棄場，非聖=計數歸零續擲）
function jiaoStage(st, need, log, stage) {
  let sheng = 0, run = 0;
  while (sheng < need) {
    const t = throwJiao(st);
    log.push(stage + ':' + t);
    if (t === '聖') { sheng++; run = 0; }
    else if (++run >= D3_RUN) {
      const meta = throwJiao(st);
      log.push(stage + ':meta:' + meta);
      if (meta === '聖') return { aborted: true };
      run = 0;
    }
  }
  return { aborted: false };
}

function drawLot(st, log) {
  for (;;) {
    const v = st.bits(6);
    if (v < 60) { log.push('draw:' + (v + 1)); return v + 1; }
    log.push('draw:reject');
  }
}

// 完整儀式（一事一占＝每市場獨立全程）
function castRitual(outputValue, gamePk, market) {
  const st = makeStream(outputValue, String(gamePk), market);
  const log = [];
  if (jiaoStage(st, 3, log, 'yun').aborted) return { aborted: 'oracle-yun', lot: null, log, blocks: st.used() };
  const lot = drawLot(st, log);
  if (jiaoStage(st, 3, log, 'que').aborted) return { aborted: 'oracle-que', lot, log, blocks: st.used() };
  return { aborted: null, lot, log, blocks: st.used() };
}

// 層表判讀（凍結表：qiuqian_layer_tables.json / qiuqian_layer3_table.json）
function applyLayers(lot, tables) {
  if (!tables || !lot) return null;
  const out = {};
  for (const L of ['layer1', 'layer2', 'layer3']) {
    const t = tables[L] && tables[L].byLot && tables[L].byLot[lot];
    out[L] = t ? t.verdict : null;
  }
  return out;
}

// D5 市場定向：吉/凶 → 方向；棄/中平 → null（棄場）
function directionFor(market, verdict) {
  if (verdict !== '吉' && verdict !== '凶') return null;
  if (market === 'totals') return verdict === '吉' ? '大' : '小';
  if (market === 'ml') return verdict === '吉' ? '主' : '客';
  if (market === 'hd') return verdict === '吉' ? '熱門過盤' : '受讓';
  return null;
}

module.exports = { castRitual, applyLayers, directionFor, D3_RUN };

/* ── 自測 ─────────────────────────────────────── */
if (require.main === module) {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('✗ ' + name); } };

  // 1) 決定性：同輸入完全同輸出
  const ov = 'ab'.repeat(64);
  ok('determinism', JSON.stringify(castRitual(ov, 717000, 'totals')) === JSON.stringify(castRitual(ov, 717000, 'totals')));

  // 2) 市場分流：同場不同市場為獨立流（大樣本下籤號不應恆等）
  let diff = 0;
  for (let i = 0; i < 200; i++) {
    const o = crypto.createHash('sha256').update('seed' + i).digest('hex');
    const a = castRitual(o, 800000 + i, 'totals'), b = castRitual(o, 800000 + i, 'ml');
    if (a.lot !== b.lot) diff++;
  }
  ok('market streams independent (diff>150/200)', diff > 150);

  // 3) 大樣本分布：籤號均勻、筊頻率、棄場率
  const N = 200000, lotCount = new Array(61).fill(0), jiao = { '聖': 0, '笑': 0, '陰': 0 };
  let aborts = 0, drawn = 0, maxBlocks = 0;
  for (let i = 0; i < N; i++) {
    const o = crypto.createHash('sha256').update('mc' + i).digest('hex');
    const r = castRitual(o, i, 'totals');
    maxBlocks = Math.max(maxBlocks, r.blocks);
    for (const l of r.log) { const t = l.split(':').pop(); if (jiao[t] !== undefined) jiao[t]++; }
    if (r.aborted) { aborts++; continue; }
    drawn++; lotCount[r.lot]++;
  }
  const abortRate = aborts / N;
  const expPerLot = drawn / 60;
  let maxDev = 0;
  for (let n = 1; n <= 60; n++) maxDev = Math.max(maxDev, Math.abs(lotCount[n] - expPerLot) / Math.sqrt(expPerLot));
  const totJ = jiao['聖'] + jiao['笑'] + jiao['陰'];
  const pSheng = jiao['聖'] / totJ, pXiao = jiao['笑'] / totJ;
  ok('lots in 1..60 only', lotCount[0] === 0);
  ok('lot uniformity (max |z| < 5)', maxDev < 5);
  ok('P(聖)≈0.5 ±0.005', Math.abs(pSheng - 0.5) < 0.005);
  ok('P(笑)≈0.25 ±0.005', Math.abs(pXiao - 0.25) < 0.005);
  ok('abort rate in (0.1%, 25%)', abortRate > 0.001 && abortRate < 0.25);
  ok('blocks bounded', maxBlocks < 50);

  // 4) 查表與定向
  const stub = { layer1: { byLot: { 5: { verdict: '吉' } } }, layer2: { byLot: { 5: { verdict: '棄' } } }, layer3: { byLot: { 5: { verdict: '凶' } } } };
  const lv = applyLayers(5, stub);
  ok('applyLayers', lv.layer1 === '吉' && lv.layer2 === '棄' && lv.layer3 === '凶');
  ok('directionFor totals', directionFor('totals', '吉') === '大' && directionFor('totals', '凶') === '小');
  ok('directionFor ml/hd', directionFor('ml', '凶') === '客' && directionFor('hd', '吉') === '熱門過盤');
  ok('directionFor 棄→null', directionFor('totals', '棄') === null && directionFor('totals', null) === null);

  console.log(`\n自測 ${pass}/${pass + fail} 過｜棄場率 ${(abortRate * 100).toFixed(2)}%（yun+que 合計）｜聖 ${(pSheng * 100).toFixed(2)}%｜籤號最大|z|=${maxDev.toFixed(2)}｜單儀式最多 ${maxBlocks} blocks`);
  process.exit(fail ? 1 : 0);
}
