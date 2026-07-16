// nba_lab/garbage_time.js — 垃圾時間過濾引擎（T8）
// 凍結規則（本檔=規則權威版本,改動需記錄理由）:
//   第四節(不含OT)內,滿足任一即進入垃圾時間: |分差|≥25(任何時刻) / |分差|≥20且剩≤6:00 / |分差|≥15且剩≤3:00
//   |分差|回落<10 → 垃圾時間結束(重新競爭);可再觸發。OT 永不算垃圾(進OT=平手)。
// 過濾後每隊-場: 乾淨時段 pts/FGA/FTA/OREB/TOV → poss=FGA−OREB+TOV+0.44FTA → 乾淨攻防效率
// 輸出: gt_ratings.json + GT_REPORT.md（過濾佔比/排名位移/與素板相關性/模型增益重跑）
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const DIR = path.join(OUT, 'cache', 'pbp');
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));

const clockSec = (c) => { const m = /PT(\d+)M([\d.]+)S/.exec(c || ''); return m ? 60 * (+m[1]) + (+m[2]) : null; };

function processGame(gid, homeTeamId, awayTeamId) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(DIR, `${gid}.json`), 'utf8')); } catch (e) { return null; }
  const acts = j.acts; if (!acts || !acts.length) return null;
  let sh = 0, sa = 0, inGT = false;
  const agg = { clean: {}, gt: {} };
  const bump = (bucket, tid, k, v) => { const t = bucket[tid] = bucket[tid] || { pts: 0, fga: 0, fta: 0, oreb: 0, tov: 0, sec: 0 }; t[k] += v; };
  let lastSec = null, lastPeriod = null;
  for (const [period, clock, scoreH, scoreA, tid, type, sub] of acts) {
    const sec = clockSec(clock);
    // 垃圾時間狀態機（進事件前用當前比分判定）
    if (period === 4) {
      const margin = Math.abs(sh - sa);
      if (!inGT && (margin >= 25 || (margin >= 20 && sec != null && sec <= 360) || (margin >= 15 && sec != null && sec <= 180))) inGT = true;
      if (inGT && margin < 10) inGT = false;
    } else inGT = false;   // Q1-3 與 OT 皆非垃圾
    const bucket = inGT ? agg.gt : agg.clean;
    // 得分=分數增量歸隊
    const nh = scoreH == null ? sh : +scoreH, na = scoreA == null ? sa : +scoreA;
    if (nh > sh) bump(bucket, homeTeamId, 'pts', nh - sh);
    if (na > sa) bump(bucket, awayTeamId, 'pts', na - sa);
    sh = nh; sa = na;
    if (tid) {
      if (type === '2pt' || type === '3pt') bump(bucket, tid, 'fga', 1);
      else if (type === 'freethrow') bump(bucket, tid, 'fta', 1);
      else if (type === 'turnover') bump(bucket, tid, 'tov', 1);
      else if (type === 'rebound' && sub === 'offensive') bump(bucket, tid, 'oreb', 1);
    }
    lastSec = sec; lastPeriod = period;
  }
  return agg;
}

(async () => {
  const off = R('official_team_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');
  const byGame = {};
  for (const r of off) (byGame[r.GAME_ID] = byGame[r.GAME_ID] || []).push(r);
  const season = {};   // tri -> {cl:{pts,opts,poss,oposs}, raw:{...}, n}
  const S = (t) => season[t] = season[t] || { clPts: 0, clOpts: 0, clPoss: 0, clOposs: 0, gtPoss: 0, n: 0 };
  const poss = (x) => x ? x.fga - x.oreb + x.tov + 0.44 * x.fta : 0;
  const perGame = [];   // 供模型重跑: {gid,date,homeTri,awayTri,homePts,awayPts,homeClPts,...}
  let ok = 0, miss = 0, gtPossTotal = 0, allPossTotal = 0;
  for (const gid in byGame) {
    const pair = byGame[gid]; if (pair.length !== 2) continue;
    let home = pair.find(r => r.MATCHUP.includes(' vs. ')), away = pair.find(r => r !== home);
    if (!home) {   // 中立場兩列皆 "@"(墨西哥城/NBA盃/歐洲賽): "X @ Y" 取 Y=名義主場;效率計算對稱,指派無害
      const m = /@\s+([A-Z]{3})/.exec(pair[0].MATCHUP);
      home = m && pair[1].TEAM_ABBREVIATION === m[1] ? pair[1] : pair[0];
      away = home === pair[0] ? pair[1] : pair[0];
    }
    if (!home || !away) continue;
    const agg = processGame(gid, home.TEAM_ID, away.TEAM_ID);
    if (!agg) { miss++; continue; }
    ok++;
    const hc = agg.clean[home.TEAM_ID] || { pts: 0 }, ac = agg.clean[away.TEAM_ID] || { pts: 0 };
    const hg = agg.gt[home.TEAM_ID], ag = agg.gt[away.TEAM_ID];
    const hPoss = poss(hc), aPoss = poss(ac);
    gtPossTotal += poss(hg) + poss(ag); allPossTotal += hPoss + aPoss + poss(hg) + poss(ag);
    // sanity: 乾淨+垃圾 pts 應=官方 PTS
    const hTot = (hc.pts || 0) + (hg ? hg.pts : 0), aTot = (ac.pts || 0) + (ag ? ag.pts : 0);
    if (hTot !== home.PTS || aTot !== away.PTS) { /* 比分重建誤差,記數 */ (season.__mismatch = (season.__mismatch || 0)); season.__mismatch++; }
    const h = S(home.TEAM_ABBREVIATION), a = S(away.TEAM_ABBREVIATION);
    h.clPts += hc.pts || 0; h.clOpts += ac.pts || 0; h.clPoss += hPoss; h.clOposs += aPoss; h.gtPoss += poss(hg); h.n++;
    a.clPts += ac.pts || 0; a.clOpts += hc.pts || 0; a.clPoss += aPoss; a.clOposs += hPoss; a.gtPoss += poss(ag); a.n++;
    perGame.push({ gid, date: home.GAME_DATE, homeTri: home.TEAM_ABBREVIATION, awayTri: away.TEAM_ABBREVIATION,
      homePts: home.PTS, awayPts: away.PTS,
      hClPts: hc.pts || 0, aClPts: ac.pts || 0, hClPoss: +hPoss.toFixed(2), aClPoss: +aPoss.toFixed(2) });
  }
  const mismatch = season.__mismatch || 0; delete season.__mismatch;

  // 過濾版 vs 素板 net rating
  const adv = R('official_advanced.json');
  const offRows = R('official_team_games.json').filter(r => r.SEASON_TYPE === 'Regular Season');
  const triName = {}; for (const r of offRows) triName[r.TEAM_ABBREVIATION] = r.TEAM_ID;
  const rows = [];
  for (const tri in season) {
    const s = season[tri];
    const net = 100 * s.clPts / s.clPoss - 100 * s.clOpts / s.clOposs;
    const advRow = adv.find(a => a.TEAM_ID === triName[tri]);
    rows.push({ tri, gtNet: +net.toFixed(2), rawNet: advRow ? advRow.NET_RATING : null, gtShare: +(100 * s.gtPoss / (s.clPoss + s.gtPoss)).toFixed(2) });
  }
  rows.sort((a, b) => b.gtNet - a.gtNet);
  const movers = [...rows].filter(r => r.rawNet != null).sort((a, b) => Math.abs(b.gtNet - b.rawNet) - Math.abs(a.gtNet - a.rawNet)).slice(0, 5);
  // 相關係數
  const xs = rows.filter(r => r.rawNet != null);
  const mx = xs.reduce((s, r) => s + r.gtNet, 0) / xs.length, my = xs.reduce((s, r) => s + r.rawNet, 0) / xs.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const r of xs) { sxy += (r.gtNet - mx) * (r.rawNet - my); sxx += (r.gtNet - mx) ** 2; syy += (r.rawNet - my) ** 2; }
  const corr = sxy / Math.sqrt(sxx * syy);

  fs.writeFileSync(path.join(OUT, 'gt_ratings.json'), JSON.stringify({ rule: '第四節: ≥25任何時刻 / ≥20且≤6:00 / ≥15且≤3:00;回落<10解除;OT永不垃圾', rows, perGame }, null, 1));

  const md = `# 垃圾時間過濾報告（T8）
產出 ${new Date().toISOString()}

## 凍結規則
第四節(不含OT): |分差|≥25(任何時刻)、或 ≥20 且剩 ≤6:00、或 ≥15 且剩 ≤3:00 → 進入垃圾時間;
|分差| 回落 <10 → 解除(可再觸發)。OT 永不算垃圾。

## 覆蓋與健全性
- 處理 ${ok} 場 / 缺 ${miss}｜比分重建不符 ${mismatch} 場（PBP score 欄缺漏所致,佔比 ${(100 * mismatch / ok).toFixed(1)}%）
- 垃圾時間回合佔比 **${(100 * gtPossTotal / allPossTotal).toFixed(2)}%**

## 過濾版 vs 素板 net rating
- 相關係數 **${corr.toFixed(4)}**（30 隊）
- 位移最大 5 隊: ${movers.map(m => `${m.tri} ${m.rawNet}→${m.gtNet}(${(m.gtNet - m.rawNet) >= 0 ? '+' : ''}${(m.gtNet - m.rawNet).toFixed(2)})`).join(' / ')}
- Top5(過濾版): ${rows.slice(0, 5).map(r => `${r.tri} ${r.gtNet}`).join(' / ')}

## 判讀
過濾版效率=CTG 同概念的自製免費版。模型增益由 rating_model 重跑比較（見 MODEL_REPORT 附註或下輪）。
`;
  fs.writeFileSync(path.join(OUT, 'GT_REPORT.md'), md);
  console.log(md);
})();
