/* ============================================================
   梅花易數時間起卦引擎（divination-lab 實驗 M）
   規則來源：定義文件 v0.2（Downloads/divination_lab_定義文件_考據材料_v0.md），全部綁原典出處：
   - 起卦：通行本卷一〈年月日時起例〉：年=地支序(子1..亥12)、月=農曆月、日=農曆日；
     (年+月+日)%8=上卦、(年+月+日+時)%8=下卦、(年+月+日+時)%6=動爻；先天卦數 乾1..坤8。
   - 餘0：除8→取8=坤（原典明文「如得八數整，即坤卦」）；除6→取6=上爻（原典無文，自定，協議聲明）。
   - 曆法（自定聲明）：台北時間；年支以農曆正月初一換年（與月日同曆內部一致）；
     閏月依本月數（閏四月=4）；23:00–23:59 屬當日子時（0 點換日）。
   - 體用：「動者為用，靜者為體」（卷三〈變卦式八則〉；季本識語同）。
   - 映射（協議 v0.2 §6，已核可）：體克用/用生體/比和→體方；用克體/體生用→用方；
     比和→體方 待對稱性模擬裁定（偏差>0.5pp 即改排除比和場）。v1 不納旺衰/互變（聲明簡化）。
   依賴：lunar-javascript（農曆/干支）；自測含 8 個 CNY 錨點＋觀梅占算例＋時辰邊界。
   自測：node meihua_engine.js --selftest
   ============================================================ */
'use strict';
const { Solar } = (typeof require === 'function' && typeof module !== 'undefined') ? require('lunar-javascript') : window; // Node/瀏覽器雙環境（瀏覽器由 lunar.js 全域提供）

const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const TRI = { 1: ['乾', '金'], 2: ['兌', '金'], 3: ['離', '火'], 4: ['震', '木'], 5: ['巽', '木'], 6: ['坎', '水'], 7: ['艮', '土'], 8: ['坤', '土'] };
const SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };   // 五行相生
const KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };      // 五行相剋
const mod = (x, m) => { const r = x % m; return r === 0 ? m : r; };   // 餘0取滿數（8=坤有明文；6=上爻自定）
const hourIndex = (h) => Math.floor(((h + 1) % 24) / 2) + 1;          // 23→子1、0→子1、1→丑2、…、21/22→亥12

function numbersFromTaipei(y, m, d, hh, mi) {
  const lunar = Solar.fromYmdHms(y, m, d, hh, mi || 0, 0).getLunar();
  return {
    nYear: ZHI.indexOf(lunar.getYearZhi()) + 1,   // 年支序（正月初一換年 = lunar-javascript 預設）
    nMonth: Math.abs(lunar.getMonth()),           // 閏月為負值 → 依本月數（自定聲明）
    nDay: lunar.getDay(),
    nHour: hourIndex(hh),
    lunarText: lunar.toString(),
  };
}

function castFromTrigrams(upN, downN, moving) {           // 對照臂與時間起卦共用的唯一映射入口
  const up = TRI[upN], down = TRI[downN];
  const movingInLower = moving <= 3;                       // 爻位 1-3 在下卦
  const ti = movingInLower ? up : down, yong = movingInLower ? down : up;  // 動者為用、靜者為體
  const be = ti[1], ye = yong[1];
  let relation;
  if (be === ye) relation = '比和';
  else if (KE[be] === ye) relation = '體克用';
  else if (KE[ye] === be) relation = '用克體';
  else if (SHENG[be] === ye) relation = '體生用';
  else relation = '用生體';
  const pick = (relation === '體克用' || relation === '用生體' || relation === '比和') ? '體' : '用';
  return { upN, downN, moving, 上卦: up[0], 下卦: down[0], 體卦: ti[0], 用卦: yong[0], relation, pick };
}
function castFromNumbers(nY, nM, nD, nH) {
  return castFromTrigrams(mod(nY + nM + nD, 8), mod(nY + nM + nD + nH, 8), mod(nY + nM + nD + nH, 6));
}

function castFromTaipei(y, m, d, hh, mi) {
  const nums = numbersFromTaipei(y, m, d, hh, mi);
  return Object.assign({ nHour: nums.nHour, lunarText: nums.lunarText }, castFromNumbers(nums.nYear, nums.nMonth, nums.nDay, nums.nHour));
}

const __api = { numbersFromTaipei, castFromNumbers, castFromTrigrams, castFromTaipei, hourIndex };
if (typeof module !== 'undefined') { module.exports = __api; } else { window.MeihuaEngine = __api; }

// ─────────────── 自測 ───────────────
if (typeof require === 'function' && require.main === module && process.argv.includes('--selftest')) {
  let fail = 0;
  const ok = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ← ' + detail}`); if (!cond) fail++; };

  // 1) 觀梅占算例（卷一，已核實原文）：辰5+月12+日17=34→餘2兌上；+申9=43→餘3離下；43%6=1 初爻動
  const g = castFromNumbers(5, 12, 17, 9);
  ok('觀梅占：上卦=兌', g.上卦 === '兌', JSON.stringify(g));
  ok('觀梅占：下卦=離', g.下卦 === '離', JSON.stringify(g));
  ok('觀梅占：動爻=1(下卦動→體=上卦兌)', g.moving === 1 && g.體卦 === '兌', JSON.stringify(g));

  // 2) 萬年曆錨點：8 個農曆正月初一（年支同步驗證）
  const anchors = [[2019, 2, 5, '亥'], [2020, 1, 25, '子'], [2021, 2, 12, '丑'], [2022, 2, 1, '寅'], [2023, 1, 22, '卯'], [2024, 2, 10, '辰'], [2025, 1, 29, '巳'], [2026, 2, 17, '午']];
  for (const [y, m, d, zhi] of anchors) {
    const n = numbersFromTaipei(y, m, d, 12, 0);
    ok(`CNY ${y}-${m}-${d} = 正月初一、年支${zhi}`, n.nMonth === 1 && n.nDay === 1 && ZHI[n.nYear - 1] === zhi, JSON.stringify(n));
  }

  // 3) 時辰邊界：23:00→子1（當日）、00:30→子1、12:59→午7、15:00→申9、21:00→亥12
  ok('時辰 23:00→子(1)', hourIndex(23) === 1, hourIndex(23));
  ok('時辰 00:30→子(1)', hourIndex(0) === 1, hourIndex(0));
  ok('時辰 12:59→午(7)', hourIndex(12) === 7, hourIndex(12));
  ok('時辰 15:00→申(9)', hourIndex(15) === 9, hourIndex(15));
  ok('時辰 21:00→亥(12)', hourIndex(21) === 12, hourIndex(21));

  // 4) 23:00 不換日：同一天 22:59 與 23:30 的農曆「日」須相同（子時屬當日之自定約定）
  const a = numbersFromTaipei(2026, 7, 3, 22, 59), b = numbersFromTaipei(2026, 7, 3, 23, 30);
  ok('23:00–23:59 屬當日（農曆日不變）', a.nDay === b.nDay && a.nMonth === b.nMonth, JSON.stringify({ a, b }));

  // 5) 餘0規則：湊 (nY+nM+nD)%8==0 → 上卦=坤；(總)%6==0 → 動爻=6
  const z = castFromNumbers(1, 2, 5, 4); // 8→坤上；12%8=4震下；12%6=0→6 上爻動
  ok('餘0：上卦=坤、動爻=6(上卦動→體=下卦)', z.上卦 === '坤' && z.moving === 6 && z.體卦 === '震', JSON.stringify(z));

  console.log(fail === 0 ? '\n全部通過 ✅' : `\n${fail} 項失敗 ❌`);
  process.exit(fail === 0 ? 0 : 1);
}
