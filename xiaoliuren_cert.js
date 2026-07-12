/* ============================================================
   實驗 S 認證腳本（S-time 臂）：對合格樣本枚舉宮位 → 押注面分布認證
   ‼️ 偷看防護（協議鐵律「凍結前禁止卦象×結果統計」的腳本層落實）：
   - 本腳本只輸出「押注側」統計（宮位分布/押大率/棄場率/逐年逐時辰）
   - totalRuns 僅用於 M §7 合格過濾（沿用 analysis_oneshot.js:32 原句），
     絕不與宮位交叉；輸出前結構性斷言：產物不含任何比分欄位
   - p₀ 僅為暫定值：用 M 已公開之開大率常數掃描敏感度；正式 p₀ 由凍結
     後的 analysis 腳本於分析日重算（M §3 前例）
   執行：node xiaoliuren_cert.js
   產出：divination_lab/xiaoliuren_casts_time.json（一場一宮 ledger，無結果欄）
         divination_lab/xiaoliuren_cert_time.json（認證統計）
   ============================================================ */
'use strict';
const fs = require('fs');
const { castFromAnchorUtcMs, PALACES } = require('./xiaoliuren_engine');

const J = require('./data/divination_joined.json');
// M §7 合格過濾（analysis_oneshot.js:32 原句沿用）
const rows = J.filter(o => o.gamePk && o.gameType === 'R' && !o.flags.notFinal && !o.flags.sevenInning && !o.flags.noLine && !o.flags.push && !o.flags.ambiguous && o.totalRuns != null);
console.log(`合格樣本：${rows.length}（joined 全量 ${J.length}）`);

const ledger = [];
const palaceCnt = Object.fromEntries(PALACES.map(p => [p, 0]));
const byYear = {}, byHour = {};
for (const r of rows) {
  const ms = Date.parse(r.gameDateUTC);
  if (!isFinite(ms)) throw new Error(`gameDateUTC 壞值 gamePk=${r.gamePk}: ${r.gameDateUTC}`);
  const c = castFromAnchorUtcMs(ms); // 引擎內建閉式=逐步運行時斷言
  palaceCnt[c.palace]++;
  const y = r.officialDate.slice(0, 4);
  (byYear[y] ||= { 大: 0, 小: 0, 棄: 0 })[c.pick || '棄']++;
  (byHour[c.nHour] ||= 0); byHour[c.nHour]++;
  ledger.push({
    gamePk: r.gamePk, officialDate: r.officialDate, anchorUtc: c.anchorUtc,
    lunarText: c.lunarText, nMonth: c.nMonth, nDay: c.nDay, nHour: c.nHour,
    palace: c.palace, monthPalace: c.monthPalace, dayPalace: c.dayPalace,
    verdict: c.verdict, pick: c.pick,
  });
}

const n = ledger.length;
const nBig = ledger.filter(l => l.pick === '大').length;
const nSmall = ledger.filter(l => l.pick === '小').length;
const nAbstain = ledger.filter(l => l.pick === null).length;
const nActive = nBig + nSmall;
const pct = (x, d) => (100 * x / d).toFixed(2) + '%';

console.log('\n── 宮位分布 ──');
for (const p of PALACES) console.log(`  ${p}: ${palaceCnt[p]} (${pct(palaceCnt[p], n)})`);
console.log(`\n── 押注面（認證值候選）──`);
console.log(`  押大 ${nBig} (${pct(nBig, n)} 全樣本；有表態中 ${pct(nBig, nActive)})`);
console.log(`  押小 ${nSmall} (${pct(nSmall, n)})`);
console.log(`  空亡棄場 ${nAbstain} (${pct(nAbstain, n)})`);
console.log('\n── 逐年押注面（絆線基礎）──');
for (const y of Object.keys(byYear).sort()) {
  const v = byYear[y], t = v.大 + v.小 + v.棄;
  console.log(`  ${y}: n=${t} 押大(有表態中)=${pct(v.大, v.大 + v.小)} 棄=${pct(v.棄, t)}`);
}
console.log('\n── 錨定時辰分布（−240 分後，叢集記錄）──');
for (let h = 1; h <= 12; h++) if (byHour[h]) console.log(`  時支${h}: ${byHour[h]} (${pct(byHour[h], n)})`);

// 暫定 p₀ 敏感度掃描（q=開大率；正式值分析日由凍結腳本重算）
const pBig = nBig / nActive;
console.log('\n── 暫定 p₀ 掃描（有表態樣本；p₀ = pBig·q + (1−pBig)·(1−q)）──');
for (const q of [0.48, 0.49, 0.4926, 0.50, 0.51])
  console.log(`  q(開大率)=${q}: p₀=${(pBig * q + (1 - pBig) * (1 - q)).toFixed(5)}`);
console.log('  （S-rand 臂精確押注面：有表態中押大=60% 整，同式代入）');

// 結構性斷言：產物無比分欄
const blob = JSON.stringify(ledger);
for (const k of ['totalRuns', 'awayScore', 'homeScore', 'totLine', 'hdAwayLine'])
  if (blob.includes(`"${k}"`)) throw new Error(`偷看防護失敗：ledger 含 ${k}`);

fs.writeFileSync('divination_lab/xiaoliuren_casts_time.json', blob);
fs.writeFileSync('divination_lab/xiaoliuren_cert_time.json', JSON.stringify({
  generatedAt: new Date().toISOString(), eligible: n, palaceCnt,
  pickBig: nBig, pickSmall: nSmall, abstain: nAbstain,
  pBigActive: pBig, abstainRate: nAbstain / n, byYear, byHour,
  note: 'p₀ 為暫定掃描；正式 p₀ 於分析日由凍結腳本按協議 §3 重算。無任何卦象×結果交叉。',
}, null, 2));
console.log('\n已寫 divination_lab/xiaoliuren_casts_time.json ＋ xiaoliuren_cert_time.json');
