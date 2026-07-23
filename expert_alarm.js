// ============================================================
// expert_alarm.js — 智慧鬧鐘：讀當日賽程，算「下一個抓取波」
// CLI：node expert_alarm.js --league=kbo [--after=ISO上一波時刻]
// stdout 一行 JSON：{"sleepSec":N,"mode":"full|final|skip","deep":0|1,"label":"..."}
// 設計（2026-07-23 使用者拍板）：
//  · 每簇（開賽時間 ±60 分聚類）：T-120 全量、T-35 快抓（final 語義）
//  · 保底 full：npb 12/15/18、kbo 12:30/15:30/18:30、cpbl 13/16、mlb 22/0/2/4（台灣時間）
//  · 深掃（EP_DEEP 全名冊）：npb 03:40、kbo 04:00、cpbl 04:20、mlb 06:00；深掃不受無賽日規則影響
//  · 無賽日規則：該保底時點往後 24h 內沒有任何比賽 → 跳過該保底
//  · 錯過補償：目標已過 ≤25 分且晚於上一波、未晚於開賽+10 分 → sleepSec=0 立刻抓
//  · sleep 上限 900 秒＝每 15 分重讀賽程（改賽/加賽自動吸收）
// ============================================================
const fs = require('fs');
const TZ8 = 8 * 3600e3;
const BASELINES = {
  npb:  { hot: [[12,0],[15,0],[18,0]], deep: [3,40] },
  kbo:  { hot: [[12,30],[15,30],[18,30]], deep: [4,0] },
  cpbl: { hot: [[13,0],[16,0]], deep: [4,20] },
  mlb:  { hot: [[22,0],[0,0],[2,0],[4,0]], deep: [6,0] },
};
const PFX = { npb:'NPB', kbo:'KBO', cpbl:'CPBL', mlb:'MLB' };
const CLUSTER_MIN = 60, T_FULL_MIN = 120, T_FINAL_MIN = 35, LATE_OK_MIN = 35, DEDUP_MIN = 20, MAX_SLEEP = 900;
const SUBGROUP_MIN = 20, LOOKBACK_MIN = 45;

function twDayStartMs(nowMs) { const d = new Date(nowMs + TZ8); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TZ8; }
function loadGames(lg, nowMs) {
  let arr = [];
  try { const j = JSON.parse(fs.readFileSync('data/pregame_data.json', 'utf8')); arr = Array.isArray(j) ? j : Object.values(j); } catch (_) { return []; }
  const out = [];
  for (const g of arr) {
    const id = (g && g.officialId) || '';
    const m = id.match(new RegExp('^' + PFX[lg] + '_(\\d{8})_.+_(\\d{2})(\\d{2})$'));
    if (!m) continue;
    const [, ymd, hh, mm] = m;
    const startMs = Date.UTC(+ymd.slice(0,4), +ymd.slice(4,6)-1, +ymd.slice(6,8), +hh-8, +mm);
    if (startMs > nowMs - LOOKBACK_MIN * 60e3 && startMs < nowMs + 30 * 3600e3) out.push({ startMs });
  }
  return out;
}
function clusterGames(games) {
  const s = [...games].sort((a,b) => a.startMs - b.startMs), out = [];
  for (const g of s) {
    const c = out[out.length-1];
    if (c && g.startMs - c.lastMs <= CLUSTER_MIN * 60e3) { c.lastMs = g.startMs; }
    else out.push({ firstMs: g.startMs, lastMs: g.startMs });
  }
  return out;
}
function targetsFor(lg, games, nowMs) {
  const t = [];
  for (const c of clusterGames(games)) {
    t.push({ atMs: c.firstMs - T_FULL_MIN*60e3, mode:'full', deep:0, gameMs:c.firstMs, label:'簇T-120' });
    // 快抓波按 20 分鐘子群逐波：寬簇裡每批開賽時間都有自己的 T-35（保 T-20 紅線）
    const starts = [...new Set(games.filter(g => g.startMs >= c.firstMs && g.startMs <= c.lastMs).map(g => g.startMs))].sort((a,b)=>a-b);
    let anchor = null;
    for (const s of starts) {
      if (anchor === null || s - anchor > SUBGROUP_MIN*60e3) {
        anchor = s;
        t.push({ atMs: s - T_FINAL_MIN*60e3, mode:'final', deep:0, gameMs:s, label:'簇T-35' });
      }
    }
  }
  const day0 = twDayStartMs(nowMs);
  for (const d of [0, 1]) {
    for (const [h,m] of BASELINES[lg].hot) {
      const atMs = day0 + d*86400e3 + (h*60+m)*60e3;
      if (!games.some(g => g.startMs > atMs && g.startMs - atMs < 24*3600e3)) continue;  // 無賽日規則
      t.push({ atMs, mode:'full', deep:0, gameMs:Infinity, label:'保底' });
    }
    const [dh,dm] = BASELINES[lg].deep;
    t.push({ atMs: day0 + d*86400e3 + (dh*60+dm)*60e3, mode:'full', deep:1, gameMs:Infinity, label:'深掃' });
  }
  // 去重（2026-07-24 修正）：只在 full 系(含深掃)之間去重；final 波絕不被吸收——
  // 反例：MLB 00:30 場的 T-35=23:55 若被 00:00 保底 full 吃掉，full 要跑 12~15 分，
  // 資料落地 T-15 踩爆「最慢 T-20 上板」紅線；final 便宜(3~6分)，同刻撞上就連跑兩波。
  // 同為 full 相撞＝合併標籤（保底+簇T-120），深掃 rank 較高留深掃。
  const rank = x => x.deep ? 2 : 1;
  t.sort((a,b) => a.atMs - b.atMs);
  const out = [];
  for (const x of t) {
    const p = out[out.length-1];
    if (p && x.atMs - p.atMs < DEDUP_MIN*60e3 && x.mode === 'full' && p.mode === 'full') {
      if (rank(x) > rank(p)) { x.label = p.label + '+' + x.label; out[out.length-1] = x; }
      else { p.label += '+' + x.label; }
    }
    else out.push(x);
  }
  return out;
}
function computeNextWave(lg, games, nowMs, afterMs) {
  const ts = targetsFor(lg, games, nowMs);
  const missed = ts.filter(x => x.atMs <= nowMs && nowMs - x.atMs <= LATE_OK_MIN*60e3 && x.atMs > (afterMs||0)
    && (x.gameMs === Infinity || nowMs <= x.gameMs + 10*60e3)).pop();
  if (missed) {
    const late = nowMs - missed.atMs > 60e3;
    return { sleepSec: 0, mode: missed.mode, deep: missed.deep, label: missed.label + (late ? '(補償)' : '') };
  }
  const next = ts.find(x => x.atMs > nowMs);
  if (!next) return { sleepSec: MAX_SLEEP, mode: 'skip', deep: 0, label: '無目標' };
  const sec = Math.round((next.atMs - nowMs) / 1000);
  if (sec > MAX_SLEEP) return { sleepSec: MAX_SLEEP, mode: 'skip', deep: 0, label: '等 ' + next.label };
  return { sleepSec: sec, mode: next.mode, deep: next.deep, label: next.label };
}
if (require.main === module) {
  const arg = k => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : ''; };
  const lg = arg('league'); const afterMs = arg('after') ? Date.parse(arg('after')) : 0;
  if (!BASELINES[lg]) { console.log(JSON.stringify({ sleepSec: 600, mode: 'skip', deep: 0, label: '未知聯盟' })); process.exit(0); }
  const nowMs = Date.now();
  const w = computeNextWave(lg, loadGames(lg, nowMs), nowMs, afterMs);
  console.log(JSON.stringify(w));
}
module.exports = { computeNextWave, clusterGames, targetsFor, loadGames, BASELINES };
