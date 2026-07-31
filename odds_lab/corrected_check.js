/* odds_lab/corrected_check.js — 修正語意後的讓分走向重算（2026-07-31 資料品質稽核產物）
   稽核發現（三重證據，詳 AUDIT_2026-07-31.md）：
   ① odds_log 的 hd/ou 序列是「新→舊」存放：parseHistoryTable 無 reverse（唯一的 reverse 在
      parseHistoryTableTs=intl_state 專用，註明「由舊到新」＝titan 原表新在上）。
   ② 該解析不看第4欄「变化时间」→ 不濾走地；開賽後 grace 窗的再抓會把走地列灌進表頭。
      證據：|線|≥2.5 的極端值 83:1 全集中在 s[0] 端；bet365 棒球賽前主線幾乎恆為 ±1.5
      （被誤當「收盤」的真開盤 901/902 = 1.5）。
   ③ s[0] 極端線方向 vs 最終勝方一致率 73.5% ＝ 會洩漏比賽結果的訊號混在「開盤」端。
   → 原 analyze.js/forward_check.js 的 hd/ou 全部格子語意錯誤，讓分「反向」+9.8%/+12.0% 撤回。

   本檔的修正：
   - 先把每場序列反轉成「舊→新」（真時序）。
   - 從時序尾端起，遇到第一筆 |line|≥2 即視為進入走地，該筆與其後全部截斷
     （bet365 棒球賽前主線 a.s.=±1.5；≥2 必為走地）。
   - ‼️ 殘餘風險（無法從 odds_log 消除）：走地初期線仍停在 ±1.5 的列無時戳可辨，
     可能殘留在「收盤」端 → 本檔結果只能當方向參考，正式重測須改用帶時戳的抓取。
   用法：node odds_lab/corrected_check.js */
'use strict';
const path = require('path');
const LOG = require(path.join(__dirname, '..', 'data', 'odds_log.json'));
const DS = require(path.join(__dirname, 'dataset.json'));

const IS_FROM = '2026-06-17', IS_TO = '2026-07-20';
const OOS_FROM = '2026-07-21', OOS_TO = '2026-07-31';

// 正=主讓（與稽核前相同的符號校準，符號語意不受列序影響）
const normLine = L => -L;                       // 正規化成 負=主讓
const num = x => { const v = parseFloat(x); return isNaN(v) ? null : v; };

function cleanSeries(id) {
  const s = LOG.matches[id] && LOG.matches[id].hd && LOG.matches[id].hd.bet365;
  if (!Array.isArray(s) || s.length < 2) return null;
  const chron = s.slice().reverse();            // 舊→新
  let cut = chron.length;
  for (let i = 0; i < chron.length; i++) {
    const L = num(chron[i].line);
    if (L == null || Math.abs(L) >= 2) { cut = i; break; }   // 首筆疑似走地起全部截斷
  }
  const pre = chron.slice(0, cut);
  return pre.length >= 2 ? { pre, dropped: chron.length - pre.length } : null;
}

function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}
const pct = x => (100 * x).toFixed(1) + '%';
const mkCell = () => ({ n: 0, k: 0, roi: 0, odds: [] });
function addHit(c, ok, odds) { c.n++; if (ok) c.k++; if (odds != null) { c.odds.push(odds); c.roi += ok ? odds : -1; } }
function fmt(c) {
  if (!c.n) return '（無樣本）';
  const p = c.k / c.n, [lo, hi] = wilson(c.k, c.n);
  const avg = c.odds.length ? c.odds.reduce((s, x) => s + x, 0) / c.odds.length : null;
  const be = avg != null ? 1 / (1 + avg) : null;
  const roi = c.odds.length ? c.roi / c.n : null;
  let z = null;
  if (be != null && c.n >= 10) z = (p - be) / Math.sqrt(be * (1 - be) / c.n);
  return `${c.k}/${c.n}  ${pct(p)} [${pct(lo)},${pct(hi)}]  兩平${be != null ? pct(be) : '—'}  ROI ${roi != null ? (100 * roi).toFixed(1) + '%' : '—'}${z != null ? '  z=' + z.toFixed(2) : ''}`;
}

let contaminated = 0, usable = 0, tooShort = 0;
function runWindow(from, to) {
  const T = { fadeAll: mkCell(), fadeFlip: mkCell(), fadeOddsOnly: mkCell(), followAll: mkCell(),
              fadeMlb: mkCell(), fadeNpb: mkCell(), fadeKbo: mkCell(), fadeCpbl: mkCell() };
  for (const r of DS.rows) {
    if (!r.res || r.date < from || r.date > to) continue;
    const cs = cleanSeries(r.id);
    if (!cs) continue;
    const f = cs.pre[0], l = cs.pre[cs.pre.length - 1];       // 真開盤 → 賽前最後一筆
    const oL = num(f.line), cL = num(l.line);
    if (oL == null || cL == null) continue;
    const lm = normLine(cL) - normLine(oL);
    let side = null;
    if (lm !== 0) side = lm < 0 ? 'home' : 'away';
    else {
      const om = (num(l.home) != null && num(f.home) != null) ? num(l.home) - num(f.home) : null;
      if (om != null && om !== 0) side = om < 0 ? 'home' : 'away';
    }
    if (!side) continue;
    const margin = (r.res.hs - r.res.as) + normLine(cL);
    if (margin === 0) continue;
    const cov = margin > 0;
    const okFollow = side === 'home' ? cov : !cov;
    const fadeOdds = side === 'home' ? num(l.away) : num(l.home);
    const followOdds = side === 'home' ? num(l.home) : num(l.away);
    addHit(T.fadeAll, !okFollow, fadeOdds);
    addHit(T.followAll, okFollow, followOdds);
    addHit(lm !== 0 ? T.fadeFlip : T.fadeOddsOnly, !okFollow, fadeOdds);
    const lg = { mlb: T.fadeMlb, npb: T.fadeNpb, kbo: T.fadeKbo, cpbl: T.fadeCpbl }[r.league];
    if (lg) addHit(lg, !okFollow, fadeOdds);
  }
  return T;
}

// 污染面盤點
for (const r of DS.rows) {
  if (!r.hd) continue;
  const s = LOG.matches[r.id] && LOG.matches[r.id].hd && LOG.matches[r.id].hd.bet365;
  if (!Array.isArray(s) || s.length < 2) continue;
  const hasLive = s.some(t => Math.abs(num(t.line) || 0) >= 2);
  if (hasLive) contaminated++;
  const cs = cleanSeries(r.id);
  if (cs) usable++; else tooShort++;
}
console.log('════════ 修正語意後的讓分走向重算（走地截斷；殘餘 ±1.5 走地風險仍在） ════════');
console.log(`有hd序列的場：${DS.rows.filter(r => r.hd).length}；含明確走地列（|線|≥2）的：${contaminated}；清洗後可用：${usable}；清洗後不足2筆：${tooShort}`);
console.log('');
const IS = runWindow(IS_FROM, IS_TO), OOS = runWindow(OOS_FROM, OOS_TO);
const P = (label, k) => { console.log('◆ ' + label); console.log('   in-sample  ' + fmt(IS[k])); console.log('   樣本外     ' + fmt(OOS[k])); };
P('反向全體（修正後真語意：吃被推走側 @賽前最後價）', 'fadeAll');
P('反向・線有動（賽前真實換邊/移動）', 'fadeFlip');
P('反向・只賠率動', 'fadeOddsOnly');
P('反向・MLB', 'fadeMlb');
P('反向・NPB', 'fadeNpb');
P('反向・KBO', 'fadeKbo');
P('反向・CPBL', 'fadeCpbl');
P('（鏡像）順向全體', 'followAll');
