'use strict';

// nba_betexplorer.js — BetExplorer 上的 BET365 NBA 盤口（獨贏／讓分／大小，含每條線的開出時間與是否已撤下）
// 2026-10-11 使用者規格：BET365 官網靜態頁只有正規賽（季前賽沒有）、互動頁擋程式 →
// 以 BetExplorer 的 BET365 欄為備援（使用者原始設計：官網 → BetExplorer → OddsPortal），也回補之前沒抓到的場次。
// 只在本機（住宅 IP）跑：GitHub 美國主機看不到 BET365 欄（同棒球 BetExplorer，見 local_failover.js）。
// 輸出 data/nba_betexplorer_bet365.json，由 nba_bet365_odds.js（GitHub 工作流）讀來當 BET365 備援。

const fs = require('node:fs');
const path = require('node:path');
const { translateNbaTeam, boardTeam } = require('./nba_odds_core.js');

const BASE = 'https://www.betexplorer.com';
const OUT = path.join(__dirname, 'data', 'nba_betexplorer_bet365.json');
const PREGAME = path.join(__dirname, 'data', 'nba_pregame.json');
const WNBA_PREGAME = path.join(__dirname, 'data', 'wnba_pregame.json');
// 2026-10-11：WNBA 一併改用 BetExplorer 的 BET365 欄（原本的 WNBA 備援拿的是 Stake.com 的盤）。
// BetExplorer 的 WNBA 隊名尾巴多一個「 W」（Las Vegas Aces W）。
function wnbaZh(name) {
  const text = clean(name).replace(/\s+W$/, '');
  try {
    const zh = require('./nba_bet365_odds.js').translateBasketballTeam('WNBA', text);
    return zh && zh !== text ? zh : null;
  } catch (_) { return null; }
}
const LEAGUES = Object.freeze({
  NBA: { path: 'nba', idPattern: /^NBA_/, zh: (name) => zhTeam(name), key: (name) => boardTeam(name) },
  WNBA: { path: 'wnba', idPattern: /^WNBA_/, zh: (name) => wnbaZh(name), key: (name) => clean(name) },
});
const listUrls = (league) => [`${BASE}/basketball/usa/${LEAGUES[league].path}/fixtures/`, `${BASE}/basketball/usa/${LEAGUES[league].path}/results/`];
const HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Referer: `${BASE}/basketball/`,
});
const DEFAULT_OFFSET_H = 7;              // BetExplorer 站方時間 → 台灣時間（站方顯示 23:30 ＝ 台灣 06:30）
const BACK_DAYS = 7;                     // 回補：保留期內的已完賽場次
const AHEAD_DAYS = 2;
const MATCH_TOLERANCE_MS = 3 * 3600e3;   // 站方開賽時間與賽程差距上限
const COMPLETE_AFTER_MS = 20 * 60e3;     // 開賽 20 分鐘後抓到的資料視為定案，之後不再重抓

function clean(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
function stripTags(html) { return clean(String(html || '').replace(/<[^>]+>/g, ' ')); }
function twDate(offsetDays, now) { return new Date(now + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10); }
function zhTeam(name) { try { return translateNbaTeam(name); } catch (_) { return null; } }

// 列表頁（賽程／賽果）：<a href="/basketball/usa/nba/{slug}/{id}/" class="in-match"><span>主隊</span> - <span>客隊</span></a>
function parseListPage(html, league = 'NBA') {
  const cfg = LEAGUES[league];
  const out = [];
  const seen = new Set();
  const re = new RegExp(`<a\\b[^>]*href="(\\/basketball\\/usa\\/${cfg.path}\\/[^"\\/]+\\/([A-Za-z0-9]{8})\\/)"[^>]*class="in-match"[^>]*>([\\s\\S]*?)<\\/a>`, 'g');
  let m;
  while ((m = re.exec(String(html || '')))) {
    const [homeEn, awayEn] = stripTags(m[3]).split(' - ').map(clean);
    if (!homeEn || !awayEn || seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ eventId: m[2], url: BASE + m[1], league, homeEn, awayEn, home: cfg.zh(homeEn), away: cfg.zh(awayEn) });
  }
  return out;
}

// 'd,m,y,H,M'（站方時間）
function parseSiteDt(raw) {
  const p = String(raw || '').split(',').map((x) => Number(String(x).trim()));
  if (p.length !== 5 || p.some((x) => !Number.isFinite(x))) return null;
  return { d: p[0], m: p[1], y: p[2], H: p[3], M: p[4] };
}
function siteToUtcMs(raw, offsetH) {
  const t = parseSiteDt(raw);
  if (!t) return NaN;
  return Date.UTC(t.y, t.m - 1, t.d, t.H, t.M) + (Number(offsetH) - 8) * 3600e3;
}
function matchPageDt(html) {
  const m = /id="match-date"[^>]*data-dt="([^"]+)"/.exec(String(html || '')) || /data-dt="([^"]+)"[^>]*id="match-date"/.exec(String(html || ''));
  return m ? m[1] : null;
}

// 賠率表中 BET365 那幾列：line＝主隊視角（負＝主讓）；cells[0]＝主／大、cells[1]＝客／小；class 有 inactive＝已撤下
function parseBet365Rows(oddsHtml) {
  const rows = [];
  for (const row of String(oddsHtml || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    if (!/bet365/i.test(row)) continue;
    const param = /doubleparameter[^>]*>([^<]*)</.exec(row);
    const cells = [];
    for (const td of row.match(/<td([^>]*data-odd[^>]*)>/g) || []) {
      const attrs = {};
      for (const a of td.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      cells.push(attrs);
    }
    if (cells.length < 2) continue;
    const odd = (c) => { const n = Number(c['data-odd']); return Number.isFinite(n) && n > 1 ? n : null; };
    const line = param ? Number(clean(param[1])) : null;
    rows.push({
      line: Number.isFinite(line) ? line : null,
      active: !/\binactive\b/.test(`${cells[0].class || ''} ${cells[1].class || ''}`),
      created: cells[0]['data-created'] || null,
      first: odd(cells[0]),
      second: odd(cells[1]),
    });
  }
  return rows;
}

async function defaultFetchText(url, ajax, tries = 3) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: ajax ? { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' } : HEADERS,
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return response.text();
      last = new Error(`BetExplorer HTTP ${response.status} ${url}`);
      if (response.status < 500 && response.status !== 429) break;   // 4xx（429 除外）不重試
    } catch (error) {
      last = error;                                                  // 網路瞬斷重試（同 betexplorer.py）
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw last;
}

async function collectNbaBetExplorer(options = {}) {
  const fetchText = options.fetchText || defaultFetchText;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const sleepMs = options.sleepMs == null ? 500 : Number(options.sleepMs);
  const pause = () => (sleepMs > 0 ? new Promise((resolve) => setTimeout(resolve, sleepMs)) : Promise.resolve());
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : { games: {} };
  const pregames = {
    NBA: options.pregame && typeof options.pregame === 'object' ? options.pregame : { games: [] },
    WNBA: options.wnbaPregame && typeof options.wnbaPregame === 'object' ? options.wnbaPregame : { games: [] },
  };
  const leagues = Array.isArray(options.leagues) ? options.leagues : Object.keys(LEAGUES);
  const health = { lists: 0, targeted: 0, fetched: 0, cached: 0, unmatched: [], failures: [] };
  const from = twDate(-BACK_DAYS, now), to = twDate(AHEAD_DAYS, now);
  const games = {};
  const offsets = [];
  for (const league of leagues) {
  const cfg = LEAGUES[league];
  if (!cfg) continue;
  const targets = (pregames[league].games || []).filter((g) => g && cfg.idPattern.test(String(g.officialId || '')) &&
    g.date >= from && g.date <= to && String(g.status || '').toLowerCase() !== 'postponed');
  if (!targets.length) continue;   // 這個聯盟近期沒比賽就不去抓列表頁
  const listed = [];
  for (const url of listUrls(league)) {
    try { listed.push(...parseListPage(await fetchText(url, false), league)); health.lists++; }
    catch (error) { health.failures.push({ url, error: String(error && error.message || error).slice(0, 200) }); }
    await pause();
  }
  for (const game of targets) {
    health.targeted++;
    const start = Date.parse(`${game.date}T${String(game.time || '00:00').slice(0, 5)}:00+08:00`);
    if (!Number.isFinite(start)) continue;
    const cached = previous.games && previous.games[game.officialId];
    if (cached && cached.complete) { games[game.officialId] = cached; health.cached++; continue; }
    if (start - now > AHEAD_DAYS * 86400e3) continue;
    try {
      // 候選：同主客隊（中文、含同隊異名）；之前配過的比賽編號優先
      const candidates = listed.filter((e) => e.home && e.away &&
        cfg.key(e.home) === cfg.key(game.home) && cfg.key(e.away) === cfg.key(game.away));
      if (cached && cached.eventId && !candidates.some((c) => c.eventId === cached.eventId)) candidates.unshift({ eventId: cached.eventId, url: cached.url });
      let picked = null;
      for (const cand of candidates) {
        let siteDt = cached && cached.eventId === cand.eventId ? cached.siteStart : null;
        if (!siteDt && cand.url) { siteDt = matchPageDt(await fetchText(cand.url, false)); await pause(); }
        const t = parseSiteDt(siteDt);
        if (!t) continue;
        // 校準站方時差：賽程（台灣時間）－站方時間，整點
        const naiveTw = Date.UTC(...game.date.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)),
          ...String(game.time || '00:00').slice(0, 5).split(':').map(Number));
        const diffH = Math.round((naiveTw - Date.UTC(t.y, t.m - 1, t.d, t.H, t.M)) / 3600e3);
        // 只用固定時差判斷是否同一場（±3 小時已涵蓋歐洲日光節約）；diffH 只拿來回報站方時差
        if (Math.abs(siteToUtcMs(siteDt, DEFAULT_OFFSET_H) - start) <= MATCH_TOLERANCE_MS) {
          picked = { eventId: cand.eventId, url: cand.url, siteDt, diffH };
          break;
        }
      }
      if (!picked) { health.unmatched.push(`${game.officialId} ${game.away}@${game.home}`); if (cached) games[game.officialId] = cached; continue; }
      offsets.push(picked.diffH);
      const odds = {};
      for (const bt of ['ha', 'ah', 'ou']) {
        const body = await fetchText(`${BASE}/match-odds-old/${picked.eventId}/0/${bt}/1/en/?sportname=basketball`, true);
        let payload = null;
        try { payload = JSON.parse(body); } catch (_) { payload = null; }
        odds[bt] = parseBet365Rows(payload && typeof payload === 'object' ? payload.odds : body);
        await pause();
      }
      const ml = odds.ha.find((r) => r.active) || odds.ha[0] || null;
      games[game.officialId] = {
        officialId: game.officialId, league, eventId: picked.eventId, url: picked.url || null,
        siteStart: picked.siteDt, scheduledStart: new Date(start).toISOString(), away: game.away, home: game.home,
        fetchedAt: new Date(now).toISOString(), complete: now >= start + COMPLETE_AFTER_MS,
        ml: ml ? { home: ml.first, away: ml.second, created: ml.created } : null,
        hd: odds.ah.filter((r) => r.line != null && r.line !== 0).map((r) => ({ line: r.line, active: r.active, created: r.created, home: r.first, away: r.second })),
        ou: odds.ou.filter((r) => r.line != null && r.line > 0).map((r) => ({ line: r.line, active: r.active, created: r.created, over: r.first, under: r.second })),
      };
      health.fetched++;
    } catch (error) {
      health.failures.push({ officialId: game.officialId, error: String(error && error.message || error).slice(0, 200) });
      if (cached) games[game.officialId] = cached;
    }
  }
  }
  // 保留期內但這輪沒列到的舊資料保留，過期刪除
  for (const [id, g] of Object.entries(previous.games || {})) {
    if (games[id]) continue;
    const s = Date.parse(g && g.scheduledStart || '');
    if (Number.isFinite(s) && now - s <= (BACK_DAYS + 1) * 86400e3) games[id] = g;
  }
  const mode = offsets.length ? offsets.sort((a, b) => offsets.filter((v) => v === b).length - offsets.filter((v) => v === a).length)[0] : null;
  return {
    schemaVersion: 1,
    provider: 'betexplorer-bet365',
    updated: new Date(now).toISOString(),
    siteOffsetHours: Number.isFinite(mode) ? mode : (previous.siteOffsetHours || DEFAULT_OFFSET_H),
    health,
    games,
  };
}

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }

async function main() {
  const output = await collectNbaBetExplorer({
    previous: loadJson(OUT, { games: {} }),
    pregame: loadJson(PREGAME, { games: [] }),
    wnbaPregame: loadJson(WNBA_PREGAME, { games: [] }),
  });
  const temp = `${OUT}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(output, null, 1)}\n`);
  fs.renameSync(temp, OUT);
  const h = output.health;
  console.log(`BetExplorer NBA BET365：${Object.keys(output.games).length} 場（本輪抓 ${h.fetched}、沿用 ${h.cached}、配不上 ${h.unmatched.length}、失敗 ${h.failures.length}）`);
}

module.exports = { OUT, parseListPage, parseBet365Rows, matchPageDt, siteToUtcMs, collectNbaBetExplorer, DEFAULT_OFFSET_H };

if (require.main === module) main().catch((error) => {
  console.error(`BetExplorer NBA 收集失敗：${String(error && error.message || error)}`);
  process.exitCode = 1;
});
