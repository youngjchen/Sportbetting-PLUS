'use strict';
/* ============================================================
   一次性：把專案記錄過的收盤賠率補進 data/analyst_history.json 的 games[].closing（算歷史 ROI 用）
   來源（tools/closing_odds/ 的萃取程式，讀 git 歷史，不改任何資料）：
     Stake：BetExplorer 封存（oddsportal_archive 4–8 月）、oddsportal_summary／baseball_stake_odds／stake_api_odds 的 git 歷史
     bet365：Titan（odds_log 每次提交的開賽前版本）、nhl_bet365_odds／baseball_bet365_odds 的 git 歷史、bf_labeled
   規則：獨贏取最優一組（Stake 優先、A 級＝收盤或開賽前 60 分內優先，其次 B 級＝1–12 小時前）；
        ±1.5 每個讓分方向各留一組（Stake 封存常是另開盤「熱門 +1.5」，bet365 是主盤「冷門 +1.5」，兩者都是真價）。
        推薦的盤口對不到任何一組就不算 ROI（不猜價）。
   用法：node tools/analyst_odds_backfill.js <closing_multi.json> [history 路徑]
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../analyst-core.js');

const [closingPath, histArg] = process.argv.slice(2);
if (!closingPath) throw new Error('usage: node tools/analyst_odds_backfill.js <closing_multi.json> [history]');
const HIST = histArg || path.join(__dirname, '..', 'data', 'analyst_history.json');
const closing = JSON.parse(fs.readFileSync(closingPath, 'utf8'));
const text = fs.readFileSync(HIST, 'utf8');
const hist = JSON.parse(text);

let filled = 0;
for (const [id, g] of Object.entries(hist.games)) {
  const c = closing[id];
  if (!c || (!c.ml && !(c.spreads || []).length)) { delete g.closing; continue; }
  const pick = (x, extra = {}) => ({ away: x.away, home: x.home, ...extra, book: x.book, q: x.q });
  g.closing = {
    ml: c.ml ? pick(c.ml) : null,
    spreads: (c.spreads || []).map((s) => pick(s, { line: s.line, favorite: s.favorite })),
    source: 'backfill',
  };
  filled++;
}

// 對帳：補賠率不得改變任何勝負，只新增 odds／profit
const picks = hist.picks.map((p) => { const g = hist.games[p.officialId] || {}; return { date: g.date, away: g.away, home: g.home, ...p }; });
const rows = Core.buildLedger(picks, hist.games);
const settled = rows.filter((r) => r.result === 'win' || r.result === 'loss');
const out = {};
for (const lg of ['MLB', 'NHL']) {
  for (const mk of ['ML', 'SPREAD']) {
    const l = settled.filter((r) => r.league === lg && r.market === mk);
    const pr = l.filter((r) => r.odds != null);
    out[`${lg} ${mk}`] = `${pr.length}/${l.length} priced (stake ${pr.filter((r) => r.oddsBook === 'stake').length}, bet365 ${pr.filter((r) => r.oddsBook === 'bet365').length})`;
  }
  for (const a of Core.ANALYSTS) {
    const s = Core.summarize(settled.filter((r) => r.league === lg && r.analyst === a));
    if (s.priced) out[`${lg} ${a}`] = `${s.wins}-${s.losses} priced ${s.priced} profit ${s.profit.toFixed(2)} ROI ${(s.roi * 100).toFixed(1)}%`;
  }
}

// 只改 games 那一段，其餘（note、picks 排序）原樣保留
const ids = Object.keys(hist.games).sort();
const gamesBlock = `"games":{\n${ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(hist.games[id])}`).join(',\n')}\n},\n"picks"`;
const next = text.replace(/"games":\{[\s\S]*?\r?\n\},\r?\n"picks"/, gamesBlock);   // 工作目錄可能是 CRLF
if (next === text && filled) throw new Error('games block not replaced');
fs.writeFileSync(HIST, next, 'utf8');
console.log(JSON.stringify({ games: ids.length, withClosing: filled, bytes: Buffer.byteLength(next), ...out }, null, 1));
