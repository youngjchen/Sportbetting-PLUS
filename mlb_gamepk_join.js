/* ============================================================
   玩運彩盤口 × MLB StatsAPI gamePk 對齊管線（divination-lab）
   輸入：data/playsport_totals_history.json（date/time=台北、away/home=中文隊名、totLine/hdAwayLine）
   來源：statsapi.mlb.com /api/v1/schedule（每季一請求，含春訓/例行/季後），gameDate=UTC
   對齊：中文隊名→teamId；台北時刻−8h→UTC，同對戰組合取 |Δt|≤100 分鐘最近者；
        找不到再試主客對調（flag swapped）；兩候選皆 <60 分鐘 → flag ambiguous。
   排除旗標（協議 §7，全部留痕記數）：unmatched / notFinal / spring(S) / allstar(A) /
        postseason(P另標) / sevenInning(scheduledInnings=7) / noLine / push(totalRuns==totLine)。
   紀律：本腳本產出分析用資料集與旗標「計數」，不計算任何卦象×結果統計（凍結後才允許）。
   用法：node mlb_gamepk_join.js   → data/divination_joined.json + 摘要
   ============================================================ */
'use strict';
const fs = require('fs');
const axios = require('axios');

const TEAM_ID = {
  天使: 108, 響尾蛇: 109, 金鶯: 110, 紅襪: 111, 小熊: 112, 紅人: 113, 守護者: 114, 印地安人: 114, 印第安人: 114,
  落磯: 115, 老虎: 116, 太空人: 117, 皇家: 118, 道奇: 119, 國民: 120, 大都會: 121, 運動家: 133, 海盜: 134,
  教士: 135, 水手: 136, 巨人: 137, 紅雀: 138, 光芒: 139, 遊騎兵: 140, 藍鳥: 141, 雙城: 142, 費城人: 143,
  勇士: 144, 白襪: 145, 馬林魚: 146, 洋基: 147, 釀酒人: 158,
};
const SEASONS = [[2019, '2019-02-20', '2019-11-15'], [2020, '2020-07-01', '2020-11-15'], [2021, '2021-02-25', '2021-11-15'],
  [2022, '2022-03-15', '2022-11-15'], [2023, '2023-02-22', '2023-11-15'], [2024, '2024-02-20', '2024-11-15'],
  [2025, '2025-02-18', '2025-11-15'], [2026, '2026-02-24', '2026-07-02']];

async function fetchSeason([y, s, e]) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${s}&endDate=${e}`;
  const r = await axios.get(url, { timeout: 60000 });
  const games = [];
  for (const d of r.data.dates || []) for (const g of d.games || []) {
    games.push({
      gamePk: g.gamePk, gameType: g.gameType, ts: Date.parse(g.gameDate), officialDate: g.officialDate,
      awayId: g.teams.away.team.id, homeId: g.teams.home.team.id,
      awayScore: g.teams.away.score, homeScore: g.teams.home.score,
      state: g.status && g.status.codedGameState, doubleHeader: g.doubleHeader, gameNumber: g.gameNumber,
      scheduledInnings: g.scheduledInnings,
    });
  }
  console.log(`  ${y}: schedule ${games.length} 場`);
  return games;
}

(async function main() {
  const rows = JSON.parse(fs.readFileSync('data/playsport_totals_history.json', 'utf8'));
  const all = [];
  for (const se of SEASONS) all.push(...await fetchSeason(se));
  // 索引：awayId|homeId → [games]
  const idx = {};
  for (const g of all) (idx[g.awayId + '|' + g.homeId] ||= []).push(g);

  const out = []; const cnt = { total: 0, matched: 0, swapped: 0, unmatched: 0, ambiguous: 0, notFinal: 0, byType: {}, seven: 0, push: 0, noLine: 0 };
  const unmatchedSample = [];
  for (const r of rows) {
    cnt.total++;
    const aId = TEAM_ID[r.away], hId = TEAM_ID[r.home];
    const [Y, M, D] = r.date.split('-').map(Number); const [h, mi] = (r.time || '00:00').split(':').map(Number);
    const ts = Date.UTC(Y, M - 1, D, h - 8, mi);   // 台北 → UTC
    const pickNear = (list) => {
      const c = (list || []).map(g => ({ g, dt: Math.abs(g.ts - ts) })).filter(x => x.dt <= 100 * 60000).sort((a, b) => a.dt - b.dt);
      return c;
    };
    let cand = pickNear(idx[aId + '|' + hId]), swapped = false;
    if (!cand.length) { cand = pickNear(idx[hId + '|' + aId]); swapped = cand.length > 0; }
    if (!cand.length) {
      cnt.unmatched++; if (unmatchedSample.length < 6) unmatchedSample.push(`${r.date} ${r.time} ${r.away}@${r.home}`);
      out.push({ ...r, gamePk: null, flag: 'unmatched' }); continue;
    }
    const amb = cand.length >= 2 && (cand[1].dt - cand[0].dt) < 60 * 60000;
    const g = cand[0].g;
    if (amb) cnt.ambiguous++;
    if (swapped) cnt.swapped++;
    cnt.matched++;
    cnt.byType[g.gameType] = (cnt.byType[g.gameType] || 0) + 1;
    const final = g.state === 'F';                       // codedGameState F=Final
    if (!final) cnt.notFinal++;
    const totalRuns = final && g.awayScore != null ? g.awayScore + g.homeScore : null;
    const seven = g.scheduledInnings === 7; if (seven) cnt.seven++;
    const noLine = r.totLine == null; if (noLine) cnt.noLine++;
    const push = !noLine && totalRuns != null && totalRuns === r.totLine; if (push) cnt.push++;
    out.push({
      key: r.key, date: r.date, time: r.time, away: r.away, home: r.home, totLine: r.totLine, hdAwayLine: r.hdAwayLine,
      gamePk: g.gamePk, gameType: g.gameType, gameDateUTC: new Date(g.ts).toISOString(), officialDate: g.officialDate,
      awayId: g.awayId, homeId: g.homeId, doubleHeader: g.doubleHeader, gameNumber: g.gameNumber, scheduledInnings: g.scheduledInnings,
      awayScore: final ? g.awayScore : null, homeScore: final ? g.homeScore : null, totalRuns,
      flags: { swapped, ambiguous: amb, notFinal: !final, sevenInning: seven, noLine, push },
    });
  }
  fs.writeFileSync('data/divination_joined.json', JSON.stringify(out));
  console.log('\n對齊摘要:', JSON.stringify(cnt, null, 1));
  if (unmatchedSample.length) console.log('未匹配樣例:', unmatchedSample.join(' | '));
  // 例行賽合格樣本試算（gameType=R、Final、非7局、有線、非push、非ambiguous）
  const elig = out.filter(o => o.gamePk && o.gameType === 'R' && !o.flags.notFinal && !o.flags.sevenInning && !o.flags.noLine && !o.flags.push && !o.flags.ambiguous);
  console.log(`例行賽合格樣本（大小分主檢定用）: ${elig.length}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
