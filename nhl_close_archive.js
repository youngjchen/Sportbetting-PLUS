'use strict';
/* =====================================================================
   NHL 收盤存檔（2026-11-15 使用者要求：電腦隔一週再開，也要自動補齊異常場）

   問題：冰球卡片、比賽紀錄、異常快照只算在「打開 nhl.html 的那台裝置」上；
   雲端 Stake／BET365 賠率檔只留約 3 天、賽程比分檔約 8 天。裝置超過 3 天沒開，
   那幾天的異常判定就永遠算不回來。

   本程式（nhl-close-archive.yml 每小時跑）把「已完賽」場次的
     · 賽程比分（data/nhl_pregame.json 的原始那筆）
     · Stake 最後一版（data/stake_api_odds.json）
     · BET365 最後一版（data/nhl_bet365_odds.json）
   存進 data/nhl_close_archive.json，保留 RETENTION_DAYS 天。
   賠率只裁掉顯示用欄位；讓分歷史只留「讓分方／線／賠率有變」的列（異常判定只看這些），
   所以 nhl.html 用存檔算出的異常快照與當時即時算的完全相同。

   只讀上述三檔；只寫 data/nhl_close_archive.json。內容沒變就不寫檔（不產生空提交）。
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const NhlStake = require('./nhl_stake_core.js');
const NhlBet365 = require('./nhl_bet365_core.js');

const RETENTION_DAYS = 30;
const ARCHIVE_PATH = 'data/nhl_close_archive.json';

function readJson(root, rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch (e) { return fallback; }
}

function twDate(ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); }

// 讓分列的比較鍵：只含 nhl_stake_core normalizedHistory 簽章會讀的欄位（讓分方、線、雙方賠率）。
// 鍵相同＝簽章相同，刪掉這種「沒變」的列不影響換邊次數與顛倒／收斂判定。
function hdKey(hd) {
  if (!hd || typeof hd !== 'object') return 'null';
  const outcomes = (Array.isArray(hd.outcomes) ? hd.outcomes : [])
    .map((o) => (o ? [o.side, o.odds, o.line] : null));
  return JSON.stringify([hd.line, hd.favSide, hd.favorite, hd.away, hd.home, outcomes]);
}

function atMs(row) { const ms = Date.parse(String(row && row.at || '')); return Number.isFinite(ms) ? ms : 0; }

// 歷史（新→舊排列）：保留最新、最舊兩列原樣（BET365 用 [0]＝最新、[末]＝初盤）；
// 中間列依時間順序，只留讓分有變的列，且只留 at＋hd。輸出維持新→舊。
function slimHistory(history) {
  const list = Array.isArray(history) ? history : [];
  if (list.length <= 2) return list.slice();
  const newest = list[0], oldest = list[list.length - 1];
  // 與 normalizedHistory 相同的排序（依時間，同時間維持原順序），換邊判定才會一致
  const chrono = list.map((row, i) => ({ row, i })).sort((a, b) => atMs(a.row) - atMs(b.row) || a.i - b.i);
  const keep = new Set([0, list.length - 1]);
  let prevKey = null;
  for (const { row, i } of chrono) {
    const key = hdKey(row && row.hd);
    if (key !== prevKey) keep.add(i);
    prevKey = key;
  }
  return list.map((row, i) => {
    if (!keep.has(i)) return null;
    if (row === newest || row === oldest) return row;
    return { at: row.at, hd: row.hd };
  }).filter(Boolean);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const STAKE_KEYS = ['fixtureId', 'league', 'date', 'startTime', 'startISO', 'stakeDate', 'status',
  'awayTeam', 'homeTeam', 'lastPregameAt', 'ml', 'hd', 'tot', 'markets'];
function slimStakeGame(game) {
  if (!game) return null;
  return { ...pick(game, STAKE_KEYS), history: slimHistory(game.history) };
}

const B365_KEYS = ['startTime', 'away', 'home', 'awayZh', 'homeZh', 'provider', 'status', 'ml', 'hd', 'total'];
function slimB365Game(game) {
  if (!game) return null;
  return { ...pick(game, B365_KEYS), history: slimHistory(game.history) };
}

// prev：舊存檔；pregame／stake／b365：三份即時檔。回傳新的 games 物件（依日期、時間、id 排序）。
function buildGames({ prev, pregame, stake, b365, nowMs }) {
  const cutoff = twDate(nowMs - RETENTION_DAYS * 86400e3);
  const games = {};
  for (const [id, entry] of Object.entries((prev && prev.games) || {})) {
    if (entry && entry.pregame && String(entry.pregame.date || '') >= cutoff) games[id] = entry;
  }
  const stakeFeed = stake && stake.games ? stake : { games: {} };
  const b365Feed = b365 && b365.games ? b365 : { games: {} };
  for (const g of (pregame && pregame.games) || []) {
    if (!g || !g.officialId || g.status !== 'finished' || g.awayScore == null || g.homeScore == null) continue;
    if (String(g.date || '') < cutoff) continue;
    const old = games[g.officialId] || {};
    const sm = NhlStake.findStakeGame(stakeFeed, g);
    const bm = NhlBet365.findBet365Game(b365Feed, g);
    games[g.officialId] = {
      pregame: g,
      stake: sm ? slimStakeGame(sm.game) : (old.stake || null),   // 已滾出即時檔＝沿用先前存下的最後一版
      b365: bm ? slimB365Game(bm.game) : (old.b365 || null),
    };
  }
  const order = (e) => `${e.pregame.date}|${String(e.pregame.time || '').padStart(5, '0')}`;
  return Object.fromEntries(Object.entries(games).sort(([ia, a], [ib, b]) => (
    order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : (ia < ib ? -1 : ia > ib ? 1 : 0))));
}

function serialize(games, updated) {
  const rows = Object.entries(games).map(([id, e]) => `${JSON.stringify(id)}:${JSON.stringify(e)}`);
  return `{"version":1,"updated":${JSON.stringify(updated)},"retentionDays":${RETENTION_DAYS},"games":{\n${rows.join(',\n')}\n}}\n`;
}

function run(root, nowMs = Date.now()) {
  const prev = readJson(root, ARCHIVE_PATH, { games: {} });
  const pregame = readJson(root, 'data/nhl_pregame.json', null);
  const stake = readJson(root, 'data/stake_api_odds.json', null);
  const b365 = readJson(root, 'data/nhl_bet365_odds.json', null);
  if (!pregame || !Array.isArray(pregame.games)) throw new Error('讀不到 data/nhl_pregame.json');
  const games = buildGames({ prev, pregame, stake, b365, nowMs });
  if (JSON.stringify(games) === JSON.stringify(prev.games || {})) return { changed: false, count: Object.keys(games).length };
  fs.writeFileSync(path.join(root, ARCHIVE_PATH), serialize(games, new Date(nowMs).toISOString()));
  return { changed: true, count: Object.keys(games).length };
}

module.exports = { RETENTION_DAYS, hdKey, slimHistory, slimStakeGame, slimB365Game, buildGames, serialize, run };

if (require.main === module) {
  const res = run(process.cwd());
  console.log(`[nhl-close-archive] ${res.changed ? '已更新' : '沒有變動'}：${res.count} 場`);
}
