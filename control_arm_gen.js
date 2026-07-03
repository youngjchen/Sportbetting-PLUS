/* ============================================================
   對照臂：HMAC 確定性卦生成器（divination-lab 協議 §6，事前承諾式）
   seed 鏈：key = SHA256(凍結協議全文 bytes)；stream_i = HMAC-SHA256(key, `${gamePk}:${i}`)
   逐 byte 消耗：upN = b%8+1（256%8=0，無偏）、downN 同法；moving 拒絕取樣（b<252 才收，252=42×6 → %6 無偏）
   與梅花臂共用唯一映射入口 castFromTrigrams（meihua_engine.js）——兩臂差異只在「卦怎麼來」。
   任何人可用凍結協議檔重算全部對照臂卦 → 可驗證、不可事後重抽。
   認證：node control_arm_gen.js --cert [--protocol <path>]  → 10⁶ 卦分布＋判準
   （認證是分布層性質，用草案 key 與凍結 key 結論相同；凍結後以正式 key 重跑一次留檔。）
   ============================================================ */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { castFromTrigrams } = require('./meihua_engine.js');

function keyFromProtocol(path) { return crypto.createHash('sha256').update(fs.readFileSync(path)).digest(); }

function* byteStream(key, gamePk) {
  for (let i = 0; ; i++) {
    const block = crypto.createHmac('sha256', key).update(`${gamePk}:${i}`).digest();
    for (const b of block) yield b;
  }
}
function genCast(key, gamePk) {
  const it = byteStream(key, gamePk);
  const next = () => it.next().value;
  const upN = next() % 8 + 1, downN = next() % 8 + 1;
  let b; do { b = next(); } while (b >= 252);
  const moving = b % 6 + 1;
  return castFromTrigrams(upN, downN, moving);
}
module.exports = { keyFromProtocol, genCast };

if (require.main === module && process.argv.includes('--cert')) {
  const pArg = process.argv.indexOf('--protocol');
  const protoPath = pArg >= 0 ? process.argv[pArg + 1] : 'C:/Users/User/Downloads/divination_lab_預註冊協議草案_v0.md';
  const key = keyFromProtocol(protoPath);
  const N = 1e6;
  let big = 0, bh = 0, nEx = 0; const rel = {}; const triCnt = new Array(9).fill(0);
  for (let g = 0; g < N; g++) {
    const c = genCast(key, 'CERT' + g);
    rel[c.relation] = (rel[c.relation] || 0) + 1; triCnt[c.upN]++;
    if (c.pick === '體') big++;
    if (c.relation !== '比和') { nEx++; if (c.pick === '體') bh++; }
  }
  const pct = (a, b) => (100 * a / b).toFixed(3) + '%';
  console.log(`對照臂 10⁶ 卦認證（key = SHA256(${protoPath.split(/[\\/]/).pop()})）`);
  console.log('關係分布:', JSON.stringify(rel));
  console.log('上卦分布(乾..坤):', triCnt.slice(1).join(','));
  console.log(`含比和押大 ${pct(big, N)}｜排除比和押大 ${pct(bh, nEx)}（保留 ${pct(nEx, N)}，理論比和=21.875%）`);
  const dev = Math.abs(100 * bh / nEx - 50);
  console.log(`判準 |排比和押大−50%| ≤ 0.5pp → 偏差 ${dev.toFixed(3)}pp → ${dev <= 0.5 ? '通過 ✅' : '不通過 ❌'}`);
}
