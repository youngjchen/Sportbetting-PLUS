// clv_lab/review_2026_07.js — 三合一分析（statistical-analyst 主菜,2026-07-16）
// ① 七月結構複盤: ≥3燈代理訊號(戰面板同定義) league×market 命中率+Wilson CI+ML真實ROI;
//    真實注帳(注章/成交線)原樣列出(n太小不做推論)
// ② 台彩滯後回測(bf_labeled 2,114場,4/1-6/26)——假設「先申報後跑」:
//    H1(讓分): 兩書同讓分方且 |bet365收盤線−台彩收盤線|≥1 → 押 bet365 較看好側 對台彩線;虛無=50%
//    H2(大小): |bet365收盤大小−台彩大小|≥0.5 → 往 bet365 方向押 對台彩線;虛無=50%
//    次要: 劑量反應、前後半穩定性。損益兩平參考=52.4%(賠率1.91)。多重比較: 2主+探索格,探索不下結論
// ③ CLV 現況: 成交線紀錄 n=5 原樣展示(🔴不足推論)+收盤線採樣品質守門(odds_log lastUpdated vs start)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const OUT = __dirname;
const wilson = (x, n) => { if (!n) return [0, 0]; const p = x / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)]; };
const zTest50 = (x, n) => { if (!n) return 1; const p = x / n, se = Math.sqrt(0.25 / n);
  const z = (p - 0.5) / se; return 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2))); };
function erf(t) { const s = t < 0 ? -1 : 1; t = Math.abs(t); const u = 1 / (1 + 0.3275911 * t);
  return s * (1 - (((((1.061405429 * u - 1.453152027) * u) + 1.421413741) * u - 0.284496736) * u + 0.254829592) * u * Math.exp(-t * t)); }
const fmt = (x, n) => { const [lo, hi] = wilson(x, n); return `${x}/${n}=${n ? (100 * x / n).toFixed(1) : '-'}% CI[${(100 * lo).toFixed(0)},${(100 * hi).toFixed(0)}]`; };

// ========== ① 七月結構複盤 ==========
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'state/board_state.json.gz'))).toString());
const games = Object.values(doc.games || {}).filter(g => g.date >= '2026-07-01' && g.date <= '2026-07-16');
const picks = [];   // {league, mkt, side, hit, odds}
for (const g of games) {
  const ls = g.lightsSnapshot || {};
  const L = g.league || '?';
  // ML
  for (const [k, side] of [['mlAway', 'away'], ['mlHome', 'home']]) {
    if ((ls[k] || 0) >= 3 && g.mlResult && g.mlResult !== 'tie') {
      const odds = side === 'away' ? g.closeOddsAway : g.closeOddsHome;
      picks.push({ league: L, mkt: 'ml', side, hit: g.mlResult === side, odds: (odds > 1 && odds < 20) ? odds : null, real: !!ls['bet' + (side === 'away' ? 'Away' : 'Home')] });
    }
  }
  // 讓分（市場收盤線結果;成交線僅5場,列註）
  for (const [k, want] of [['hdGive', 'cover'], ['hdRecv', 'nocover']]) {
    if ((ls[k] || 0) >= 3 && (g.hdResult === 'cover' || g.hdResult === 'nocover'))
      picks.push({ league: L, mkt: 'hd', side: k, hit: g.hdResult === want, odds: null, real: !!ls[k === 'hdGive' ? 'betGive' : 'betRecv'] });
  }
  // 大小
  for (const [k, want] of [['over', 'over'], ['under', 'under']]) {
    if ((ls[k] || 0) >= 3 && (g.totResult === 'over' || g.totResult === 'under'))
      picks.push({ league: L, mkt: 'tot', side: k, hit: (g.myTotResult || g.totResult) === want, odds: null, real: !!ls[k === 'over' ? 'betOver' : 'betUnder'] });
  }
}
const grid = {};
for (const p of picks) { const k = `${p.league}|${p.mkt}`; const c = grid[k] = grid[k] || { n: 0, x: 0 }; c.n++; if (p.hit) c.x++; }
const mlPicks = picks.filter(p => p.mkt === 'ml' && p.odds);
const mlROI = mlPicks.length ? mlPicks.reduce((s, p) => s + (p.hit ? p.odds - 1 : -1), 0) / mlPicks.length : null;
// 基準率(同窗)
const base = { hdCover: { n: 0, x: 0 }, over: { n: 0, x: 0 }, homeML: { n: 0, x: 0 } };
for (const g of games) {
  if (g.hdResult === 'cover' || g.hdResult === 'nocover') { base.hdCover.n++; if (g.hdResult === 'cover') base.hdCover.x++; }
  if (g.totResult === 'over' || g.totResult === 'under') { base.over.n++; if (g.totResult === 'over') base.over.x++; }
  if (g.mlResult === 'away' || g.mlResult === 'home') { base.homeML.n++; if (g.mlResult === 'home') base.homeML.x++; }
}
const realBets = picks.filter(p => p.real);

// ========== ② 台彩滯後回測 ==========
const bf = require(path.join(ROOT, 'divination_lab/titan_backfill/bf_labeled.json'));
const bfArr = Array.isArray(bf) ? bf : Object.values(bf);
const uni = bfArr.filter(g => g.intlCloseLine != null && g.lotHdAwayLine != null && g.awayScore != null && g.homeScore != null
  && Math.sign(g.intlCloseLine) === Math.sign(g.lotHdAwayLine));   // 同讓分方(顛倒場另研究已null)
const H1 = { all: { n: 0, x: 0 }, d1: { n: 0, x: 0 }, d2: { n: 0, x: 0 }, h1: { n: 0, x: 0 }, h2: { n: 0, x: 0 }, byPick: { away: { n: 0, x: 0 }, home: { n: 0, x: 0 } } };
const coverAway = (g) => { const v = g.awayScore + g.lotHdAwayLine - g.homeScore; return v === 0 ? null : v > 0; };
let sameLine = 0;
for (const g of uni) {
  const diff = g.intlCloseLine - g.lotHdAwayLine;
  if (Math.abs(diff) < 1) { if (diff === 0) sameLine++; continue; }
  const pick = diff < 0 ? 'away' : 'home';
  const ca = coverAway(g); if (ca == null) continue;
  const hit = pick === 'away' ? ca : !ca;
  H1.all.n++; if (hit) H1.all.x++;
  const bucket = Math.abs(diff) >= 2 ? H1.d2 : H1.d1; bucket.n++; if (hit) bucket.x++;
  const half = g.date < '2026-05-15' ? H1.h1 : H1.h2; half.n++; if (hit) half.x++;
  H1.byPick[pick].n++; if (hit) H1.byPick[pick].x++;
}
const uniT = bfArr.filter(g => g.intlOuClose != null && g.lotTotLine != null && g.awayScore != null && g.homeScore != null);
const H2 = { all: { n: 0, x: 0 }, d05: { n: 0, x: 0 }, d1: { n: 0, x: 0 }, h1: { n: 0, x: 0 }, h2: { n: 0, x: 0 }, byPick: { over: { n: 0, x: 0 }, under: { n: 0, x: 0 } } };
for (const g of uniT) {
  const diff = g.intlOuClose - g.lotTotLine;
  if (Math.abs(diff) < 0.5) continue;
  const pick = diff > 0 ? 'over' : 'under';
  const tot = g.awayScore + g.homeScore;
  if (tot === g.lotTotLine) continue;
  const hit = pick === 'over' ? tot > g.lotTotLine : tot < g.lotTotLine;
  H2.all.n++; if (hit) H2.all.x++;
  const bucket = Math.abs(diff) >= 1 ? H2.d1 : H2.d05; bucket.n++; if (hit) bucket.x++;
  const half = g.date < '2026-05-15' ? H2.h1 : H2.h2; half.n++; if (hit) half.x++;
  H2.byPick[pick].n++; if (hit) H2.byPick[pick].x++;
}

// ========== ③ CLV 現況 + 採樣品質 ==========
const clvRows = [];
for (const g of Object.values(doc.games || {})) {
  for (const [mine, side] of [['myHdAwayLine', 'away'], ['myHdHomeLine', 'home']]) {
    if (g[mine] != null && g[mine] !== '' && g.hdVal != null) {
      // 台彩/STAKE 語義: 卡片 hdFav+hdVal=收盤讓分方與線;成交線帶正負(受讓+)
      clvRows.push({ date: g.date, side, taken: g[mine], closeFav: g.hdFav, closeVal: g.hdVal, res: side === 'away' ? g.myHdGiveResult || g.hdResult : g.myHdRecvResult || g.hdResult });
    }
  }
  if (g.myTotLine != null && g.myTotLine !== '' && g.totVal != null && g.myTotLine !== g.totVal)
    clvRows.push({ date: g.date, side: 'tot', taken: g.myTotLine, closeVal: g.totVal, res: g.myTotResult });
}
const ol = require(path.join(ROOT, 'data/odds_log.json'));
const q = { n: 0, within30: 0, within60: 0, after: 0 };
for (const k in ol.matches) {
  const m = ol.matches[k];
  if (!m.startISO || !m.lastUpdated || !(m.startISO >= '2026-07-01')) continue;
  q.n++;
  const gap = (new Date(m.startISO) - new Date(m.lastUpdated)) / 60000;   // 分;負=開賽後仍有更新(grace)
  if (gap <= 0) q.after++; else if (gap <= 30) q.within30++; else if (gap <= 60) q.within60++;
}

// ========== 報告 ==========
const md = `# CLV／結構複盤／台彩滯後回測 報告
產出 ${new Date().toISOString()}（statistical-analyst;假設先申報後跑,見腳本頭部注釋）

## ① 七月結構複盤（7/1~7/16 已結算 ${games.length} 場;訊號代理=該市場側 ≥3燈,同戰面板定義）
> ⚠️ 這是「訊號複盤」非「注單複盤」——真實注帳(注章)7/12 才上線。ML 有真實收盤賠率→算真 ROI;讓分/大小無存賠率→只看命中率(損益兩平參考 52.4%@1.91)。

| 聯盟×市場 | 命中 | 同窗基準 |
|---|---|---|
${Object.keys(grid).sort().map(k => { const [lg, mkt] = k.split('|'); const c = grid[k];
  const b = mkt === 'hd' ? `過盤基準 ${(100 * base.hdCover.x / base.hdCover.n).toFixed(0)}%` : mkt === 'tot' ? `開大基準 ${(100 * base.over.x / base.over.n).toFixed(0)}%` : `主勝基準 ${(100 * base.homeML.x / base.homeML.n).toFixed(0)}%`;
  return `| ${lg} ${mkt} | ${fmt(c.x, c.n)} | ${b} |`; }).join('\n')}

- 總計: ${fmt(picks.filter(p => p.hit).length, picks.length)}
- **ML 真實 ROI（有收盤賠率的 ${mlPicks.length} 個 ML 訊號,單注 1 元）: ${mlROI == null ? 'n/a' : (100 * mlROI).toFixed(1) + '%'}**
- 真實注帳（注章,7/12 起）: ${fmt(realBets.filter(p => p.hit).length, realBets.length)} —— 🔴 n 過小,只記帳不推論

## ② 台彩滯後回測（bf_labeled 2,114 場 MLB 2026-04-01~06-26;bet365 收盤=titan 變盤表末筆,台彩收盤=玩運彩結果頁=權威）
**H1 讓分**（同讓分方、|bet365線−台彩線|≥1,押 bet365 較看好側 對台彩線;線全同值場 ${sameLine} 場自然出局）
- 主檢: ${fmt(H1.all.x, H1.all.n)}，二項 vs 50% p=${zTest50(H1.all.x, H1.all.n).toFixed(3)}
- 劑量: |差|=1~2: ${fmt(H1.d1.x, H1.d1.n)}｜|差|≥2: ${fmt(H1.d2.x, H1.d2.n)}
- 穩定: 前半(4/1-5/14) ${fmt(H1.h1.x, H1.h1.n)}｜後半 ${fmt(H1.h2.x, H1.h2.n)}
- 押邊拆分: 押客 ${fmt(H1.byPick.away.x, H1.byPick.away.n)}｜押主 ${fmt(H1.byPick.home.x, H1.byPick.home.n)}

**H2 大小**（|bet365大小−台彩大小|≥0.5,往 bet365 方向押台彩線）
- 主檢: ${fmt(H2.all.x, H2.all.n)}，二項 vs 50% p=${zTest50(H2.all.x, H2.all.n).toFixed(3)}
- 劑量: |差|=0.5: ${fmt(H2.d05.x, H2.d05.n)}｜|差|≥1: ${fmt(H2.d1.x, H2.d1.n)}
- 穩定: 前半 ${fmt(H2.h1.x, H2.h1.n)}｜後半 ${fmt(H2.h2.x, H2.h2.n)}
- 押邊拆分: 押大 ${fmt(H2.byPick.over.x, H2.byPick.over.n)}｜押小 ${fmt(H2.byPick.under.x, H2.byPick.under.n)}

## ③ CLV 現況與採樣品質
- 成交線紀錄（7/8 起）: **${clvRows.length} 筆** —— 🔴 樣本不足,不做推論;逐筆: ${clvRows.map(r => `${r.date} ${r.side} 成交${r.taken} vs 收盤${r.closeVal}(${r.res || '?'})`).join('; ') || '無'}
- 收盤線採樣品質（odds_log 七月 ${q.n} 場,bet365 最後快照距開賽）: 開賽後仍有更新(grace) ${q.after} 場 / ≤30分 ${q.within30} / 30-60分 ${q.within60} / >60分 ${q.n - q.after - q.within30 - q.within60}
- **前瞻 CLV 機制已具備**: 結算視窗持續填成交線(讓分/大小)即可;NBA 板從第一天就內建 CLV 欄。
`;
fs.writeFileSync(path.join(OUT, 'REVIEW_REPORT.md'), md);
fs.writeFileSync(path.join(OUT, 'review.json'), JSON.stringify({ grid, base, mlROI, mlN: mlPicks.length, realBets: realBets.length, H1, H2, clvRows, sampling: q }, null, 1));
console.log(md);
