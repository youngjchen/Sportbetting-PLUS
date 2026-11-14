'use strict';
/* ============================================================
   分析師推薦自動結算（analyst-settle.yml 每 30 分＋推薦檔更新時跑）
   讀：state/analyst_picks.json（頁面寫）、賽程滾動檔、Stake 賠率檔
   寫：data/analyst_results.json（只有本程式寫）——每場永久保存比分、賽季階段、Stake 收盤賠率。
   為什麼要另存：賽程／賠率檔只留最近幾天，沒結算到的比賽會從檔案消失。
   官方核對：NHL（api-web.nhle.com）、MLB（statsapi.mlb.com）比分不一致 → 標 review、不結算；
            官方連不上不擋結算（officialCheck 記 unavailable）。NBA 無官方源，只用玩運彩比分。
   今天押什麼存檔（2026-11-15）：每輪替「還沒開賽、有推薦」的場跑一次 analyst-advice.js 的判斷，寫進該場的 advice；
   開賽後就不再改（＝開賽前 15 分內的最後判斷），頁面拿它算「系統戰績」。用預設設定：主跟 BOOKIE（NBA 不設）、忽略 BANKROLL；
   伺服器沒有冰球頁的手動異常標記。這段失敗不影響結算。
   ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('./analyst-core.js');
const NhlStake = require('./nhl_stake_core.js');
const NhlBet365 = require('./nhl_bet365_core.js');
const Advice = require('./analyst-advice.js');
const { TEAM_ZH: NHL_TEAM_ZH } = NhlBet365;

const ROOT = __dirname;
const PICKS = 'state/analyst_picks.json';
const RESULTS = 'data/analyst_results.json';
const SRC = {
  NHL: { pregame: 'data/nhl_pregame.json', stake: 'data/stake_api_odds.json', b365: 'data/nhl_bet365_odds.json' },
  MLB: { pregame: 'data/pregame_data.json', stake: 'data/baseball_stake_odds.json' },
  NBA: { pregame: 'data/nba_pregame.json', stake: 'data/nba_stake_odds.json' },
};
// NBA 2026-27 例行賽：美東 2026-10-20 15:00（BOS@DET）開幕；之前一律季前賽。
const NBA_REGULAR_START_MS = Date.parse('2026-10-20T04:00:00Z');
const MLB_ABBR_ALIAS = { AZ: 'ARI', CHW: 'CWS', WSN: 'WSH', KCR: 'KC', SDP: 'SD', SFG: 'SF', TBR: 'TB', ATH: 'OAK' };
const MISSING_AFTER_MS = 3 * 24 * 3600e3;
const HISTORY = 'data/analyst_history.json';
const ADVICE_IGNORE = ['BANKROLL'];
const DEFAULT_PHASES = ['regular', 'postseason', null];

function readJson(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (e) { return fallback; }
}
function startMs(g) { return Date.parse(`${g.date}T${String(g.time || '00:00').padStart(5, '0')}:00+08:00`); }
function addDays(date, n) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// 與 analysts.html 相同的賽程正規化（聯盟、台灣日期、中文隊名）
function normalizeGames(league, feed) {
  const list = Array.isArray(feed) ? feed : (feed && feed.games) || [];
  const out = new Map();
  for (const g of list) {
    if (g.league && g.league !== league) continue;
    const away = g.away || g.awayTeam; const home = g.home || g.homeTeam;
    if (!g.officialId || !away || !home) continue;
    const row = { league, officialId: g.officialId, date: g.date, time: g.time, away, home,
      awayAbbr: g.awayAbbr || null, homeAbbr: g.homeAbbr || null,
      awayScore: g.awayScore, homeScore: g.homeScore, finished: g.status === 'finished' };
    row.startMs = startMs(row);
    out.set(row.officialId, row);
  }
  return out;
}

// Stake 收盤：只收開賽前的價（at／observedAt 早於開賽），格式同 analyst-core.priceFrom
function stakeClosing(league, g, feed) {
  if (!feed) return null;
  const before = (at) => at && Date.parse(at) < g.startMs;
  if (league === 'NHL') {
    const hit = NhlStake.findStakeGame(feed, { date: g.date, time: g.time, away: g.away, home: g.home });
    if (!hit) return null;
    const ml = hit.ml && before(hit.ml.at) ? { away: hit.ml.away, home: hit.ml.home } : null;
    const spread = hit.hd && before(hit.hd.at) ? { line: hit.hd.line, favorite: hit.hd.favorite, away: hit.hd.away, home: hit.hd.home } : null;
    return ml || spread ? { ml, spread, at: (hit.hd && hit.hd.at) || (hit.ml && hit.ml.at), source: 'stake' } : null;
  }
  let m = null;
  if (league === 'MLB') m = feed.matches && feed.matches[g.officialId];
  else {
    const list = Array.isArray(feed.matches) ? feed.matches : Object.values(feed.matches || {});
    m = list.filter((x) => x.away === g.away && x.home === g.home && Math.abs(Date.parse(x.scheduledStart) - g.startMs) < 12 * 3600e3)
      .sort((a, b) => Math.abs(Date.parse(a.scheduledStart) - g.startMs) - Math.abs(Date.parse(b.scheduledStart) - g.startMs))[0];
  }
  if (!m || !before(m.observedAt)) return null;
  const line = league === 'MLB' ? m.canonicalLine : m.line;
  return {
    ml: m.moneyline || null,
    spread: m.handicapOdds && line != null ? { line, favorite: m.favorite, away: m.handicapOdds.away, home: m.handicapOdds.home } : null,
    at: m.observedAt, source: 'stake',
  };
}

/* ---------- 官方核對 ---------- */
async function fetchJson(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 analyst-settle' }, signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}
function nhlZh(team) { return NHL_TEAM_ZH[team && team.commonName && team.commonName.default] || null; }
function mlbAbbr(a) { return MLB_ABBR_ALIAS[a] || a; }

// 回傳 { status: 'ok'|'mismatch'|'unavailable', phase, detail }
function compareOfficial(league, g, official) {
  if (!official) return { status: 'unavailable', phase: null };
  const sameScore = Number(official.awayScore) === Number(g.awayScore) && Number(official.homeScore) === Number(g.homeScore);
  if (!official.final) return { status: 'unavailable', phase: official.phase, detail: 'official not final yet' };
  return sameScore
    ? { status: 'ok', phase: official.phase }
    : { status: 'mismatch', phase: official.phase, detail: `official ${official.awayScore}-${official.homeScore} vs feed ${g.awayScore}-${g.homeScore}` };
}
function nhlOfficialFrom(schedules, g) {
  for (const s of schedules) {
    for (const day of (s && s.gameWeek) || []) {
      for (const x of day.games || []) {
        if (nhlZh(x.awayTeam) === g.away && nhlZh(x.homeTeam) === g.home && Math.abs(Date.parse(x.startTimeUTC) - g.startMs) < 12 * 3600e3) {
          return { awayScore: x.awayTeam.score, homeScore: x.homeTeam.score, final: ['OFF', 'FINAL'].includes(x.gameState),
            phase: x.gameType === 1 ? 'preseason' : x.gameType === 3 ? 'postseason' : 'regular', id: x.id };
        }
      }
    }
  }
  return null;
}
function mlbOfficialFrom(schedules, g) {
  for (const s of schedules) {
    for (const day of (s && s.dates) || []) {
      for (const x of day.games || []) {
        const a = mlbAbbr(x.teams.away.team.abbreviation); const h = mlbAbbr(x.teams.home.team.abbreviation);
        if (a === mlbAbbr(g.awayAbbr) && h === mlbAbbr(g.homeAbbr) && Math.abs(Date.parse(x.gameDate) - g.startMs) < 12 * 3600e3) {
          const gt = x.gameType;
          return { awayScore: x.teams.away.score, homeScore: x.teams.home.score, final: x.status.detailedState === 'Final' || x.status.detailedState === 'Game Over',
            phase: gt === 'R' ? 'regular' : ['S', 'E'].includes(gt) ? 'preseason' : 'postseason', id: x.gamePk };
        }
      }
    }
  }
  return null;
}
async function officialFor(league, g, cache) {
  if (league === 'NBA') return null;
  const dates = [addDays(g.date, -1), g.date];   // 台灣日期 → 美國比賽日可能早一天
  const key = `${league}|${dates.join(',')}`;
  if (!cache.has(key)) {
    const urls = dates.map((d) => (league === 'NHL'
      ? `https://api-web.nhle.com/v1/schedule/${d}`
      : `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${d}&hydrate=team`));
    cache.set(key, Promise.all(urls.map(fetchJson)));
  }
  const schedules = await cache.get(key);
  return league === 'NHL' ? nhlOfficialFrom(schedules, g) : mlbOfficialFrom(schedules, g);
}

/* ---------- 主流程（純資料進出，方便測試） ---------- */
async function settle({ picks, results, schedule, stake, now = Date.now(), official = officialFor }) {
  const out = { version: 1, games: { ...(results && results.games) } };
  const cache = new Map();
  const live = Core.livePicks(picks);
  const ids = [...new Set(live.map((p) => p.officialId))];
  let changed = 0;
  for (const id of ids) {
    const p = live.find((x) => x.officialId === id);
    const league = p.league;
    const prev = out.games[id];
    if (prev && prev.final && prev.closing !== undefined) continue;
    const g = schedule[league] && schedule[league].get(id);
    const base = g || { league, officialId: id, date: p.date, time: p.time, away: p.away, home: p.home };
    if (!base.startMs) base.startMs = startMs(base);
    const entry = { ...(prev || {}), league, officialId: id, date: base.date, time: base.time, away: base.away, home: base.home };
    if (entry.closing === undefined && now >= base.startMs) entry.closing = stakeClosing(league, base, stake[league]) || null;
    if (g && g.finished) {
      const check = compareOfficial(league, g, await official(league, g, cache));
      entry.officialCheck = check.status;
      entry.awayScore = Number(g.awayScore); entry.homeScore = Number(g.homeScore);
      entry.phase = league === 'NBA' ? (g.startMs >= NBA_REGULAR_START_MS ? 'regular' : 'preseason') : (check.phase || entry.phase || null);
      if (check.status === 'mismatch') { entry.final = false; entry.review = check.detail; }
      else { entry.final = true; delete entry.review; entry.settledAt = entry.settledAt || new Date(now).toISOString(); }
    } else if (!g && !entry.final && now - base.startMs > MISSING_AFTER_MS) {
      entry.review = '賽程檔已無此場，尚未取得比分';
    }
    if (JSON.stringify(entry) !== JSON.stringify(prev)) { out.games[id] = entry; changed++; }
  }
  return { results: out, changed };
}

/* ---------- 今天押什麼存檔 ---------- */
// 回傳 { games: { officialId: advice }, count }；只處理還沒開賽的場
function adviceSnapshots({ picks, results, schedule, feeds, history, now = Date.now() }) {
  const live = Core.livePicks(picks);
  const H = history || { games: {}, picks: [] };
  const histPicks = (H.picks || []).map((p) => { const g = (H.games || {})[p.officialId] || {}; return Object.assign({ date: g.date, time: g.time, away: g.away, home: g.home, status: '回溯' }, p); });
  const games = Object.assign({}, H.games || {});
  for (const [id, r] of Object.entries((results && results.games) || {})) games[id] = Object.assign({}, games[id] || {}, r, r.review ? { final: false } : {});
  const ledger = Core.buildLedger(Core.mergePicks(histPicks, live), games);
  const ctxCache = new Map();
  const ctxFor = (league, date) => {
    const k = `${league}|${date}`;
    if (!ctxCache.has(k)) {
      const rows = Core.filterRows(ledger, { league, phases: DEFAULT_PHASES, to: addDays(date, -1) })
        .filter((r) => !Core.WATCH.includes(r.analyst) && !ADVICE_IGNORE.includes(r.analyst));
      const ann = Core.annotateContexts(rows);
      ctxCache.set(k, { ann, spotRec: league === 'NHL' ? Core.spotRecord(ann, games) : null });
    }
    return ctxCache.get(k);
  };
  const deps = { Core, NhlStake, NhlBet365 };
  const at = new Date(now).toISOString();
  const out = {};
  for (const id of new Set(live.map((p) => p.officialId))) {
    const p0 = live.find((p) => p.officialId === id);
    const g = schedule[p0.league] && schedule[p0.league].get(id);
    if (!g || !(now < g.startMs)) continue;                                        // 只在開賽前判斷
    if (g.league === 'NBA' && g.startMs < NBA_REGULAR_START_MS) continue;          // NBA 季前賽不判斷
    const all = Core.ANALYSTS.map((a) => {
      const mine = live.filter((p) => p.officialId === id && p.analyst === a);
      return mine.find((p) => p.layer === 'card') || mine.find((p) => p.layer === 'lotto') || null;
    }).filter(Boolean);
    if (!all.length) continue;
    const dec = Advice.decide({ g, all, ignored: (a) => ADVICE_IGNORE.includes(a), core: g.league === 'NBA' ? null : 'BOOKIE',
      L: ctxFor(g.league, g.date), feeds, docs: null, deps });
    out[id] = Advice.freeze(dec, at);
  }
  return out;
}

function serialize(results) {
  const ids = Object.keys(results.games).sort((a, b) => {
    const x = results.games[a]; const y = results.games[b];
    return `${x.date}|${x.time}|${a}` < `${y.date}|${y.time}|${b}` ? -1 : 1;
  });
  return `{"version":1,"updatedAt":"${new Date().toISOString()}","games":{\n${ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(results.games[id])}`).join(',\n')}\n}}\n`;
}

async function main() {
  const picksDoc = readJson(PICKS, null);
  if (!picksDoc || !Array.isArray(picksDoc.picks)) { console.log('INFO 尚無推薦檔，跳過'); return; }
  const schedule = {}; const stake = {};
  for (const lg of Object.keys(SRC)) { schedule[lg] = normalizeGames(lg, readJson(SRC[lg].pregame, [])); stake[lg] = readJson(SRC[lg].stake, null); }
  const settled = await settle({ picks: picksDoc.picks, results: readJson(RESULTS, { games: {} }), schedule, stake });
  const { results } = settled; let { changed } = settled;
  try {
    const feeds = { NHL: { stake: stake.NHL, b365: readJson(SRC.NHL.b365, null) }, MLB: { stake: stake.MLB }, NBA: { stake: stake.NBA } };
    const snaps = adviceSnapshots({ picks: picksDoc.picks, results, schedule, feeds, history: readJson(HISTORY, null) });
    let n = 0;
    for (const [id, adv] of Object.entries(snaps)) {
      const p = picksDoc.picks.find((x) => x.officialId === id) || {};
      const prev = results.games[id] || { league: p.league, officialId: id, date: p.date, time: p.time, away: p.away, home: p.home };
      if (Advice.sameAdvice(prev.advice, adv)) continue;
      results.games[id] = Object.assign({}, prev, { advice: adv }); n++;
    }
    if (n) console.log(`OK 今天押什麼存檔 ${n} 場`);
    changed += n;
  } catch (e) { console.log(`WARN 今天押什麼存檔失敗（不影響結算）：${e && e.message}`); }
  if (!changed) { console.log('INFO 沒有新結果'); return; }
  fs.writeFileSync(path.join(ROOT, RESULTS), serialize(results), 'utf8');
  const g = Object.values(results.games);
  console.log(`OK 更新 ${changed} 場；累計 ${g.length} 場，完賽 ${g.filter((x) => x.final).length}，待核對 ${g.filter((x) => x.review).length}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { normalizeGames, stakeClosing, compareOfficial, nhlOfficialFrom, mlbOfficialFrom, settle, serialize, adviceSnapshots, NBA_REGULAR_START_MS };
