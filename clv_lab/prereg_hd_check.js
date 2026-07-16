// clv_lab/prereg_hd_check.js — HD-LIGHTS-01 分帳器（規格見 PREREG_HD_LIGHTS.md,凍結2026-07-16）
// 預設遮蔽: 只顯示累積注數。開盒: node prereg_hd_check.js --unseal (n<100 會拒絕並警告 peeking)
'use strict';
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const START = '2026-07-17', DEADLINE = '2026-10-31', TARGET = 100;
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'state/board_state.json.gz'))).toString());
const gs = Object.values(doc.games || {}).filter(g => g.date >= START && g.date <= DEADLINE && g.lightsSnapshot
  && (g.hdResult === 'fav_cover' || g.hdResult === 'fav_nocover'));
const picks = [];   // {date, league, side, hit}
let marketN = 0, marketCover = 0;
for (const g of Object.values(doc.games || {})) {
  if (!(g.date >= START && g.date <= DEADLINE)) continue;
  if (g.hdResult === 'fav_cover' || g.hdResult === 'fav_nocover') { marketN++; if (g.hdResult === 'fav_cover') marketCover++; }
}
for (const g of gs) {
  const ls = g.lightsSnapshot;
  if ((ls.hdGive || 0) >= 3) picks.push({ date: g.date, league: g.league, side: 'give', hit: g.hdResult === 'fav_cover' });
  if ((ls.hdRecv || 0) >= 3) picks.push({ date: g.date, league: g.league, side: 'recv', hit: g.hdResult === 'fav_nocover' });
}
const n = picks.length;
console.log(`HD-LIGHTS-01 分帳（${START} 起）`);
console.log(`累積注數: ${n} / ${TARGET}${n >= TARGET ? ' ✅ 達標,可開盒' : ''}`);
if (!process.argv.includes('--unseal')) { console.log('（命中率遮蔽中;開盒: --unseal）'); process.exit(0); }
if (n < TARGET) { console.log(`⚠️ n=${n} < ${TARGET},提前開盒=peeking,結論只能算探索性。確定要看請加 --force`); if (!process.argv.includes('--force')) process.exit(1); }
// 主檢: p0 依側別=驗證期市場基準
const pCover = marketCover / marketN;
let hits = 0, e = 0, v = 0;
for (const p of picks) { const p0 = p.side === 'give' ? pCover : 1 - pCover; if (p.hit) hits++; e += p0; v += p0 * (1 - p0); }
const z = (hits - e) / Math.sqrt(v);
const pval = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
function erf(t) { const s = t < 0 ? -1 : 1; t = Math.abs(t); const u = 1 / (1 + 0.3275911 * t);
  return s * (1 - (((((1.061405429 * u - 1.453152027) * u) + 1.421413741) * u - 0.284496736) * u + 0.254829592) * u * Math.exp(-t * t)); }
const excess = 100 * (hits - e) / n;
console.log(`\n=== 開盒 ===`);
console.log(`命中 ${hits}/${n}=${(100 * hits / n).toFixed(1)}% | 期望 ${e.toFixed(1)} (驗證期過盤基準 ${(100 * pCover).toFixed(1)}%, n=${marketN})`);
console.log(`合併超額 ${excess >= 0 ? '+' : ''}${excess.toFixed(1)}pp | z=${z.toFixed(2)} | p=${pval.toFixed(4)}`);
console.log(`判決(凍結規則): ${pval < 0.05 && excess >= 5 ? '✅ 升可用訊號(滾動監控)' : '❌ 回探索池,停用此規則下注'}`);
const bySide = { give: picks.filter(p => p.side === 'give'), recv: picks.filter(p => p.side === 'recv') };
for (const s in bySide) { const a = bySide[s]; console.log(`次要 ${s}: ${a.filter(p => p.hit).length}/${a.length}`); }
