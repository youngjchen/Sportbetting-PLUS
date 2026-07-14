// nba_lab/roster_prior.js — 陣容先驗引擎驗證（T9,冷啟動方案）
// 假設: 大洗牌年「上季球隊評分」失效 → 改「球員帶著上季母隊品質走」:
//   25-26 開季先驗(隊) = Σ 現役球員( 24-25 上場時間權重 × 24-25 母隊 net rating ) × 覆蓋率
//   新秀/無上季資料=0 權重;覆蓋率=有上季資料的時間佔比(降低外推自信)
// 驗證: 各隊前 15 場,同模型機件,比較 先驗=0(素) vs 陣容先驗 的 Brier/acc → 過了才採用
// 用法: node nba_lab/roster_prior.js（首跑會補拉 24-25 隊伍逐場,一個請求）
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com', 'Accept': 'application/json', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true' };
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const poss = (r) => r.FGA - r.OREB + r.TOV + 0.44 * r.FTA;

(async () => {
  // 0) 24-25 隊伍逐場（缺則拉）
  const f2425 = path.join(OUT, 'official_team_games_2024_25.json');
  if (!fs.existsSync(f2425)) {
    const url = 'https://stats.nba.com/stats/leaguegamelog?Counter=3000&DateFrom=&DateTo=&Direction=ASC&LeagueID=00&PlayerOrTeam=T&Season=2024-25&SeasonType=Regular%20Season&Sorter=DATE';
    const c = new AbortController(); setTimeout(() => c.abort(), 60000);
    const r = await fetch(url, { headers: H, signal: c.signal }); const j = await r.json();
    const rs = j.resultSets[0]; const rows = rs.rowSet.map(row => { const o = {}; rs.headers.forEach((k, i) => o[k] = row[i]); return o; });
    fs.writeFileSync(f2425, JSON.stringify(rows)); console.log(`拉取 24-25 隊伍逐場 ${rows.length} rows`);
  }
  // 1) 24-25 各隊 net rating
  const tg24 = JSON.parse(fs.readFileSync(f2425, 'utf8'));
  const agg = {};
  const byG = {}; for (const r of tg24) (byG[r.GAME_ID] = byG[r.GAME_ID] || []).push(r);
  for (const gid in byG) { const p = byG[gid]; if (p.length !== 2) continue;
    for (const [me, op] of [[p[0], p[1]], [p[1], p[0]]]) { const a = agg[me.TEAM_ID] = agg[me.TEAM_ID] || { pts: 0, opts: 0, poss: 0, oposs: 0 };
      a.pts += me.PTS; a.opts += op.PTS; a.poss += poss(me); a.oposs += poss(op); } }
  const net24 = {}; for (const tid in agg) { const a = agg[tid]; net24[tid] = 100 * a.pts / a.poss - 100 * a.opts / a.oposs; }

  // 2) 球員 24-25: 總分鐘 + 母隊(分鐘最多的隊)
  const pg24 = R('official_player_games_2024_25.json').filter(r => r.SEASON_TYPE === 'Regular Season');
  const pl24 = {};
  for (const r of pg24) { const p = pl24[r.PLAYER_ID] = pl24[r.PLAYER_ID] || { min: 0, teams: {} };
    const m = typeof r.MIN === 'number' ? r.MIN : parseFloat(r.MIN) || 0;
    p.min += m; p.teams[r.TEAM_ID] = (p.teams[r.TEAM_ID] || 0) + m; }
  for (const pid in pl24) { const p = pl24[pid]; p.mainTeam = Object.keys(p.teams).sort((a, b) => p.teams[b] - p.teams[a])[0]; }

  // 3) 25-26 開季名單=各隊前5場出賽者;先驗=Σ w_i × net24[母隊] × 覆蓋率
  const pg25 = R('official_player_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');
  pg25.sort((a, b) => a.GAME_DATE < b.GAME_DATE ? -1 : 1);
  const teamGames25 = {};   // tri -> [gid...] 順序
  const rosterMin = {};     // tri -> {pid: 前5場已見}
  for (const r of pg25) { const t = teamGames25[r.TEAM_ABBREVIATION] = teamGames25[r.TEAM_ABBREVIATION] || [];
    if (!t.includes(r.GAME_ID)) t.push(r.GAME_ID);
    if (t.indexOf(r.GAME_ID) < 5) { (rosterMin[r.TEAM_ABBREVIATION] = rosterMin[r.TEAM_ABBREVIATION] || new Set()).add(r.PLAYER_ID); } }
  const prior = {};
  for (const tri in rosterMin) {
    let wSum = 0, val = 0, covered = 0, total = 0;
    for (const pid of rosterMin[tri]) { const p = pl24[pid]; total++;
      if (p && p.min >= 200) { const w = p.min; wSum += w; val += w * (net24[p.mainTeam] || 0); covered++; } }
    const coverage = total ? covered / total : 0;
    prior[tri] = wSum ? (val / wSum) * coverage : 0;
  }

  // 4) 驗證: walk-forward,先驗進收縮目標 rating=(N0*prior + n*current)/(N0+n),只評各隊前15場
  const { perGame } = R('gt_ratings.json');   // 乾淨版逐場(T8 已證較優)
  perGame.sort((a, b) => a.date < b.date ? -1 : 1);
  const HFA = 2.5, SIGMA = 14;
  function run(usePrior, N0) {
    const st = {}; const S = (t) => st[t] = st[t] || { pts: 0, opts: 0, poss: 0, oposs: 0, n: 0 };
    const preds = [];
    for (const g of perGame) {
      const h = S(g.homeTri), a = S(g.awayTri);
      const net = (x, tri) => { const cur = x.n === 0 ? 0 : 100 * x.pts / x.poss - 100 * x.opts / x.oposs;
        const pr = usePrior ? (prior[tri] || 0) : 0;
        return (N0 * pr + x.n * cur) / (N0 + x.n); };
      const pace = (x) => x.n === 0 ? 99 : (x.poss + x.oposs) / (2 * x.n);
      const margin = (net(h, g.homeTri) - net(a, g.awayTri)) * ((pace(h) + pace(a)) / 2) / 100 + HFA;
      const p = 0.5 * (1 + erf(margin / (SIGMA * Math.SQRT2)));
      preds.push({ p, actual: g.homePts - g.awayPts, early: Math.min(h.n, a.n) < 15 });
      h.pts += g.hClPts; h.opts += g.aClPts; h.poss += g.hClPoss; h.oposs += g.aClPoss; h.n++;
      a.pts += g.aClPts; a.opts += g.hClPts; a.poss += g.aClPoss; a.oposs += g.hClPoss; a.n++;
    }
    return preds.filter(p => p.early);
  }
  const evalP = (preds) => { let b = 0, acc = 0, n = 0; for (const p of preds) { const y = p.actual > 0 ? 1 : 0; b += (p.p - y) ** 2; acc += ((p.p > 0.5) === (y === 1)) ? 1 : 0; n++; } return { brier: +(b / n).toFixed(4), acc: +(100 * acc / n).toFixed(1), n }; };
  const out = { priorSample: Object.entries(prior).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${t}:${v.toFixed(1)}`).join(' ') };
  for (const N0 of [5, 10, 15]) out[`N0=${N0}`] = { 素板: evalP(run(false, N0)), 陣容先驗: evalP(run(true, N0)) };
  fs.writeFileSync(path.join(OUT, 'roster_prior_eval.json'), JSON.stringify({ prior, out }, null, 1));
  console.log('開季先驗(高→低):', out.priorSample);
  for (const N0 of [5, 10, 15]) console.log(`N0=${N0} 素板 acc ${out[`N0=${N0}`].素板.acc}% Brier ${out[`N0=${N0}`].素板.brier} | 陣容先驗 acc ${out[`N0=${N0}`].陣容先驗.acc}% Brier ${out[`N0=${N0}`].陣容先驗.brier} (前15場 n=${out[`N0=${N0}`].素板.n})`);
})();
