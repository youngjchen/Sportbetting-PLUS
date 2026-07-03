/* ============================================================
   Exploratory：讓分＋獨贏 描述性分析（divination-lab，協議 §8 標註）
   ── 地位聲明：exploratory，不作任何 confirmatory 主張；BH-FDR 標註後僅描述。
   讓分：pick 體=主隊 → 押主隊盤；homeCover = (homeScore−awayScore) > hdAwayLine（hdAwayLine=客隊線，全 .5 無 push）。
   獨贏：無賠率資料（爬蟲未抓獨贏盤）→ 僅描述 hit% 對比「盲押主場」基準與調整後 p₀ 類比；禁止對 50% 比較。
   排除：非例行賽/非Final/7局/ambiguous/swapped(主客向影響讓分)/無讓分線/比和卦。
   用法：node exploratory_spread.js
   ============================================================ */
'use strict';
const eng = require('./meihua_engine.js');
const J = require('./data/divination_joined.json');

const rows = J.filter(o => o.gamePk && o.gameType === 'R' && !o.flags.notFinal && !o.flags.sevenInning && !o.flags.ambiguous && !o.flags.swapped && o.totalRuns != null);
let sp = { n: 0, hit: 0, pickHome: 0 }, ml = { n: 0, hit: 0, pickHome: 0, homeWin: 0 };
for (const r of rows) {
  const [Y, M, D] = r.date.split('-').map(Number); const [h, mi] = r.time.split(':').map(Number);
  const c = eng.castFromTaipei(Y, M, D, h, mi);
  if (c.relation === '比和') continue;
  const pickHome = c.pick === '體';                       // 極性：體=主隊
  const homeMargin = r.homeScore - r.awayScore;
  if (r.hdAwayLine != null) {
    const homeCover = homeMargin > r.hdAwayLine;
    sp.n++; if (pickHome) sp.pickHome++;
    if (pickHome === homeCover) sp.hit++;
  }
  if (homeMargin !== 0) {                                  // MLB 無和局，保險
    const homeWin = homeMargin > 0;
    ml.n++; if (pickHome) ml.pickHome++; if (homeWin) ml.homeWin++;
    if (pickHome === homeWin) ml.hit++;
  }
}
const pct = (a, b) => (100 * a / b).toFixed(2) + '%';
const wilson = (x, n) => { const p = x / n, z = 1.96, z2 = z * z; const c = p + z2 / (2 * n), d = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n), e = 1 + z2 / n; return [(100 * (c - d) / e).toFixed(2), (100 * (c + d) / e).toFixed(2)]; };

console.log('=== EXPLORATORY（不作主張）===');
{
  const pSide = sp.pickHome / sp.n, pCov = null;
  const homeCoverRate = rows.filter(r => r.hdAwayLine != null && (r.homeScore - r.awayScore) > r.hdAwayLine).length / rows.filter(r => r.hdAwayLine != null).length;
  const p0 = pSide * homeCoverRate + (1 - pSide) * (1 - homeCoverRate);
  console.log(`讓分  n=${sp.n}  命中 ${pct(sp.hit, sp.n)}  CI[${wilson(sp.hit, sp.n)}]  押主隊率 ${pct(sp.pickHome, sp.n)}  主隊蓋盤率 ${pct(Math.round(homeCoverRate * sp.n), sp.n)}  p₀類比 ${(100 * p0).toFixed(2)}%`);
}
{
  const pSide = ml.pickHome / ml.n, pHome = ml.homeWin / ml.n;
  const p0 = pSide * pHome + (1 - pSide) * (1 - pHome);
  console.log(`獨贏  n=${ml.n}  命中 ${pct(ml.hit, ml.n)}  CI[${wilson(ml.hit, ml.n)}]  押主隊率 ${pct(ml.pickHome, ml.n)}  主隊勝率 ${pct(ml.homeWin, ml.n)}  p₀類比 ${(100 * p0).toFixed(2)}%  盲押主場基準 ${pct(ml.homeWin, ml.n)}`);
}
console.log('（讓分排除 swapped 2 列；獨贏無賠率資料，不與市場比較、不與 50% 比較）');
