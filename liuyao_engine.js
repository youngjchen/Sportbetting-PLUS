/* ============================================================
   六爻引擎（divination-lab 實驗 L・前瞻）
   規則來源：定義文件 v0.2 B2/B3——
   - 擲法：三錢六擲，0背=交(老陰6)、1背=單(少陽7)、2背=拆(少陰8)、3背=重(老陽9)
     （《卜筮全書》卷一〈以錢代蓍法〉有原文；1/8·3/8 機率=均勻錢數學推導，非典據）
   - 安世應：尋世訣（天同二世天變五，地同四世地變初，本宮六世三世異，人同遊魂人變歸）
     ＝逐位比較上下卦（地=初/人=中/天=上）；應=世+3。已對京房八宮 8 個已知卦例驗證。
   - 納甲：《卜筮全書》〈納甲歌〉八宮內外卦地支表；地支→五行。
   - 斷勝負：《卜筮正宗》黃金策〈征戰〉「論觀世應之旺衰，以決兩家之勝負」→
     確定性計分（B3-2 自定聲明，實驗 L 凍結前定案）：
       月建 vs 爻：同/生→+2、剋→−2、爻生建/爻剋建→−1；日辰同法；
       每一動爻（非自身）：生/同→+1、剋→−1、其餘 0。
     世分>應分→世方；<→應方；平手→世應本爻相剋裁決；再平→依極性判世方（B3-3 自定）。
   - 極性（已核可）：世=「大」方（大小分）。
   - 月建=節氣月支、日辰=日支（0 點換日，與梅花臂同約定）。
   自測：node liuyao_engine.js --selftest    認證：node liuyao_engine.js --cert
   ============================================================ */
'use strict';
const { Solar } = require('lunar-javascript');

const ZHI5 = { 子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火', 午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水' };
const SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };
// 納甲：卦（以三爻位元 bottom-up 為鍵，陽=1）→ [內卦三支, 外卦三支]
const NAJIA = {
  '111': { name: '乾', in: ['子', '寅', '辰'], out: ['午', '申', '戌'] },
  '010': { name: '坎', in: ['寅', '辰', '午'], out: ['申', '戌', '子'] },
  '001': { name: '艮', in: ['辰', '午', '申'], out: ['戌', '子', '寅'] },
  '100': { name: '震', in: ['子', '寅', '辰'], out: ['午', '申', '戌'] },
  '011': { name: '巽', in: ['丑', '亥', '酉'], out: ['未', '巳', '卯'] },
  '101': { name: '離', in: ['卯', '丑', '亥'], out: ['酉', '未', '巳'] },
  '000': { name: '坤', in: ['未', '巳', '卯'], out: ['丑', '亥', '酉'] },
  '110': { name: '兌', in: ['巳', '卯', '丑'], out: ['亥', '酉', '未'] },
};
const BACK2YAO = [6, 7, 8, 9];           // 0背=交(老陰6) 1背=單(少陽7) 2背=拆(少陰8) 3背=重(老陽9)

function shiPosition(bits) {             // bits: 6 爻陰陽 bottom-up；尋世訣
  const s = [bits[0] === bits[3], bits[1] === bits[4], bits[2] === bits[5]]; // 地/人/天 同否
  const nSame = s.filter(Boolean).length;
  if (nSame === 3) return 6;                       // 八純卦世六
  if (nSame === 0) return 3;                       // 三世異（全異）
  if (nSame === 1) { if (s[2]) return 2; if (s[0]) return 4; return 4; }   // 天同二世／地同四世／人同遊魂(世4)
  /* nSame===2（恰一位異）*/ if (!s[2]) return 5; if (!s[0]) return 1; return 3; // 天變五／地變初／人變歸(世3)
}
function score(jZhi, yaoZhi) {           // 建(月/日)支 對 爻支
  const j = ZHI5[jZhi], y = ZHI5[yaoZhi];
  if (j === y) return 2; if (SHENG[j] === y) return 2; if (KE[j] === y) return -2;
  return -1;                                        // 爻生建(洩)/爻剋建(耗)
}
function movScore(mZhi, yaoZhi) {        // 動爻支 對 世/應支
  const m = ZHI5[mZhi], y = ZHI5[yaoZhi];
  if (m === y || SHENG[m] === y) return 1; if (KE[m] === y) return -1; return 0;
}

function castFromBacks(backs, monthZhi, dayZhi) {   // backs: 6 個 0..3（bottom-up）
  const yao = backs.map(b => BACK2YAO[b]);
  const bits = yao.map(v => (v === 7 || v === 9) ? 1 : 0);
  const moving = yao.map((v, i) => (v === 6 || v === 9) ? i + 1 : null).filter(Boolean);
  const lowKey = bits.slice(0, 3).join(''), upKey = bits.slice(3).join('');
  const low = NAJIA[lowKey], up = NAJIA[upKey];
  const zhiAt = (pos) => pos <= 3 ? low.in[pos - 1] : up.out[pos - 4];
  const shi = shiPosition(bits), ying = ((shi + 2) % 6) + 1;   // 世+3（1↔4 2↔5 3↔6）
  const shiZhi = zhiAt(shi), yingZhi = zhiAt(ying);
  let sShi = score(monthZhi, shiZhi) + score(dayZhi, shiZhi);
  let sYing = score(monthZhi, yingZhi) + score(dayZhi, yingZhi);
  for (const m of moving) { const mz = zhiAt(m); if (m !== shi) sShi += movScore(mz, shiZhi); if (m !== ying) sYing += movScore(mz, yingZhi); }
  let winner, tiebreak = null;
  if (sShi > sYing) winner = '世'; else if (sYing > sShi) winner = '應';
  else if (KE[ZHI5[shiZhi]] === ZHI5[yingZhi]) { winner = '世'; tiebreak = '世剋應'; }
  else if (KE[ZHI5[yingZhi]] === ZHI5[shiZhi]) { winner = '應'; tiebreak = '應剋世'; }
  else { winner = '世'; tiebreak = '極性'; }
  return { yao, bits, hexLow: low.name, hexUp: up.name, moving, shi, ying, shiZhi, yingZhi, sShi, sYing, winner, tiebreak, pick: winner === '世' ? '大' : '小' };
}

function zhiContext(y, m, d, hh, mi) {   // 月建（節氣月支）＋日辰（0點換日）
  const l = Solar.fromYmdHms(y, m, d, hh, mi || 0, 0).getLunar();
  const mz = typeof l.getMonthZhi === 'function' ? l.getMonthZhi() : l.getMonthInGanZhi().charAt(1);
  const dz = typeof l.getDayZhi === 'function' ? l.getDayZhi() : l.getDayInGanZhi().charAt(1);
  return { monthZhi: mz, dayZhi: dz };
}
function bitsToBacks(bits18) {           // 18 bit（每爻 3 bit，1=背）→ 6 爻背數
  const backs = []; for (let i = 0; i < 6; i++) backs.push(bits18[3 * i] + bits18[3 * i + 1] + bits18[3 * i + 2]);
  return backs;
}
module.exports = { castFromBacks, zhiContext, bitsToBacks, shiPosition };

// ─────────────── 自測與認證 ───────────────
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

if (require.main === module && process.argv.includes('--selftest')) {
  let fail = 0; const ok = (m, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${c ? '' : ' ← ' + JSON.stringify(d)}`); if (!c) fail++; };
  // 1) 尋世訣：京房八宮已知卦例
  const shiOf = (low, up) => shiPosition([...low, ...up]);
  ok('乾為天 世6', shiOf([1, 1, 1], [1, 1, 1]) === 6, shiOf([1, 1, 1], [1, 1, 1]));
  ok('天風姤(乾宮一世) 世1', shiOf([0, 1, 1], [1, 1, 1]) === 1, 0);
  ok('地天泰(坤宮三世) 世3', shiOf([1, 1, 1], [0, 0, 0]) === 3, 0);
  ok('雷天大壯(坤宮四世) 世4', shiOf([1, 1, 1], [1, 0, 0]) === 4, 0);
  ok('火地晉(乾宮遊魂) 世4', shiOf([0, 0, 0], [1, 0, 1]) === 4, 0);
  ok('水地比(坤宮歸魂) 世3', shiOf([0, 0, 0], [0, 1, 0]) === 3, 0);
  ok('水天需(坤宮遊魂) 世4', shiOf([1, 1, 1], [0, 1, 0]) === 4, 0);
  ok('地雷復(坤宮一世) 世1', shiOf([1, 0, 0], [0, 0, 0]) === 1, 0);
  // 2) 納甲＋世應支：乾為天(靜) 世6=戌 應3=辰；天風姤(靜) 世1=丑 應4=午
  const qian = castFromBacks([1, 1, 1, 1, 1, 1], '午', '子');
  ok('乾為天 世支=戌 應支=辰', qian.shiZhi === '戌' && qian.yingZhi === '辰', qian);
  const gou = castFromBacks([2, 1, 1, 1, 1, 1], '午', '子');
  ok('姤 世支=丑 應支=午', gou.shiZhi === '丑' && gou.yingZhi === '午', gou);
  // 3) 計分手算例：乾為天、月午日子 → 世戌土:+2(午生戌)−1(戌剋子? 子水 vs 戌土=土剋水→爻剋建−1)=+1；應辰土同=+1 → 平手→戌辰同行不相剋→極性→世
  ok('計分平手→極性→世(押大)', qian.sShi === 1 && qian.sYing === 1 && qian.tiebreak === '極性' && qian.pick === '大', qian);
  // 4) 動爻：姤 爻1=交(老陰動)＝世位自身 → 世自跳過；動爻丑土 vs 應午火 無生剋→0
  const gouM = castFromBacks([0, 1, 1, 1, 1, 1], '午', '子');
  ok('動爻自身跳過＋無生剋=0', gouM.moving.length === 1 && gouM.moving[0] === 1 && gouM.sShi === gou.sShi && gouM.sYing === gou.sYing, gouM);
  // 5) 月建節氣錨點：2025-12-25→子月；2026-06-25→午月；日辰連續兩日支差1
  const c1 = zhiContext(2025, 12, 25, 12, 0), c2 = zhiContext(2026, 6, 25, 12, 0);
  ok('2025-12-25 月建=子', c1.monthZhi === '子', c1);
  ok('2026-06-25 月建=午', c2.monthZhi === '午', c2);
  const Z = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const d1 = zhiContext(2026, 7, 2, 12, 0), d2 = zhiContext(2026, 7, 3, 12, 0);
  ok('日辰逐日+1', (Z.indexOf(d2.dayZhi) - Z.indexOf(d1.dayZhi) + 12) % 12 === 1, [d1, d2]);
  const n1 = zhiContext(2026, 7, 3, 22, 30), n2 = zhiContext(2026, 7, 3, 23, 30);
  ok('23:00–23:59 日辰不換日（0點制）', n1.dayZhi === n2.dayZhi, [n1, n2]);
  console.log(fail === 0 ? '\n全部通過 ✅' : `\n${fail} 項失敗 ❌`); process.exit(fail ? 1 : 0);
}

if (require.main === module && process.argv.includes('--cert')) {
  const rng = mulberry32(0x5EED6EA0);
  const Z = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const N = 1e6; let big = 0, tieKe = 0, tiePol = 0; const movDist = {}; const byMonth = {};
  for (let i = 0; i < N; i++) {
    const bits18 = []; for (let b = 0; b < 18; b++) bits18.push(rng() < 0.5 ? 1 : 0);
    const backs = bitsToBacks(bits18);
    const mz = Z[Math.floor(rng() * 12)], dz = Z[Math.floor(rng() * 12)];
    const c = castFromBacks(backs, mz, dz);
    if (c.pick === '大') big++;
    if (c.tiebreak === '世剋應' || c.tiebreak === '應剋世') tieKe++; if (c.tiebreak === '極性') tiePol++;
    movDist[c.moving.length] = (movDist[c.moving.length] || 0) + 1;
    (byMonth[mz] ||= { n: 0, b: 0 }); byMonth[mz].n++; if (c.pick === '大') byMonth[mz].b++;
  }
  const pct = (a, b) => (100 * a / b).toFixed(3) + '%';
  console.log(`六爻 10⁶ 認證（均勻錢＋均勻月日支）：押大 ${pct(big, N)}｜剋裁決 ${pct(tieKe, N)}｜極性裁決 ${pct(tiePol, N)}`);
  console.log('動爻數分布:', JSON.stringify(movDist));
  const mRates = Object.entries(byMonth).map(([k, v]) => [k, 100 * v.b / v.n]);
  const mx = mRates.reduce((a, c) => c[1] > a[1] ? c : a), mn = mRates.reduce((a, c) => c[1] < a[1] ? c : a);
  console.log(`各月支押大範圍: ${mn[0]} ${mn[1].toFixed(2)}% ~ ${mx[0]} ${mx[1].toFixed(2)}%`);
  const dev = Math.abs(100 * big / N - 50);
  console.log(`判準 |押大−50%| ≤ 0.5pp → 偏差 ${dev.toFixed(3)}pp → ${dev <= 0.5 ? '通過 ✅' : '不通過（依協議 §3 以 p₀ 機制吸收，L 凍結前記錄認證值）'}`);
}
