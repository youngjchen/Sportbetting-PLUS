/* odds_lab/analyze.js — 賠率走向條件切片分析（2026-07-20）
   讀 odds_lab/dataset.json → 輸出 odds_lab/REPORT.md + console 摘要
   口徑：
   - 走向 = 開盤→收盤（0 in-play 污染已驗證；「下注時點」無法回溯，收盤為近似上界）
   - 命中基準 = 各格自己的損益兩平勝率（由該格平均收盤賠率換算），不是 50%
   - 真 ROI = 押「走向側」1 單位 @ 收盤賠率（hd/ou 港賠、ml 歐賠）；走盤=0
   - 多重比較：全表格數 K 揭露；顯著標記用 Bonferroni z>z(0.05/K) */
'use strict';
const fs = require('fs');
const path = require('path');
const DS = require(path.join(__dirname, 'dataset.json'));

const rows = DS.rows.filter(r => r.res && r.date >= '2026-06-17' && r.date <= '2026-07-20');
const LGs = ['mlb', 'npb', 'kbo', 'cpbl'];

// ---- hd 線符號校準：明顯主熱門場（ml 收盤隱含主勝 ≥0.60）的收盤線符號分佈 ----
let neg = 0, pos = 0;
rows.forEach(r => {
  if (!r.ml || !r.hd || r.ml.close < 0.60) return;
  if (r.hd.closeLine < 0) neg++; else if (r.hd.closeLine > 0) pos++;
});
const HOME_GIVE_SIGN = neg >= pos ? -1 : 1;   // 主讓時線的符號
// 主隊過「收盤線」判定：margin = (hs-as) + line(以「+=主受讓」正規化)
const normLine = L => HOME_GIVE_SIGN === -1 ? L : -L;   // 正規化成 負=主讓
const homeCover = (r, L) => { const m = (r.res.hs - r.res.as) + normLine(L); return m === 0 ? null : m > 0; };

// ---- 統計工具 ----
function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
const pct = x => (100 * x).toFixed(1) + '%';
function cell(name) { return { name, n: 0, k: 0, roi: 0, odds: [], push: 0 }; }
function hit(c, ok, odds, isPush) {
  if (isPush) { c.push++; return; }
  c.n++; if (ok) c.k++;
  if (odds != null) { c.odds.push(odds); c.roi += ok ? odds : -1; }   // 港賠：贏拿 odds、輸 -1
}
function hitEu(c, ok, eu) { c.n++; if (ok) c.k++; if (eu != null) { c.odds.push(eu - 1); c.roi += ok ? (eu - 1) : -1; } }

// ---- 走向訊號 ----
const ML_TH = 0.015;   // 隱含勝率移動 ≥1.5pp 才算有方向
function mlSide(r) { if (!r.ml || r.ml.books < 2) return null; const d = r.ml.dir; return Math.abs(d) < ML_TH ? null : (d > 0 ? 'home' : 'away'); }
function hdSide(r) {
  if (!r.hd) return null;
  const lm = normLine(r.hd.closeLine) - normLine(r.hd.openLine);   // 負向移動=更看好主
  if (lm !== 0) return lm < 0 ? 'home' : 'away';
  const om = r.hd.oddsMoveHome;                                    // 線不動 → 主方讓分賠率縮=錢進主
  if (om == null || om === 0) return null;
  return om < 0 ? 'home' : 'away';
}
function ouSide(r) {
  if (!r.ou) return null;
  const lm = r.ou.lineMove;
  if (lm !== 0) return lm > 0 ? 'over' : 'under';                  // 盤口升=市場推大分
  const om = r.ou.overOddsMove;
  if (om == null || om === 0) return null;
  return om < 0 ? 'over' : 'under';                                // 大分賠率縮=錢進大分
}

// ---- 表格 ----
const T = {};
const tc = key => T[key] = T[key] || cell(key);
const winner = r => r.res.hs > r.res.as ? 'home' : (r.res.as > r.res.hs ? 'away' : null);

for (const r of rows) {
  const lg = r.league, w = winner(r);
  // 基準對照：主勝 vs 收盤熱門(低賠率方)勝 —— 2026-07-15 使用者提問的正式解答
  if (w && r.ml) {
    hit(tc('base|' + lg + '|主勝'), w === 'home', null, false);
    hit(tc('base|' + lg + '|熱門勝(收盤低賠)'), w === r.ml.favClose, null, false);
  }
  // 獨贏走向
  const ms = mlSide(r);
  if (ms && w) {
    const eu = ms === 'home' ? r.ml.closeOddsHome : r.ml.closeOddsAway;
    hitEu(tc('ml|' + lg), w === ms, eu); hitEu(tc('ml|all'), w === ms, eu);
    const mag = Math.abs(r.ml.dir);
    hitEu(tc('mlmag|' + (mag >= 0.04 ? '大(≥4pp)' : mag >= 0.025 ? '中(2.5-4pp)' : '小(1.5-2.5pp)')), w === ms, eu);
    const towardFav = ms === r.ml.favClose;
    hitEu(tc('mlfav|' + (towardFav ? '走向=熱門' : '走向=冷門')), w === ms, eu);
  }
  // 讓分走向（結果=走向側過「收盤線」）＋ 反向側（吃被推走的那邊 @收盤）
  const hs = hdSide(r);
  if (hs && r.hd) {
    const cov = homeCover(r, r.hd.closeLine);
    if (cov != null) {
      const ok = hs === 'home' ? cov : !cov;
      const odds = hs === 'home' ? r.hd.closeHome : r.hd.closeAway;
      hit(tc('hd|' + lg), ok, odds, false); hit(tc('hd|all'), ok, odds, false);
      const lineMoved = normLine(r.hd.closeLine) !== normLine(r.hd.openLine);
      hit(tc('hdch|' + (lineMoved ? '線有動' : '只賠率動')), ok, odds, false);
      // 反向（= hd 走向負訊號的可執行鏡像，不是新檢定格）
      const fadeOk = !ok;
      const fadeOdds = hs === 'home' ? r.hd.closeAway : r.hd.closeHome;
      hit(tc('hdfade|' + lg), fadeOk, fadeOdds, false); hit(tc('hdfade|all'), fadeOk, fadeOdds, false);
      hit(tc('hdfadech|' + (lineMoved ? '線有動' : '只賠率動')), fadeOk, fadeOdds, false);
    } else { tc('hd|' + lg).push++; }
  }
  // 大小走向
  const os = ouSide(r);
  if (os && r.ou) {
    const tot = r.res.hs + r.res.as, L = r.ou.closeLine;
    if (tot !== L) {
      const over = tot > L, ok = os === 'over' ? over : !over;
      const odds = os === 'over' ? r.ou.closeOver : r.ou.closeUnder;
      hit(tc('ou|' + lg), ok, odds, false); hit(tc('ou|all'), ok, odds, false);
      const lineMoved = r.ou.lineMove !== 0;
      hit(tc('ouch|' + (lineMoved ? '線有動' : '只賠率動')), ok, odds, false);
    } else { tc('ou|' + lg).push++; }
  }
  // 同向 / 矛盾（獨贏×讓分都有訊號時）
  if (ms && hs && w && r.hd) {
    const agree = ms === hs;
    const cov = homeCover(r, r.hd.closeLine);
    const eu = ms === 'home' ? r.ml.closeOddsHome : r.ml.closeOddsAway;
    hitEu(tc((agree ? 'agree' : 'conflict') + '|獨贏側勝率|' + lg), w === ms, eu);
    hitEu(tc((agree ? 'agree' : 'conflict') + '|獨贏側勝率|all'), w === ms, eu);
    if (cov != null) {
      const okHd = hs === 'home' ? cov : !cov;
      const oddsHd = hs === 'home' ? r.hd.closeHome : r.hd.closeAway;
      hit(tc((agree ? 'agree' : 'conflict') + '|讓分側過盤|all'), okHd, oddsHd, false);
      if (!agree) {   // 矛盾場：跟獨贏 vs 跟讓分，各自的讓分注結果（老虎@天使情境）
        const okMlSideCover = ms === 'home' ? cov : !cov;
        hit(tc('conflict|跟獨贏側的讓分注|all'), okMlSideCover, ms === 'home' ? r.hd.closeHome : r.hd.closeAway, false);
      }
    }
  }
}

// ---- 輸出 ----
const K = Object.values(T).filter(c => c.n >= 5).length;   // 檢定的格數（多重比較家族）
const zBonf = 3.1;   // ≈ z(0.025/40 雙尾) 量級；用作「家族顯著」粗門檻
function line(c) {
  const p = c.n ? c.k / c.n : 0, [lo, hi] = wilson(c.k, c.n);
  const avgOdds = c.odds.length ? (c.odds.reduce((s, x) => s + x, 0) / c.odds.length) : null;
  const be = avgOdds != null ? 1 / (1 + avgOdds) : null;    // 港賠/歐賠淨賠 → 損益兩平勝率
  const roiP = c.odds.length ? c.roi / c.n : null;
  let sig = '';
  if (be != null && c.n >= 20) {
    const se = Math.sqrt(be * (1 - be) / c.n), z = (p - be) / se;
    sig = Math.abs(z) >= zBonf ? ' **≠隨機(族內顯著)**' : (Math.abs(z) >= 1.96 ? ' ⚠未過多重比較' : '');
  }
  return `| ${c.name} | ${c.k}/${c.n}${c.push ? ' (走' + c.push + ')' : ''} | ${pct(p)} [${pct(lo)},${pct(hi)}] | ` +
         (be != null ? pct(be) : '—') + ' | ' + (roiP != null ? (100 * roiP).toFixed(1) + '%' : '—') + sig + ' |';
}
const order = k => Object.keys(T).filter(x => x.startsWith(k)).sort();
let md = `# 賠率走向條件切片分析（開盤→收盤）\n產出 ${new Date().toISOString()}\n\n`;
md += `樣本：${rows.length} 場有結果（2026-06-17～07-20）；hd線符號校準：主讓=${HOME_GIVE_SIGN < 0 ? '負' : '正'}（主熱門場 負${neg}/正${pos}）\n`;
md += `檢定格數 K=${K}（多重比較家族）；顯著標記=z≥${zBonf}（Bonferroni 量級）；⚠=僅單格 p<.05、未過家族校正\n`;
md += `**表頭：格 | 命中/樣本 | 命中率 [95%CI] | 損益兩平 | 真ROI**\n\n`;
const sec = (title, keys) => { md += `## ${title}\n| 格 | 命中/n | 命中率 [CI] | 兩平 | ROI |\n|---|---|---|---|---|\n`; keys.forEach(k => md += line(T[k]) + '\n'); md += '\n'; };
sec('基準對照：主勝 vs 收盤熱門勝（2026-07-15 提問正式解答）', order('base|'));
sec('獨贏走向（跟走向側，|Δ隱含|≥1.5pp）', order('ml|'));
sec('獨贏走向 × 幅度', order('mlmag|'));
sec('獨贏走向 × 走向朝熱門/冷門', order('mlfav|'));
sec('讓分走向（跟走向側過收盤線）', order('hd|'));
sec('讓分走向 × 通道', order('hdch|'));
sec('讓分「反向」＝吃被推走的一邊 @收盤（負訊號的可執行鏡像，非獨立檢定格）', order('hdfade|'));
sec('讓分反向 × 通道', order('hdfadech|'));
sec('大小走向（跟走向側）', order('ou|'));
sec('大小走向 × 通道', order('ouch|'));
sec('獨贏×讓分 同向', order('agree|'));
sec('獨贏×讓分 矛盾', order('conflict|'));
md += `## 口徑與限制\n- 「下注時點」無法回溯（hd/ou 無時戳），本分析=開盤→收盤全段；你實際下注多在收盤前，訊號只會更弱不會更強。\n- 收盤=最後一筆盤前 tick（已驗證 0 開賽後污染）。\n- ROI 用走向側收盤賠率＝「看到收盤才下」的理想化；實際可得賠率略差。\n- 6/17-6/21 亞洲場無結果史（pregame 6/22 起）；雨天中止場自然剔除。\n- 單格 n<30 全是雜訊等級；跨 K 格挑最亮的格=保證撿到假訊號，只認過家族校正的格。\n`;
fs.writeFileSync(path.join(__dirname, 'REPORT.md'), md);
console.log(md);
