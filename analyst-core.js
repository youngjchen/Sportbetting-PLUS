/* ============================================================
   分析師推薦頁核心（純函式；瀏覽器 window.AnalystCore 與 node 測試共用）
   規則（使用者 2026-10-14 確認）：
     · 每位分析師每場兩層：card（左鍵＝表單）、lotto（右鍵＝LOTTO／串關）。
     · 主要命中率每人每場一張：有 card 用 card；沒有 card 時 lotto 那筆計入。
     · 同場已有 card 的 lotto 另計（跟表單一樣／同隊改盤口／反向），不進主帳與同向衝突統計。
     · 整張串關不記。ROI＝每張 1 單位，賠率優先用 Stake 收盤價、沒有才用登錄當下價。
   名詞：絕對衝突＝與對面某張票不可能同時過（兩邊線相加 ≤ 0，例 ML vs ML）；
         相對衝突＝有人押對面但都可能同時過（例 ML vs 對手 +1.5）。
   ============================================================ */
(function initAnalystCore(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AnalystCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildAnalystCore() {
  'use strict';

  const ANALYSTS = ['APE', 'BOOKIE', 'BANKROLL', 'SNIPER', 'MONEY'];
  // 觀察名單（2026-10-16）：照常登錄、結算，但不進任何合併統計（同向／衝突、對決、組合）；轉正＝移到 ANALYSTS，下架＝移出這裡
  const WATCH = ['LEO'];
  // card＝表單、lotto＝LOTTO、rev＝改版另計（同日第二版表單改動的場次，只另外統計）
  const LAYERS = ['card', 'lotto', 'rev'];

  function pickKey(p) { return `${p.analyst}|${p.officialId}|${p.layer}`; }

  // 隊伍視角的讓分：ML＝0；SPREAD＝pick.line（受讓為正、讓分為負）
  function pickLine(p) { return p.market === 'ML' ? 0 : Number(p.line); }

  // 多裝置合併：同一 key 取 updatedAt 較新者；deleted 為墓碑（保留以免被舊裝置復活）
  function mergePicks(...lists) {
    const out = new Map();
    for (const list of lists) {
      for (const p of list || []) {
        const k = pickKey(p);
        const old = out.get(k);
        if (!old || String(p.updatedAt || '') > String(old.updatedAt || '')) out.set(k, p);
      }
    }
    return [...out.values()];
  }

  function livePicks(picks) { return (picks || []).filter((p) => p && !p.deleted); }

  function gameMargin(game, side) {
    const own = side === 'away' ? game.awayScore : game.homeScore;
    const opp = side === 'away' ? game.homeScore : game.awayScore;
    return Number(own) - Number(opp);
  }

  function settlePick(p, game) {
    if (game && game.void) return { result: 'refund', direction: 'refund' };   // 延賽／取消：退款，不進分母
    if (!game || !game.final) return { result: 'pending', direction: 'pending' };
    const margin = gameMargin(game, p.side);
    const adj = margin + pickLine(p);
    return {
      result: adj > 0 ? 'win' : adj < 0 ? 'loss' : 'push',
      direction: margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push',
    };
  }

  // Stake 賠率：closing＝收盤（結算工作流寫入）；spread 以 favorite＋line 表示，隊伍視角線＝讓方 -line、受讓方 +line
  // 用獨贏校正讓分方向：受讓那邊的讓分隱含機率必高於它的獨贏隱含機率，讓分那邊必低於。
  // Stake 的 favorite 欄位有時是「獨贏熱門」而非「讓分方」（另開盤），不能直接信；兩種方向都對不上就不用這組。
  function orientSpread(s, ml) {
    const n = (v) => Number(v);
    if (!ml || !(n(ml.away) > 1 && n(ml.home) > 1) || !(n(s.away) > 1 && n(s.home) > 1)) return s;
    const pa = 1 / n(ml.away); const ph = 1 / n(ml.home); const sa = 1 / n(s.away); const sh = 1 / n(s.home);
    const homeLays = sh < ph && sa > pa; const awayLays = sa < pa && sh > ph;
    if (homeLays && !awayLays) return s.favorite === 'home' ? s : Object.assign({}, s, { favorite: 'home' });
    if (awayLays && !homeLays) return s.favorite === 'away' ? s : Object.assign({}, s, { favorite: 'away' });
    return null;
  }
  function spreadQuote(raw, p, ml) {
    const s = raw && orientSpread(raw, ml);
    if (!s || !Number.isFinite(Number(s.line))) return null;
    const teamLine = s.favorite === p.side ? -Number(s.line) : Number(s.line);
    if (Math.abs(teamLine - pickLine(p)) > 1e-9) return null;   // 熱門隊 +1.5 等另開盤口：這組沒有價
    const v = s[p.side];
    return Number.isFinite(Number(v)) && Number(v) > 1 ? { odds: Number(v), book: s.book || null } : null;
  }
  // 收盤快照：ml 一組；讓分可為 spread（一組）或 spreads（多組，依優先序；例 Stake 另開盤＋bet365 主盤）
  function priceQuote(snapshot, p) {
    if (!snapshot) return null;
    if (p.market === 'ML') {
      const v = snapshot.ml && snapshot.ml[p.side];
      return Number.isFinite(Number(v)) && Number(v) > 1 ? { odds: Number(v), book: snapshot.ml.book || null } : null;
    }
    for (const s of [].concat(snapshot.spread || [], snapshot.spreads || [])) {
      const q = spreadQuote(s, p, snapshot.ml);
      if (q) return q;
    }
    return null;
  }
  function priceFrom(snapshot, p) { const q = priceQuote(snapshot, p); return q ? q.odds : null; }

  function priceFor(p, game) {
    const closing = priceQuote(game && game.closing, p);
    if (closing) return { odds: closing.odds, oddsSource: 'closing', book: closing.book || (game.closing && game.closing.source === 'stake' ? 'stake' : null) };
    const entry = Number(p.entryOdds);
    if (Number.isFinite(entry) && entry > 1) return { odds: entry, oddsSource: 'entry', book: 'stake' };
    return { odds: null, oddsSource: null, book: null };
  }

  function relationToCard(lotto, card) {
    if (!card) return '表單沒有';
    if (card.side !== lotto.side) return '反向';
    return card.market === lotto.market && pickLine(card) === pickLine(lotto) ? '跟表單一樣' : '同隊改盤口';
  }

  // picks＋results（officialId → game）→ 逐筆帳
  function buildLedger(picks, results) {
    const live = livePicks(picks);
    const cards = new Map();
    for (const p of live) if (p.layer === 'card') cards.set(`${p.analyst}|${p.officialId}`, p);
    const rows = [];
    for (const p of live) {
      const game = results && results[p.officialId];
      const card = cards.get(`${p.analyst}|${p.officialId}`);
      const isCard = p.layer === 'card';
      // fixedResult：歷史帳本已判定、但無法對到單一場次的票（例：雙重賽未標場次、兩場皆敗）
      const settled = p.fixedResult ? { result: p.fixedResult, direction: p.fixedResult } : settlePick(p, game);
      const price = priceFor(p, game);
      const profit = price.odds == null || settled.result === 'pending' || settled.result === 'refund' ? null
        : settled.result === 'win' ? Math.round((price.odds - 1) * 10000) / 10000
          : settled.result === 'loss' ? -1 : 0;
      rows.push({
        ...p,
        line: pickLine(p),
        result: settled.result,
        direction: settled.direction,
        countsInMain: isCard || (p.layer === 'lotto' && !card),
        relation: isCard ? '表單' : relationToCard(p, card),
        phase: (game && game.phase) || null,
        odds: price.odds,
        oddsSource: price.oddsSource,
        oddsBook: price.book,
        profit,
      });
    }
    return rows;
  }

  function emptyStats() {
    return { wins: 0, losses: 0, pushes: 0, refunds: 0, pending: 0, settled: 0, hitRate: null, dirWins: 0, dirSettled: 0, dirRate: null, priced: 0, profit: 0, roi: null };
  }

  function summarize(rows) {
    const s = emptyStats();
    for (const r of rows) {
      if (r.result === 'win') s.wins++;
      else if (r.result === 'loss') s.losses++;
      else if (r.result === 'push') s.pushes++;
      else if (r.result === 'refund') s.refunds++;
      else s.pending++;
      if (r.direction === 'win' || r.direction === 'loss') { s.dirSettled++; if (r.direction === 'win') s.dirWins++; }
      if (r.profit != null) { s.priced++; s.profit += r.profit; }
    }
    s.settled = s.wins + s.losses;
    s.hitRate = s.settled ? s.wins / s.settled : null;
    s.dirRate = s.dirSettled ? s.dirWins / s.dirSettled : null;
    s.profit = Math.round(s.profit * 10000) / 10000;
    s.roi = s.priced ? s.profit / s.priced : null;
    return s;
  }

  // 篩選：league、from/to（台灣日期）、phases（陣列；預設排除 preseason）
  function filterRows(rows, f = {}) {
    const phases = f.phases || ['regular', 'postseason', null];
    return rows.filter((r) => (!f.league || r.league === f.league)
      && (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to)
      && phases.includes(r.phase == null ? null : r.phase));
  }

  // 主帳每張票標上情境（只看主帳票；同場對面的票才算衝突）
  function annotateContexts(rows) {
    const main = rows.filter((r) => r.countsInMain && r.result !== 'pending' && r.result !== 'refund');
    const byGame = new Map();
    for (const r of main) {
      if (!byGame.has(r.officialId)) byGame.set(r.officialId, []);
      byGame.get(r.officialId).push(r);
    }
    const out = [];
    for (const [officialId, list] of byGame) {
      const sides = { away: list.filter((r) => r.side === 'away'), home: list.filter((r) => r.side === 'home') };
      for (const r of list) {
        const own = sides[r.side];
        const opp = sides[r.side === 'away' ? 'home' : 'away'];
        const ctx = { officialId, ownCount: own.length, oppCount: opp.length, partners: own.filter((x) => x !== r).map((x) => x.analyst), opponents: opp.map((x) => x.analyst) };
        if (!opp.length) {
          ctx.alignment = own.length < 2 ? 'solo'
            : own.every((x) => x.market === r.market && x.line === r.line) ? 'absolute' : 'relative';
          ctx.conflict = null;
        } else {
          ctx.alignment = null;
          ctx.conflict = opp.some((x) => x.line + r.line <= 0) ? 'absolute' : 'relative';
          ctx.shape = own.length === 1 && opp.length >= 2 ? 'lone'
            : opp.length === 1 && own.length >= 2 ? 'vsLone'
              : own.length >= 2 && opp.length >= 2 ? 'multi' : 'oneOnOne';
          ctx.side = own.length > opp.length ? 'majority' : own.length < opp.length ? 'minority' : 'tie';
        }
        out.push({ ...r, ctx });
      }
    }
    return out;
  }

  const SCENARIOS = {
    all: () => true,
    absoluteAligned: (r) => r.ctx.alignment === 'absolute',
    relativeAligned: (r) => r.ctx.alignment === 'relative',
    noOpposition: (r) => r.ctx.oppCount === 0 && r.ctx.ownCount >= 2,
    conflict: (r) => r.ctx.oppCount > 0,
    absoluteConflict: (r) => r.ctx.conflict === 'absolute',
    relativeConflict: (r) => r.ctx.conflict === 'relative',
    loneDissent: (r) => r.ctx.shape === 'lone',
    majorityVsLone: (r) => r.ctx.shape === 'vsLone',
    multiConflict: (r) => r.ctx.shape === 'multi',
    tie: (r) => r.ctx.oppCount > 0 && r.ctx.side === 'tie',
  };

  function inScenario(r, scenario) {
    const test = SCENARIOS[scenario];
    if (!test) throw new Error(`Unknown scenario ${scenario}`);
    return test(r);
  }

  function scenarioStats(annotated, scenario) {
    const test = SCENARIOS[scenario];
    if (!test) throw new Error(`Unknown scenario ${scenario}`);
    const out = {};
    for (const a of ANALYSTS) out[a] = summarize(annotated.filter((r) => r.analyst === a && test(r)));
    return out;
  }

  // 兩兩：同向（以場為單位，看球隊直勝與兩人票皆過）、對立（各自的票有沒有過）
  function pairMatrix(annotated) {
    const byGame = new Map();
    for (const r of annotated) {
      if (!byGame.has(r.officialId)) byGame.set(r.officialId, []);
      byGame.get(r.officialId).push(r);
    }
    const same = {}; const versus = {};
    for (const list of byGame.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < list.length; j++) {
          if (i === j) continue;
          const x = list[i]; const y = list[j];
          if (x.side === y.side) {
            if (ANALYSTS.indexOf(x.analyst) > ANALYSTS.indexOf(y.analyst)) continue;
            const k = `${x.analyst}+${y.analyst}`;
            const s = same[k] || (same[k] = { games: 0, dirWins: 0, bothWin: 0 });
            s.games++;
            if (x.direction === 'win') s.dirWins++;
            if (x.result === 'win' && y.result === 'win') s.bothWin++;
          } else {
            const k = `${x.analyst}>${y.analyst}`;
            const v = versus[k] || (versus[k] = { games: 0, wins: 0 });
            v.games++;
            if (x.result === 'win') v.wins++;
          }
        }
      }
    }
    return { same, versus };
  }

  // 精確組合：同一邊「正好是這幾位」
  function comboBoard(annotated) {
    const byGameSide = new Map();
    for (const r of annotated) {
      const k = `${r.officialId}|${r.side}`;
      if (!byGameSide.has(k)) byGameSide.set(k, []);
      byGameSide.get(k).push(r);
    }
    const board = {};
    for (const list of byGameSide.values()) {
      const key = list.map((r) => r.analyst).sort((a, b) => ANALYSTS.indexOf(a) - ANALYSTS.indexOf(b)).join('+');
      const b = board[key] || (board[key] = { games: 0, dirWins: 0, allWin: 0, opposed: 0 });
      b.games++;
      if (list[0].direction === 'win') b.dirWins++;
      if (list.every((r) => r.result === 'win')) b.allWin++;
      if (list[0].ctx.oppCount > 0) b.opposed++;
    }
    return board;
  }

  // 「側」索引：同一場同一邊＝一側；key＝這側正好哪幾位，oppKey＝對面正好哪幾位（''＝無反方）。
  // query({ key, oppKey, opposed }) 回傳場數、球隊直勝、全員過盤與明細（給登錄頁「今天這種組合」的歷史）。
  function sideIndex(annotated) {
    const order = (list) => list.map((r) => r.analyst).sort((a, b) => ANALYSTS.indexOf(a) - ANALYSTS.indexOf(b)).join('+');
    const bySide = new Map();
    for (const r of annotated) {
      const k = `${r.officialId}|${r.side}`;
      if (!bySide.has(k)) bySide.set(k, []);
      bySide.get(k).push(r);
    }
    const sides = [];
    for (const [k, list] of bySide) {
      const cut = k.lastIndexOf('|');
      const officialId = k.slice(0, cut); const side = k.slice(cut + 1);
      const opp = bySide.get(`${officialId}|${side === 'away' ? 'home' : 'away'}`) || [];
      sides.push({ officialId, side, key: order(list), oppKey: order(opp), dirWin: list[0].direction === 'win', allWin: list.every((r) => r.result === 'win'), rows: list });
    }
    function query({ key, oppKey, opposed } = {}) {
      const hit = sides.filter((s) => (key == null || s.key === key) && (oppKey == null || s.oppKey === oppKey)
        && (opposed == null || (opposed ? s.oppKey !== '' : s.oppKey === '')));
      const games = hit.length;
      const dirWins = hit.filter((s) => s.dirWin).length;
      return { games, dirWins, dirRate: games ? dirWins / games : null, allWin: hit.filter((s) => s.allWin).length, rows: hit.flatMap((s) => s.rows) };
    }
    return { sides, query, keyOf: order };
  }

  // 盤口類別：ML／PLUS（受讓，線 > 0）／MINUS（讓分，線 < 0）
  function marketKind(r) { return r.market === 'ML' ? 'ML' : r.line > 0 ? 'PLUS' : 'MINUS'; }
  // 對決查詢：主角 hero 押 heroMarket；對手＝其他分析師（opp 為陣列時須全部在場）押 oppMarket；
  // relation：'oppose'＝押對面那隊，'same'＝押同一隊。每場一個事件；對手過盤以對手第一張（依分析師順序）為代表，
  // 同隊同盤口的對手結果必然相同。
  function duel(annotated, { hero, heroMarket = 'any', opp = 'any', oppMarket = 'any', relation = 'oppose' } = {}) {
    const byGame = new Map();
    for (const r of annotated) {
      if (!byGame.has(r.officialId)) byGame.set(r.officialId, []);
      byGame.get(r.officialId).push(r);
    }
    const events = [];
    for (const list of byGame.values()) {
      const h = list.find((r) => r.analyst === hero && (heroMarket === 'any' || marketKind(r) === heroMarket));
      if (!h) continue;
      let others = list.filter((r) => r.analyst !== hero && (relation === 'oppose' ? r.side !== h.side : r.side === h.side)
        && (oppMarket === 'any' || marketKind(r) === oppMarket));
      if (Array.isArray(opp)) {
        others = others.filter((r) => opp.includes(r.analyst));
        if (!opp.length || opp.some((a) => !others.some((r) => r.analyst === a))) continue;
      }
      if (!others.length) continue;
      others.sort((a, b) => ANALYSTS.indexOf(a.analyst) - ANALYSTS.indexOf(b.analyst));
      events.push({ officialId: h.officialId, hero: h, opps: others, heroWin: h.result === 'win', oppWin: others[0].result === 'win' });
    }
    return {
      events,
      games: events.length,
      hero: summarize(events.map((e) => e.hero)),
      opp: summarize(events.map((e) => e.opps[0])),
      both: events.filter((e) => e.heroWin && e.oppWin).length,
    };
  }

  return {
    ANALYSTS, WATCH, LAYERS, SCENARIOS: Object.keys(SCENARIOS), sideIndex, duel, marketKind,
    pickKey, pickLine, mergePicks, livePicks, settlePick, priceQuote, priceFrom, priceFor, relationToCard,
    buildLedger, summarize, filterRows, annotateContexts, inScenario, scenarioStats, pairMatrix, comboBoard,
  };
});
