/* ============================================================
   「今天押什麼」單場判斷（analysts.html 與 analyst_settle.js 共用；2026-11-15）
   規則本體在 analyst-core.js adviseGame()；這裡負責接資料：Stake／BET365 盤口、冰球異常、NBA 讓分級距、
   熱門讓分價、市場移動，算出押哪隊、什麼盤口、什麼價，以及存檔用的精簡結果與戰績。
   瀏覽器：window.AnalystAdvice；node：require('./analyst-advice.js')
   deps＝{ Core, NhlStake, NhlBet365 }
   feeds＝{ NHL:{ stake, b365 }, MLB:{ stake }, NBA:{ stake } }（各資料檔原樣）
   docs＝{ nhl:{ items:Map, games:Map }, nba:{ items:Map } }（這台裝置的冰球／籃球頁紀錄；伺服器沒有＝null）
   ============================================================ */
(function initAnalystAdvice(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AnalystAdvice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildAnalystAdvice() {
  'use strict';

  const side2 = (v) => (v === 'away' || v === 'home' ? v : null);
  const other = (s) => (s === 'away' ? 'home' : 'away');
  function startMsOf(g) { return Number.isFinite(g.startMs) ? g.startMs : Date.parse(`${g.date}T${String(g.time || '00:00').padStart(5, '0')}:00+08:00`); }
  function nbaMatch(feed, g) {
    const list = feed ? (Array.isArray(feed.matches) ? feed.matches : Object.values(feed.matches || {})) : [];
    const ms = startMsOf(g);
    return list.find((x) => x.officialId === g.officialId)
      || list.filter((x) => x.away === g.away && x.home === g.home && Math.abs(Date.parse(x.scheduledStart) - ms) < 12 * 3600e3)
        .sort((a, b) => Math.abs(Date.parse(a.scheduledStart) - ms) - Math.abs(Date.parse(b.scheduledStart) - ms))[0] || null;
  }

  // 各聯盟 Stake → analyst-core.priceFrom 用的 { ml:{away,home}, spread:{line,favorite,away,home}, lines?:[…] }
  function stakeSnapshot(league, g, feeds, deps) {
    const feed = feeds && feeds[league] && feeds[league].stake;
    if (!feed) return null;
    if (league === 'NHL') {
      const hit = deps.NhlStake && deps.NhlStake.findStakeGame(feed, { date: g.date, time: g.time, away: g.away, home: g.home });
      if (!hit) return null;
      return { ml: hit.ml && { away: hit.ml.away, home: hit.ml.home },
        spread: hit.hd && { line: hit.hd.line, favorite: hit.hd.favorite, away: hit.hd.away, home: hit.hd.home },
        lines: hit.game && Array.isArray(hit.game.hdLines) ? hit.game.hdLines : undefined };   // Stake 副盤（2026-11-15 起）
    }
    if (league === 'MLB') {
      const m = feed.matches && feed.matches[g.officialId];
      if (!m) return null;
      return { ml: m.moneyline, spread: m.handicapOdds && { line: m.canonicalLine, favorite: m.favorite, away: m.handicapOdds.away, home: m.handicapOdds.home } };
    }
    const m = nbaMatch(feed, g);
    if (!m) return null;
    return { ml: m.moneyline, spread: m.handicapOdds && m.line != null && { line: m.line, favorite: m.favorite, away: m.handicapOdds.away, home: m.handicapOdds.home } };
  }
  // 讓分線：MLB 固定 +1.5；NBA、NHL 照當下 Stake 主盤（讓方負、受讓方正）
  function defaultSpreadLine(league, snap, side) {
    if (league === 'MLB') return 1.5;
    const s = snap && snap.spread;
    if (!s || s.line == null) return null;
    return s.favorite === side ? -Number(s.line) : Number(s.line);
  }

  // 冰球異常：賽前用最新 Stake／BET365 讓分紀錄即時算（同冰球頁 nhlLiveSnap）；開賽後或資料檔沒這場時用冰球頁存的快照；手動標記一律優先
  function liveAnomaly(g, feeds, docs, deps) {
    const { Core, NhlStake, NhlBet365 } = deps;
    if (g.league !== 'NHL' || !NhlStake) return null;
    const nhl = docs && docs.nhl;
    const it = nhl && nhl.items ? nhl.items.get(g.officialId) || null : null;
    const rec = nhl && nhl.games ? nhl.games.get(g.officialId) || null : null;
    const pg = { date: g.date, time: g.time, away: g.away, home: g.home };
    const sm = feeds.NHL && feeds.NHL.stake ? NhlStake.findStakeGame(feeds.NHL.stake, pg) : null;
    const bm = feeds.NHL && feeds.NHL.b365 && NhlBet365 ? NhlBet365.findBet365Game(feeds.NHL.b365, pg) : null;
    let ev = null;
    if (sm || bm) {
      const h = NhlStake.summarizeHandicapHistory(sm, bm);
      const mlo = (sm && sm.ml) || (bm && bm.ml); const api = sm && sm.ml ? NhlStake : NhlBet365;
      const oa = mlo && api && api.marketOutcome(mlo, 'away'); const oh = mlo && api && api.marketOutcome(mlo, 'home');
      const mlOdds = oa && oh && Number(oa.odds) > 1 && Number(oh.odds) > 1 ? { away: Number(oa.odds), home: Number(oh.odds) } : null;
      const snap = { relation: h.currentRelation, stakeSwaps: h.stake.swapCount, bet365Swaps: h.bet365.swapCount, mlOdds, mlFav: null };
      if (snap.relation || snap.stakeSwaps || snap.bet365Swaps || mlOdds) ev = Core.anomEvidenceFromSnap(snap);
    }
    const stored = Core.anomBestSnap(it);
    if (stored && (Date.now() >= startMsOf(g) || !ev || !ev.relation)) ev = Core.anomEvidenceFromSnap(stored);
    let hdFav = side2(sm && sm.hd && sm.hd.favorite) || side2(bm && bm.hd && bm.hd.favSide) || side2(rec && rec.hdFav);
    if (it && side2(it.hdFavOverride)) hdFav = it.hdFavOverride;
    else if (it && it.hdSwap && hdFav) hdFav = other(hdFav);
    const cls = Core.anomClassify(ev, it, hdFav);
    return cls ? { cls, hdFav } : null;
  }

  // NBA：Stake 讓分開盤（第一筆）→ 現在（開賽前最後一筆）；資料檔沒這場時用籃球頁存的
  function liveLineMove(g, feeds, docs, deps) {
    if (g.league !== 'NBA') return null;
    const m = nbaMatch(feeds.NBA && feeds.NBA.stake, g);
    if (m) {
      const start = Date.parse(m.scheduledStart) || startMsOf(g);
      const pre = (at) => { const ms = Date.parse(at || ''); return !Number.isFinite(ms) || ms <= start; };
      const rows = (m.history || []).concat([{ observedAt: m.observedAt, favorite: m.favorite, line: m.line }])
        .filter((h) => h && pre(h.observedAt)).map((h) => ({ at: h.observedAt, fav: side2(h.favorite), line: h.line }));
      const lm = deps.Core.lineMoveOf(rows);
      if (lm) return lm;
    }
    const it = docs && docs.nba && docs.nba.items ? docs.nba.items.get(g.officialId) : null;
    const snap = it && ((it.lineSnap && it.lineSnap.stake) || (it.lineLive && it.lineLive.stake));
    return snap && deps.Core.lineMoveGroup(snap) ? snap : null;
  }

  // 獨贏市場移動（只顯示、不進規則）：Stake 開盤→現在；冰球另看 BET365。pp＝換算勝率變化（1／賠率）
  function marketMove(g, feeds, deps) {
    const pair = (a, h) => (Number(a) > 1 && Number(h) > 1 ? { away: Number(a), home: Number(h) } : null);
    let stake = null; let bet365 = null;
    if (g.league === 'NHL' && deps.NhlStake && feeds.NHL && feeds.NHL.stake) {
      const sm = deps.NhlStake.findStakeGame(feeds.NHL.stake, { date: g.date, time: g.time, away: g.away, home: g.home });
      if (sm && sm.open && sm.open.ml && sm.ml) stake = { open: pair(sm.open.ml.away, sm.open.ml.home), now: pair(sm.ml.away, sm.ml.home) };
      const B = deps.NhlBet365; const bm = B && feeds.NHL.b365 ? B.findBet365Game(feeds.NHL.b365, { date: g.date, time: g.time, away: g.away, home: g.home }) : null;
      if (bm && bm.open && bm.ml) {
        const o = (mk, s) => { const x = mk && B.marketOutcome(mk, s); return x && x.odds; };
        bet365 = { open: pair(o(bm.open.ml, 'away'), o(bm.open.ml, 'home')), now: pair(o(bm.ml, 'away'), o(bm.ml, 'home')) };
      }
    } else if (g.league === 'NBA') {
      const m = nbaMatch(feeds.NBA && feeds.NBA.stake, g);
      const first = m && (m.history || []).find((h) => h && h.moneyline && Number(h.moneyline.away) > 1);
      if (m && first && m.moneyline) stake = { open: pair(first.moneyline.away, first.moneyline.home), now: pair(m.moneyline.away, m.moneyline.home) };
    }
    const shift = (x) => (x && x.open && x.now ? { away: 1 / x.now.away - 1 / x.open.away, home: 1 / x.now.home - 1 / x.open.home } : null);
    const s = shift(stake); const b = shift(bet365);
    if (!s) return null;
    const team = s.away >= s.home ? 'away' : 'home';   // 換算勝率變高的那隊
    const pp = Math.round(s[team] * 1000) / 10;
    const bpp = b ? Math.round(b[team] * 1000) / 10 : null;
    return { stake, bet365, team, pp, bpp, big: pp >= 2.5, onlyStake: pp >= 2.5 && bpp != null && Math.abs(bpp) < 1 };
  }

  // 建議盤口的價：Stake 現價（開賽後用收盤）；受讓盤已不在主盤（隊伍變讓分方）就改 ML
  function quote(g, side, pk, snap, deps) {
    const { Core } = deps;
    let p = { side, market: pk.market, line: pk.market === 'ML' ? 0 : pk.line }; let note = '';
    let odds = Core.priceFrom(snap, p);
    if (odds == null && p.market === 'SPREAD' && p.line > 0) {
      const now = defaultSpreadLine(g.league, snap, side);
      const ml = Core.priceFrom(snap, { side, market: 'ML', line: 0 });
      if (now != null && now < 0 && ml != null) { p = { side, market: 'ML', line: 0 }; odds = ml; note = `推薦時是 +${pk.line}，現在 Stake 主盤這隊變讓分方 → 改看 ML`; }
    }
    return { pick: p, odds, note };
  }

  // 單場判斷。all＝每位分析師這場的主帳票（表單優先、沒有才 LOTTO，已排除觀察名單）；ignored(a)＝⚙ 忽略；core＝主跟（NBA 傳 null）
  // L＝{ ann, anomRecs, lineRec, spotRec }（同聯盟、到前一天為止）
  function decide({ g, all, ignored = () => false, core, L, feeds, docs = null, deps }) {
    const { Core } = deps;
    const live = all.filter((p) => !ignored(p.analyst));
    const anomaly = liveAnomaly(g, feeds, docs, deps);
    const lineMove = liveLineMove(g, feeds, docs, deps);
    const snap = stakeSnapshot(g.league, g, feeds, deps) || g.closing || null;
    const spot = g.league === 'NHL' ? Core.priceSpot(snap) : null;
    let a = Core.adviseGame({ picks: live, core, ann: L.ann, anomaly, anomRecs: L.anomRecs || {}, lineMove, lineRec: L.lineRec || null, spot, spotRec: L.spotRec || null });
    let q = null; let alt = null; let note = '';
    if (a.side) {
      const fallback = { market: 'SPREAD', line: defaultSpreadLine(g.league, snap, a.side) || 1.5 };
      const pk = Core.advicePick(a, live, a.ev.anomaly && a.ev.anomaly.rule === 'convOne' ? fallback : null);
      q = quote(g, a.side, pk, snap, deps); note = q.note;
      if (g.league === 'NBA') a = Core.dogMlAdjust(a, q.pick, lineMove);
      if (a.side && pk.alt) {
        const ap = { side: a.side, market: 'SPREAD', line: pk.alt.line };
        alt = Object.assign(ap, { ok: !!pk.alt.ok, odds: Core.priceFrom(snap, ap) });
      }
      if (!a.side) q = null;
    }
    return { a, live, q, alt, note, snap, spot, lineMove, anomaly, move: marketMove(g, feeds, deps) };
  }

  // 存檔用（結算檔每場的 advice）：開賽前每輪覆蓋、開賽後不再改
  function freeze(dec, at) {
    const a = dec.a; const tier = a.side ? a.tier : 'skip';
    const out = { at, tier, by: a.by || null, reason: a.reason, core: a.core || null };
    if (a.side && dec.q) Object.assign(out, { side: a.side, market: dec.q.pick.market, line: dec.q.pick.line, odds: dec.q.odds });
    if (dec.alt) out.alt = { line: dec.alt.line, odds: dec.alt.odds, ok: dec.alt.ok };
    if (dec.move) out.move = { team: dec.move.team, pp: dec.move.pp, bpp: dec.move.bpp };
    return out;
  }
  const sameAdvice = (x, y) => { const strip = (o) => o && Object.assign({}, o, { at: null }); return JSON.stringify(strip(x)) === JSON.stringify(strip(y)); };

  // 存檔判斷的戰績：games＝結算檔的 games（每場 advice＋比分）；回傳 { all, byLeague, byRule, alt }
  function adviceRecord(games, Core) {
    const cell = () => ({ n: 0, w: 0, priced: 0, profit: 0, skip: 0 });
    const all = cell(); const byLeague = {}; const byRule = {}; const alt = { ok: cell(), no: cell() };
    const add = (c, res, odds) => {
      if (res !== 'win' && res !== 'loss') return;
      c.n++; if (res === 'win') c.w++;
      if (Number(odds) > 1) { c.priced++; c.profit += res === 'win' ? Number(odds) - 1 : -1; }
    };
    let since = null;
    for (const g of Object.values(games || {})) {
      const adv = g && g.advice;
      if (!adv) continue;
      if (!since || g.date < since) since = g.date;
      if (!g.final || g.awayScore == null || g.homeScore == null) continue;
      const lg = byLeague[g.league] || (byLeague[g.league] = cell());
      if (!adv.side) { all.skip++; lg.skip++; continue; }
      const res = Core.settlePick({ side: adv.side, market: adv.market, line: adv.line }, g).result;
      add(all, res, adv.odds); add(lg, res, adv.odds);
      const rule = adv.by || 'analysts';
      add(byRule[rule] || (byRule[rule] = cell()), res, adv.odds);
      if (adv.alt && adv.alt.line) add(adv.alt.ok ? alt.ok : alt.no, Core.settlePick({ side: adv.side, market: 'SPREAD', line: adv.alt.line }, g).result, adv.alt.odds);
    }
    return { since, all, byLeague, byRule, alt };
  }

  return { stakeSnapshot, defaultSpreadLine, liveAnomaly, liveLineMove, marketMove, quote, decide, freeze, sameAdvice, adviceRecord };
});
