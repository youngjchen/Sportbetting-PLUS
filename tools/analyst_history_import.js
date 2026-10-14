'use strict';
/* ============================================================
   一次性：把 C 槽 Codex 帳本的歷史推薦轉成 data/analyst_history.json（分析頁用，唯讀）
     NHL：nhl-analyst-tracking 每日 official_settlement 的主帳隊伍票（美國 9/29–10/12）＋官方賽程快照
     MLB：mlb-analyst-tracking season_team_one_vote_per_game_through_2026-10-13.csv
          （9/17 重建的正確版；舊 threads_team_picks_through_2026-08-13.csv 錯誤多、不用）
   10/13 起的推薦在 state/analyst_picks.json（頁面主帳），這裡不重複匯入。
   用法：node tools/analyst_history_import.js <輸出路徑>
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../analyst-core.js');
const { TEAM_ZH } = require('../nhl_bet365_core.js');

const OUT = process.argv[2] || path.join(__dirname, '..', 'data', 'analyst_history.json');
const CODEX = 'C:/Users/User/Documents/Codex/2026-08-15/threads-gpt-threads-2026-08-15/outputs';
const NHL = `${CODEX}/nhl-analyst-tracking`;
const MLB = `${CODEX}/mlb-analyst-tracking`;
const CUTOFF = '2026-10-12';                      // 美國比賽日；10/13 起在頁面主帳
const MLB_REGULAR_END = '2026-09-27';             // statsapi seasons/2026：例行賽結束日，之後為季後賽
const ANALYSTS = Core.ANALYSTS;
const LOTTO_TITLE = /LOTTO|PARLAY|HAIL MARY/i;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function tw(iso) {
  const d = new Date(Date.parse(iso) + 8 * 3600e3).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const split = (line) => { const out = []; let cell = ''; let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') { if (q && line[i + 1] === '"') { cell += '"'; i++; } else q = !q; } else if (c === ',' && !q) { out.push(cell); cell = ''; } else cell += c; } out.push(cell); return out; };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const c = split(l); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])); });
}

const games = {};
const picks = [];

/* ---------- NHL ---------- */
const nhlFiles = fs.readdirSync(`${NHL}/data/derived`).filter((f) => /^official_settlement_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
for (const f of nhlFiles) {
  const usDate = f.slice(20, 30);
  if (usDate > CUTOFF) continue;
  const settle = readJson(`${NHL}/data/derived/${f}`);
  const sched = readJson(`${NHL}/data/raw/nhl_schedule_${usDate}_final.json`);
  const day = sched.gameWeek.find((d) => d.date === usDate);
  const byId = new Map(day.games.map((g) => [Number(g.id), g]));
  for (const r of settle.rows || []) {
    if (r.category !== 'team' || !ANALYSTS.includes(r.analyst) || !['win', 'loss', 'push'].includes(r.result)) continue;
    const g = byId.get(Number(r.game_id));
    if (!g) throw new Error(`NHL game ${r.game_id} missing from schedule ${usDate}`);
    const away = TEAM_ZH[g.awayTeam.commonName.default]; const home = TEAM_ZH[g.homeTeam.commonName.default];
    if (!away || !home) throw new Error(`NHL team name not mapped: ${g.awayTeam.commonName.default}/${g.homeTeam.commonName.default}`);
    const t = tw(g.startTimeUTC);
    const id = `NHL_${t.date.replace(/-/g, '')}_${away}@${home}_${t.time.replace(':', '')}`;
    games[id] = { league: 'NHL', officialId: id, date: t.date, time: t.time, away, home,
      awayScore: g.awayTeam.score, homeScore: g.homeTeam.score, final: true,
      phase: g.gameType === 1 ? 'preseason' : g.gameType === 3 ? 'postseason' : 'regular', officialCheck: 'ok', usDate };
    const side = r.team === g.awayTeam.abbrev ? 'away' : r.team === g.homeTeam.abbrev ? 'home' : null;
    if (!side) throw new Error(`NHL pick team ${r.team} not in ${g.awayTeam.abbrev}@${g.homeTeam.abbrev}`);
    picks.push({ analyst: r.analyst, officialId: id, layer: LOTTO_TITLE.test(r.source_title || '') ? 'lotto' : 'card', league: 'NHL',
      date: t.date, time: t.time, away, home, side, team: side === 'away' ? away : home,
      market: r.market === 'ML' ? 'ML' : 'SPREAD', line: r.market === 'ML' ? 0 : Number(r.line),
      status: '回溯', source: `C:nhl ${f}`, expected: r.result });
  }
}

/* ---------- MLB ---------- */
const votes = parseCsv(fs.readFileSync(`${MLB}/data/derived/season_team_one_vote_per_game_through_2026-10-13.csv`, 'utf8'));
for (const v of votes) {
  if (v.us_game_date > CUTOFF || !ANALYSTS.includes(v.analyst)) continue;
  const [awayAbbr, homeAbbr] = v.matchup.replace(/\s+G\S+$/, '').split('@');   // 雙重賽寫成「TB@NYY G2」「TOR@BAL G1/G2未標」
  if (!v.gamePk) {
    // 雙重賽未標場次：帳本以「兩場結果相同」判定，照原判定保留（fixedResult），不編造比分
    const id = `MLB-DH-${v.us_game_date}-${awayAbbr}@${homeAbbr}`;
    games[id] = { league: 'MLB', officialId: id, date: v.us_game_date, time: '', away: awayAbbr, home: homeAbbr,
      phase: v.us_game_date <= MLB_REGULAR_END ? 'regular' : 'postseason', usDate: v.us_game_date, note: '雙重賽未標場次' };
    const side = v.team === awayAbbr ? 'away' : 'home';
    picks.push({ analyst: v.analyst, officialId: id, layer: 'card', league: 'MLB', date: v.us_game_date, time: '', away: awayAbbr, home: homeAbbr,
      side, team: v.team, market: v.market === 'RL' ? 'SPREAD' : 'ML', line: v.market === 'RL' ? Number(v.line) : 0,
      fixedResult: v.result, status: '回溯', source: `C:mlb season_vote ${v.source_ledger} 雙重賽未標`, expected: v.result });
    continue;
  }
  // 延賽改期沿用同一個 gamePk：原日期（退款）與改期後是兩個事件，編號要帶美國比賽日
  const id = `MLB-${v.gamePk}-${v.us_game_date}`;
  const t = tw(v.official_start_utc);
  const isVoid = v.result === 'refund';
  const g = games[id] || (games[id] = { league: 'MLB', officialId: id, date: t.date, time: t.time, away: awayAbbr, home: homeAbbr,
    phase: v.us_game_date <= MLB_REGULAR_END ? 'regular' : 'postseason', usDate: v.us_game_date });
  // 退款是「這一筆」的結論（例：延賽前發的推薦退款，同一 gamePk 改期後別人推的照算），不能標在整場
  if (!isVoid && v.away_score !== '' && v.home_score !== '') Object.assign(g, { awayScore: Number(v.away_score), homeScore: Number(v.home_score), final: true });
  const side = v.team === awayAbbr ? 'away' : v.team === homeAbbr ? 'home' : null;
  if (!side) throw new Error(`MLB vote team ${v.team} not in ${v.matchup}`);
  const spread = v.market === 'RL';
  picks.push({ analyst: v.analyst, officialId: id, layer: LOTTO_TITLE.test(v.source_title) ? 'lotto' : 'card', league: 'MLB',
    date: t.date, time: t.time, away: awayAbbr, home: homeAbbr, side, team: v.team,
    market: spread ? 'SPREAD' : 'ML', line: spread ? Number(v.line) : 0, ...(isVoid ? { fixedResult: 'refund' } : {}),
    status: '回溯', source: `C:mlb season_vote ${v.source_ledger}${v.source_grade === 'legacy_import_unverifiable_deleted_account' ? ' 無法核對' : ''}`, expected: v.result });
}

/* ---------- 對帳：每筆唯一（頁面會用 pickKey 合併）、重算結果必須等於帳本原結果 ---------- */
const merged = Core.mergePicks(picks);
if (merged.length !== picks.length) throw new Error(`${picks.length - merged.length} picks share analyst|officialId|layer and would be merged away`);
const rows = Core.buildLedger(picks, games);
const bad = rows.filter((r) => r.result !== r.expected);
if (bad.length) {
  console.error(bad.slice(0, 10).map((r) => `${r.officialId} ${r.analyst} ${r.team} ${r.market}${r.line} got ${r.result} want ${r.expected}`).join('\n'));
  throw new Error(`${bad.length} picks recompute differently from the source ledger`);
}
// 瘦身：日期／時間／隊名只存在 games；頁面載入時用 officialId 補回（status 一律「回溯」）
for (const p of picks) {
  delete p.expected; delete p.status;
  if (!p.fixedResult) { delete p.date; delete p.time; delete p.away; delete p.home; }
  p.source = p.source.startsWith('C:nhl') ? 'nhl' : p.source.includes('無法核對') ? 'mlb-unverifiable' : p.source.includes('雙重賽未標') ? 'mlb-dh-unidentified' : 'mlb';
}

const sortKey = (p) => { const g = games[p.officialId]; return `${g.date}|${p.league}|${g.time}|${p.officialId}|${ANALYSTS.indexOf(p.analyst)}`; };
const sorted = picks.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
const ids = Object.keys(games).sort();
const text = `{"version":1,"generatedAt":"${new Date().toISOString()}",`
  + `"note":"一次性匯入（唯讀）：NHL 美國 9/29–10/12＝Codex NHL 帳本主帳隊伍票；MLB 美國 4/1–10/12＝9/17 重建的每人每場一票（含串關腿；BANKROLL 8/13 前帳號已刪無法核對）。10/13 起見 state/analyst_picks.json。",`
  + `"games":{\n${ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(games[id])}`).join(',\n')}\n},\n"picks":[\n${sorted.map((p) => JSON.stringify(p)).join(',\n')}\n]}\n`;
fs.writeFileSync(OUT, text, 'utf8');
const s = (lg) => Core.summarize(rows.filter((r) => r.league === lg));
console.log(JSON.stringify({ out: OUT, bytes: Buffer.byteLength(text), games: ids.length, picks: picks.length,
  NHL: s('NHL'), MLB: s('MLB'),
  perAnalyst: Object.fromEntries(['NHL', 'MLB'].map((lg) => [lg, Object.fromEntries(ANALYSTS.map((a) => { const x = Core.summarize(rows.filter((r) => r.league === lg && r.analyst === a)); return [a, `${x.wins}-${x.losses} r${x.refunds}`]; }))])) }, null, 1));
