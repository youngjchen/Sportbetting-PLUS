/* ============================================================
   實驗 S Exploratory：讓分＋獨贏 同宮投影（協議附錄 §3/§8 預先聲明之探索支流）
   ── 地位聲明：exploratory，不作任何 confirmatory 主張；~8 格探索、未校正多重比較。
   ── 判定式（先申報後執行，verification-before-completion 紀律）：
   樣本＝凍結 ledger（divination-freeze-S-v1）gamePk 全集 join joined 結果列。
   讓分（annex §4：吉→押台彩讓分方）：
     fav = hdAwayLine<0 ? away : home（客隊線負＝客讓；玩運彩線＝台彩盤；全 .5 無 push，0 線斷言不存在）
     homeCover = (homeScore−awayScore) > hdAwayLine（M exploratory_spread.js 同式）
     favCover = fav==home ? homeCover : !homeCover
     hit = (pick=='大'／吉 → 押 fav) === favCover；排除 flags.swapped（主客向影響讓分）與 hdAwayLine==null
   獨贏（annex §4：吉→押主隊）：
     homeWin = homeScore>awayScore；hit = (吉) === homeWin；homeMargin==0 保險排除
   空亡/missedPulse/fetchFail＝棄場（排除分子分母）。
   p₀ 類比＝f·q_mk+(1−f)(1−q_mk)，f＝各臂凍結押吉率（.6007/.5949）、q_mk＝該市場子樣本結果邊際。
   用法：node xiaoliuren_exploratory.js
   ============================================================ */
'use strict';
const fs = require('fs');

const J = require('./data/divination_joined.json');
const byPk = new Map(J.filter(o => o.gamePk).map(o => [o.gamePk, o]));
const timeLedger = JSON.parse(fs.readFileSync('divination_lab/xiaoliuren_casts_time.json', 'utf8'));
const randLedger = JSON.parse(fs.readFileSync('divination_lab/xiaoliuren_casts_rand.json', 'utf8')).filter(e => e.status === 'cast');

const wilson = (x, n) => { const p = x / n, z = 1.96, z2 = z * z; const c = p + z2 / (2 * n), d = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n), e = 1 + z2 / n; return `[${(100 * (c - d) / e).toFixed(2)},${(100 * (c + d) / e).toFixed(2)}]`; };
const pct = (a, b) => (100 * a / b).toFixed(2) + '%';

function run(armName, ledger, fLocked) {
  const sp = { n: 0, hit: 0, favCov: 0 }, ml = { n: 0, hit: 0, homeWin: 0 };
  for (const e of ledger) {
    if (e.pick == null) continue;                      // 空亡棄場
    const ji = e.pick === '大';                        // 吉/凶 的 ledger 代理（§8 映射）
    const r = byPk.get(e.gamePk);
    if (!r) throw new Error('join 破損 ' + e.gamePk);
    const hm = r.homeScore - r.awayScore;
    if (r.hdAwayLine != null && !r.flags.swapped) {
      if (r.hdAwayLine === 0) throw new Error('0 線出現，違反 .5 線假設');
      const homeCover = hm > r.hdAwayLine;
      const fav = r.hdAwayLine < 0 ? 'away' : 'home';
      const favCover = fav === 'home' ? homeCover : !homeCover;
      sp.n++; if (favCover) sp.favCov++;
      if (ji === favCover) sp.hit++;                   // 吉→押讓分方
    }
    if (hm !== 0) {
      const homeWin = hm > 0;
      ml.n++; if (homeWin) ml.homeWin++;
      if (ji === homeWin) ml.hit++;                    // 吉→押主隊
    }
  }
  const qSp = sp.favCov / sp.n, qMl = ml.homeWin / ml.n;
  const p0Sp = fLocked * qSp + (1 - fLocked) * (1 - qSp);
  const p0Ml = fLocked * qMl + (1 - fLocked) * (1 - qMl);
  console.log(`\n── ${armName}（f=${(100 * fLocked).toFixed(2)}%）──`);
  console.log(`讓分  n=${sp.n}  命中 ${pct(sp.hit, sp.n)}  CI${wilson(sp.hit, sp.n)}  讓分方過盤率 ${pct(sp.favCov, sp.n)}  p₀類比 ${(100 * p0Sp).toFixed(2)}%`);
  console.log(`獨贏  n=${ml.n}  命中 ${pct(ml.hit, ml.n)}  CI${wilson(ml.hit, ml.n)}  主勝率 ${pct(ml.homeWin, ml.n)}  p₀類比 ${(100 * p0Ml).toFixed(2)}%  （盲押主場基準 ${pct(ml.homeWin, ml.n)}）`);
  return { sp, ml, p0Sp, p0Ml };
}

console.log('=== 實驗 S EXPLORATORY（讓分/獨贏同宮投影；不作主張、未校正多重比較）===');
run('S-time', timeLedger, 8095 / 13476);
run('S-rand', randLedger, 6747 / 11341);
console.log('\n（讓分排除 swapped 與無線場；獨贏無賠率不與市場比較；全部格子 exploratory）');
