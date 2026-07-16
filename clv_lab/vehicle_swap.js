// clv_lab/vehicle_swap.js — 「同眼光換載具」回測（2026-06-02~07-16 全窗,燈號快照 979 場）
// 修正: hdResult 值域實為 fav_cover/fav_nocover(前輪 July 報告 hd 格被靜默漏掉,本輪含正）
// 問題: 同一批 ML ≥3燈訊號,換三種載具的損益——
//   載具A: 照舊押獨贏(真實收盤賠率,分賠率檔)  載具B: 只在賠率過門檻才押(1.70/1.85/2.00)
//   載具C: 改押同隊讓分盤(訊號隊=讓分方→押過盤;=受讓方→押受讓;賠率未存,以 1.90/1.75 兩檔損益兩平線對照)
// 檢定: Wilson CI;賠率檔=探索性(多重比較,不下結論只找方向)
'use strict';
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'state/board_state.json.gz'))).toString());
const wilson = (x, n) => { if (!n) return [0, 0]; const p = x / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)]; };
const F = (x, n) => { const [lo, hi] = wilson(x, n); return `${x}/${n}=${n ? (100 * x / n).toFixed(1) : '-'}% CI[${(100 * lo).toFixed(0)},${(100 * hi).toFixed(0)}]`; };

const gs = Object.values(doc.games || {}).filter(g => g.date >= '2026-06-02' && g.lightsSnapshot);
const mlPicks = [];
for (const g of gs) {
  const ls = g.lightsSnapshot;
  for (const [k, side] of [['mlAway', 'away'], ['mlHome', 'home']]) {
    if ((ls[k] || 0) < 3) continue;
    if (!(g.mlResult === 'away' || g.mlResult === 'home' || g.mlResult === 'tie')) continue;
    const odds = side === 'away' ? g.closeOddsAway : g.closeOddsHome;
    const oppOdds = side === 'away' ? g.closeOddsHome : g.closeOddsAway;
    mlPicks.push({ league: g.league, side, tie: g.mlResult === 'tie', hit: g.mlResult === side,
      odds: (odds > 1 && odds < 20) ? odds : null, isFav: (odds > 1 && oppOdds > 1) ? odds < oppOdds : null,
      hdFav: g.hdFav, hdResult: g.hdResult });
  }
}
const live = mlPicks.filter(p => !p.tie);
const roi = (arr) => arr.length ? arr.reduce((s, p) => s + (p.hit ? p.odds - 1 : -1), 0) / arr.length : null;

// A. 賠率檔
const buckets = [['<1.50', o => o < 1.5], ['1.50-1.69', o => o >= 1.5 && o < 1.7], ['1.70-1.84', o => o >= 1.7 && o < 1.85], ['1.85-1.99', o => o >= 1.85 && o < 2.0], ['≥2.00', o => o >= 2.0]];
const withOdds = live.filter(p => p.odds);
let out = `# 同眼光換載具回測（ML ≥3燈訊號,6/2~7/16）\n產出 ${new Date().toISOString()}\n\n`;
out += `樣本: ML 訊號 ${mlPicks.length}（和局 ${mlPicks.length - live.length} 排除）,有收盤賠率 ${withOdds.length}\n\n## 載具A: 照舊押獨贏 — 按收盤賠率分檔（探索性）\n| 賠率檔 | 命中 | 真實ROI |\n|---|---|---|\n`;
for (const [name, f] of buckets) {
  const a = withOdds.filter(p => f(p.odds));
  out += `| ${name} | ${F(a.filter(p => p.hit).length, a.length)} | ${a.length ? (100 * roi(a)).toFixed(1) + '%' : '-'} |\n`;
}
out += `| **全部** | ${F(withOdds.filter(p => p.hit).length, withOdds.length)} | **${(100 * roi(withOdds)).toFixed(1)}%** |\n`;
// 熱門/冷門
const fav = withOdds.filter(p => p.isFav === true), dog = withOdds.filter(p => p.isFav === false);
out += `\n- 訊號隊=熱門: ${F(fav.filter(p => p.hit).length, fav.length)}, ROI ${(100 * roi(fav)).toFixed(1)}%\n- 訊號隊=冷門: ${F(dog.filter(p => p.hit).length, dog.length)}, ROI ${(100 * roi(dog)).toFixed(1)}%\n`;

// B. 門檻
out += `\n## 載具B: 只在賠率 ≥ 門檻才出手（累積門檻）\n| 門檻 | n | 命中 | 真實ROI |\n|---|---|---|---|\n`;
for (const t of [1.0, 1.5, 1.7, 1.85, 2.0]) {
  const a = withOdds.filter(p => p.odds >= t);
  out += `| ≥${t.toFixed(2)} | ${a.length} | ${a.length ? (100 * a.filter(p => p.hit).length / a.length).toFixed(1) + '%' : '-'} | ${a.length ? (100 * roi(a)).toFixed(1) + '%' : '-'} |\n`;
}

// C. 換讓分盤
const hdExpr = live.filter(p => p.hdFav && (p.hdResult === 'fav_cover' || p.hdResult === 'fav_nocover'));
const hdHits = hdExpr.filter(p => (p.side === p.hdFav) ? p.hdResult === 'fav_cover' : p.hdResult === 'fav_nocover');
const givePicks = hdExpr.filter(p => p.side === p.hdFav), recvPicks = hdExpr.filter(p => p.side !== p.hdFav);
out += `\n## 載具C: 同一眼光改押讓分盤（賠率未存;損益兩平參考 52.6%@1.90 / 57.1%@1.75台彩）\n`;
out += `- 全部: ${F(hdHits.length, hdExpr.length)}\n`;
out += `- 訊號隊=讓分方(押過盤): ${F(givePicks.filter(p => p.hdResult === 'fav_cover').length, givePicks.length)}\n`;
out += `- 訊號隊=受讓方(押受讓): ${F(recvPicks.filter(p => p.hdResult === 'fav_nocover').length, recvPicks.length)}\n`;

// 修正: 全窗 hd/tot 訊號(前輪值域錯漏)
const hdSig = { n: 0, x: 0 }, totSig = { n: 0, x: 0 };
for (const g of gs) {
  const ls = g.lightsSnapshot;
  if ((ls.hdGive || 0) >= 3 && (g.hdResult === 'fav_cover' || g.hdResult === 'fav_nocover')) { hdSig.n++; if (g.hdResult === 'fav_cover') hdSig.x++; }
  if ((ls.hdRecv || 0) >= 3 && (g.hdResult === 'fav_cover' || g.hdResult === 'fav_nocover')) { hdSig.n++; if (g.hdResult === 'fav_nocover') hdSig.x++; }
  for (const [k, want] of [['over', 'over'], ['under', 'under']]) {
    if ((ls[k] || 0) >= 3 && (g.totResult === 'over' || g.totResult === 'under')) { totSig.n++; if ((g.myTotResult || g.totResult) === want) totSig.x++; }
  }
}
out += `\n## 補正: 讓分/大小 ≥3燈 訊號本身（全窗;前輪報告因值域錯而漏掉 hd）\n- 讓分訊號: ${F(hdSig.x, hdSig.n)}（vs 52.6%@1.90 / 57.1%@1.75）\n- 大小訊號: ${F(totSig.x, totSig.n)}\n`;
fs.writeFileSync(path.join(__dirname, 'VEHICLE_REPORT.md'), out);
console.log(out);
