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

  const ANALYSTS = ['APE', 'BOOKIE', 'BANKROLL', 'SNIPER', 'MONEY', 'LEO'];   // LEO：10/14 起觀察、10/21 轉正
  // 觀察名單（2026-10-16）：照常登錄、結算，但不進任何合併統計（同向／衝突、對決、組合）；轉正＝移到 ANALYSTS，下架＝移出這裡
  const WATCH = [];
  // 同日會發第二版表單的分析師：登錄頁有「✎ 改版」按鈕（改版另計，只另外統計）
  const REVISERS = ['LEO'];
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

  /* ================= 「今天押什麼」（2026-11-13 使用者要求） =================
     每場一個建議：押哪隊、什麼盤口、推薦／小注／跳過，理由攤開。歷史一律只用同一聯盟（不混球種）。
     規則（優先序由上而下）：
       1. 冰球 收斂·雙方對調 → 讓分方（開賽前的讓分熱門）至少有一人推 → 押讓分方 ML，推薦；沒人推 → 跳過（訊號相反）。
          （11/12 前 26 場：有人推讓分方 23 場、讓分方直勝 17；沒人推 3 場只贏 1）
       2. 冰球 收斂·只有一家對調 → 另一邊人數 ≥ 讓分方 → 押另一邊，小注（樣本少）；否則照分析師規則。
          （20 場：另一邊人數 ≥ 讓分方 11 場、另一邊直勝 10；人數較少 9 場只贏 3）
       3. 只有一邊有人推 → 跟（主跟的人在裡面或 ≥2 人＝推薦；只有一位非主跟＝小注）。
       4. 兩邊都有人 → 看兩個訊號挺不挺主跟的人：
            a. 兩組對上：今天這兩組人（到場的人各自全押同一邊）過去對上，誰那邊的票較好；
            b. 單挑：主跟的人過去對上今天對面那幾位時，誰的票較好。
          訊號 = 過盤率差 ≥ 5 個百分點、且收盤報酬沒有反向；不到 5 場＝不算。
          加總 ≥ +1 → 跟；兩個都沒資料 → 照跟；一正一負 → 跳過；−1 → 跳過；−2 → 押對面（小注）。
          兩邊人數一樣（例 2:2）→ 降一級（推薦→小注、小注→跳過）。
          主跟的人沒推 → 只看兩組對上：有一邊明顯較好＝小注那邊，否則跳過。
     NBA（2026-11-13 使用者：「NBA 不用主跟分析師，因為幾乎所有人都是賠錢的」）：core＝null，衝突只看兩組對上。
       5. Stake 讓分加深（開盤→現在，同一讓分方、多 ≥2 分）→ 熱門至少一人推＝押熱門獨贏，推薦；沒人推＝跳過。
          （11/12 前例行賽 26 場：熱門直勝 23、讓方過盤只有 12；押熱門獨贏的票 90%、報酬 +18%，NBA 全體押熱門獨贏 +1%）
       6. 建議押的是冷門獨贏 → 降一級（NBA 全體押冷門獨贏 32%、報酬 −30%；冷門讓分各人差很多，不降）。
     冰球（2026-11-14 使用者：遊騎兵 −1.5 過了，「把這個納入系統」）：
       7. 熱門讓分（−1.5）賠率 < 冷門獨贏賠率，且熱門那邊人數 ≥ 冷門那邊 → 押熱門，推薦；主推獨贏，附 −1.5 的價。
          （9/30～11/14 共 88 場：熱門直勝 69（78%）、押獨贏 +13%；−1.5 過盤 48（55%）、+14%；
            熱門那邊人數 ≥ 冷門的 85 場直勝 68；冷門那邊人多只有 3 場、熱門 1 勝）
          不屬於這類的場，熱門 −1.5 整季只過約 30%（報酬 −17%）→ 建議押熱門讓分時加註。 */
  const ADVICE_MIN_N = 5;
  const ADVICE_EDGE = 0.05;

  function groupByGame(rows) {
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.officialId)) by.set(r.officialId, []);
      by.get(r.officialId).push(r);
    }
    return by;
  }

  // 兩組對上：X、Y 各自「到場的人」全押同一邊、兩組押不同邊（每組至少一人到場）
  function groupClash(annotated, X, Y) {
    const xs = []; const ys = []; const games = [];
    let xDir = 0;
    for (const list of groupByGame(annotated).values()) {
      const gx = list.filter((r) => X.includes(r.analyst)); const gy = list.filter((r) => Y.includes(r.analyst));
      if (!gx.length || !gy.length) continue;
      const sx = new Set(gx.map((r) => r.side)); const sy = new Set(gy.map((r) => r.side));
      if (sx.size !== 1 || sy.size !== 1 || gx[0].side === gy[0].side) continue;
      games.push(gx[0].officialId);
      if (gx[0].direction === 'win') xDir++;
      xs.push(...gx); ys.push(...gy);
    }
    return { games: games.length, ids: games, xDir, x: summarize(xs), y: summarize(ys) };
  }

  // 單挑：hero 對上 opps 裡任何一位押另一邊的場；hero 的票一場一張，對面的票是當場對面那幾位的
  function headToHead(annotated, hero, opps) {
    const hs = []; const os = []; const per = {};
    for (const o of opps) per[o] = { games: 0, hero: [], opp: [] };
    for (const list of groupByGame(annotated).values()) {
      const h = list.find((r) => r.analyst === hero);
      if (!h) continue;
      const against = list.filter((r) => opps.includes(r.analyst) && r.side !== h.side);
      if (!against.length) continue;
      hs.push(h); os.push(...against);
      for (const r of against) { const p = per[r.analyst]; p.games++; p.hero.push(h); p.opp.push(r); }
    }
    const each = {};
    for (const [o, p] of Object.entries(per)) each[o] = { games: p.games, hero: summarize(p.hero), opp: summarize(p.opp) };
    return { games: hs.length, hero: summarize(hs), opp: summarize(os), each };
  }

  // a 那邊比 b 那邊好？ +1／−1／0（樣本不足或差不多）。過盤率差 ≥ 5 點，且報酬沒有反向。
  function edgeSign(a, b, games) {
    if (games < ADVICE_MIN_N || a.hitRate == null || b.hitRate == null) return 0;
    const dh = a.hitRate - b.hitRate;
    const dr = a.roi != null && b.roi != null ? a.roi - b.roi : null;
    if (dh >= ADVICE_EDGE && (dr == null || dr >= 0)) return 1;
    if (dh <= -ADVICE_EDGE && (dr == null || dr <= 0)) return -1;
    return 0;
  }

  /* ---- 冰球異常（移植 nhl.html nhlAnomClassify／nhlEvidenceFromSnap；那邊改規則時這裡要跟著改） ---- */
  const NHL_ANOM_COMBOS = { flip: ['none', 'stake', 'bet365', 'both'], conv: ['stake', 'bet365', 'both'] };
  const NHL_DIV_MIN_GAP = 0.10;
  function normalizeFlipState(v) {
    if (v === 'converged_intl' || v === 'converged_lottery') return 'converged_unknown';
    return ['none', 'flipped', 'converged_stake', 'converged_bet365', 'converged_both', 'converged_unknown'].includes(v) ? v : 'none';
  }
  function anomSnapHasData(s) { return !!(s && (s.relation || s.mlFav || Number(s.stakeSwaps) > 0 || Number(s.bet365Swaps) > 0)); }
  function anomSnapScore(s) { if (!s) return 0; return (s.relation ? 4 : 0) + (s.mlFav ? 2 : 0) + ((Number(s.stakeSwaps) > 0 || Number(s.bet365Swaps) > 0) ? 1 : 0); }
  function anomBestSnap(it) {
    const snap = it && it.anomSnap; const live = it && it.anomLive;
    const best = anomSnapScore(live) > anomSnapScore(snap) ? live : snap;
    return anomSnapHasData(best) ? best : null;
  }
  function anomEvidenceFromSnap(s) {
    const odds = s.mlOdds && Number(s.mlOdds.away) > 1 && Number(s.mlOdds.home) > 1 ? s.mlOdds : null;
    const a = odds ? Number(odds.away) : NaN; const h = odds ? Number(odds.home) : NaN;
    const mlFav = odds ? (a < h ? 'away' : a > h ? 'home' : null) : ((s.mlFav === 'away' || s.mlFav === 'home') ? s.mlFav : null);
    return { relation: s.relation !== undefined ? (s.relation || null) : (s.flip ? 'diverged' : null),
      stakeSwaps: Number(s.stakeSwaps) || 0, bet365Swaps: Number(s.bet365Swaps) || 0,
      mlFav, mlGap: odds ? Math.round(Math.abs(a - h) * 100) / 100 : null };
  }
  function anomClassify(ev, it, hdFav) {
    const am = it && it.anomManual;
    if (am && ['flip', 'conv', 'other', 'none'].includes(am.kind)) {
      if (am.kind === 'none') return null;
      if (am.kind === 'other') return { kind: 'other', combo: null, div: true, manual: true };
      return { kind: am.kind, combo: NHL_ANOM_COMBOS[am.kind].includes(am.combo) ? am.combo : null, div: !!am.div, manual: true };
    }
    const manual = it ? (it.flipStateManual != null ? normalizeFlipState(it.flipStateManual)
      : it.platformFlip ? 'flipped' : it.flipVanished ? normalizeFlipState(it.flipDir || 'converged_unknown') : null) : null;
    if (!ev && !manual) return null;
    let relation = ev ? ev.relation : null;
    let s = !!(ev && ev.stakeSwaps > 0); let b = !!(ev && ev.bet365Swaps > 0); let comboKnown = !!(ev && (ev.relation || s || b));
    if (manual === 'none') return null;
    if (manual === 'flipped') relation = 'diverged';
    else if (manual && manual.startsWith('converged')) {
      relation = 'aligned';
      if (manual === 'converged_stake') { s = true; b = false; comboKnown = true; }
      else if (manual === 'converged_bet365') { s = false; b = true; comboKnown = true; }
      else if (manual === 'converged_both') { s = true; b = true; comboKnown = true; }
    }
    const combo = (s && b) ? 'both' : s ? 'stake' : b ? 'bet365' : 'none';
    const div = !!(ev && ev.mlFav && hdFav && ev.mlFav !== hdFav && ev.mlGap != null && ev.mlGap >= NHL_DIV_MIN_GAP);
    let kind = null;
    if (relation === 'diverged') kind = 'flip';
    else if (relation === 'aligned' && (combo !== 'none' || (manual && manual.startsWith('converged')))) kind = 'conv';
    if (!kind) return div ? { kind: 'other', combo: null, div: true } : null;
    const known = comboKnown && NHL_ANOM_COMBOS[kind].includes(combo);
    return { kind, combo: known ? combo : null, div };
  }
  function anomLabel(c) {
    if (!c) return '';
    if (c.kind === 'other') return '只背離';
    const combo = { none: '都沒對調', stake: '只有 Stake 對調', bet365: '只有 BET365 對調', both: '雙方對調' }[c.combo] || '換邊未記';
    return `${c.kind === 'flip' ? '顛倒' : '收斂'}·${combo}${c.div ? '＋背離' : ''}`;
  }
  // 規則用的異常類別：convBoth＝收斂·雙方對調、convOne＝收斂·只有一家對調；其他異常不影響建議（只顯示）
  function anomRule(c) {
    if (!c || c.kind !== 'conv') return null;
    if (c.combo === 'both') return 'convBoth';
    if (c.combo === 'stake' || c.combo === 'bet365') return 'convOne';
    return null;
  }
  // 歷史異常場：labels＝Map(officialId → { cls, hdFav })；回傳押讓分方 vs 另一邊（票）與讓分方直勝
  // 異常指向哪邊：雙方對調＝讓分方；只有一家＝另一邊
  function anomTarget(rule, hdFav) { return rule === 'convBoth' ? hdFav : hdFav === 'away' ? 'home' : 'away'; }
  // 這場的分析師有沒有撐異常指向的那邊：雙方對調＝那邊至少一人；只有一家＝那邊人數 ≥ 讓分方且至少一人
  function anomBacked(rule, hdFav, list) {
    const t = anomTarget(rule, hdFav);
    const nt = list.filter((p) => p.side === t).length; const nf = list.length - nt;
    return rule === 'convBoth' ? nt >= 1 : nt >= 1 && nt >= nf;
  }
  function anomalyRecord(annotated, labels, rule) {
    const fav = []; const other = []; const ids = new Set(); let favDir = 0; let dirN = 0;
    const backed = { n: 0, win: 0 }; const unbacked = { n: 0, win: 0 };
    for (const [id, list] of groupByGame(annotated)) {
      const lab = labels && labels.get(id);
      if (!lab || !lab.hdFav || anomRule(lab.cls) !== rule) continue;
      ids.add(id);
      for (const r of list) (r.side === lab.hdFav ? fav : other).push(r);
      const ref = list[0];
      const favWon = ref.side === lab.hdFav ? ref.direction : ({ win: 'loss', loss: 'win' }[ref.direction] || ref.direction);
      if (favWon === 'win' || favWon === 'loss') {
        dirN++; if (favWon === 'win') favDir++;
        const targetWon = rule === 'convBoth' ? favWon === 'win' : favWon === 'loss';
        const b = anomBacked(rule, lab.hdFav, list) ? backed : unbacked;
        b.n++; if (targetWon) b.win++;
      }
    }
    return { games: ids.size, fav: summarize(fav), other: summarize(other), favDir, dirN, backed, unbacked };
  }

  /* ---- NBA 讓分級距（移植 nba.html bbPlatformLine／bbMoveGroup；那邊改規則時這裡要跟著改） ---- */
  // rows＝[{ at, fav: 'away'|'home', line }]（只取開賽前）→ 開盤＝第一筆、收盤／現在＝最後一筆
  function lineMoveOf(rows) {
    const ok = (rows || []).filter((r) => (r.fav === 'away' || r.fav === 'home') && Number.isFinite(Number(r.line)))
      .slice().sort((a, b) => (Date.parse(a.at || '') || 0) - (Date.parse(b.at || '') || 0));
    if (!ok.length) return null;
    const o = ok[0]; const c = ok[ok.length - 1];
    return { openFav: o.fav, openLine: Math.abs(Number(o.line)), closeFav: c.fav, closeLine: Math.abs(Number(c.line)) };
  }
  function lineMoveGroup(p) {
    if (!p) return null;
    if (p.openFav !== p.closeFav) return 'swap';
    const d = p.closeLine - p.openLine;
    return d >= 2 ? 'deeper' : d <= -2 ? 'shallower' : 'small';
  }
  const LINE_GROUP_TXT = { deeper: '加深', small: '微調', shallower: '縮小', swap: '換邊' };
  // 歷史：labels＝Map(officialId → { group, fav })（fav＝Stake 收盤讓分方）
  function lineMoveRecord(annotated, labels) {
    const backed = { n: 0, win: 0 }; const unbacked = { n: 0, win: 0 }; const favML = []; const dogML = []; let games = 0;
    for (const [id, list] of groupByGame(annotated)) {
      const lab = labels && labels.get(id);
      if (!lab || !lab.fav) continue;
      for (const r of list) if (r.market === 'ML') (r.side === lab.fav ? (lab.group === 'deeper' ? favML : null) : dogML)?.push(r);
      if (lab.group !== 'deeper') continue;
      games++;
      const ref = list[0];
      const favWon = ref.side === lab.fav ? ref.direction : ({ win: 'loss', loss: 'win' }[ref.direction] || ref.direction);
      if (favWon !== 'win' && favWon !== 'loss') continue;
      const b = list.some((r) => r.side === lab.fav) ? backed : unbacked;
      b.n++; if (favWon === 'win') b.win++;
    }
    return { games, backed, unbacked, favML: summarize(favML), dogML: summarize(dogML) };
  }

  /* ---- 冰球：熱門讓分價 vs 冷門獨贏價 ---- */
  // snap＝{ ml:{away,home}, spread:{line,favorite,away,home} 或 spreads:[…] }（Stake 現價或收盤）→ 熱門、兩種價、是否「讓分價低於冷門獨贏」
  function priceSpot(snap) {
    if (!snap || !snap.ml) return null;
    const a = Number(snap.ml.away); const h = Number(snap.ml.home);
    if (!(a > 1 && h > 1) || a === h) return null;
    const fav = a < h ? 'away' : 'home';
    const raw = [].concat(snap.spread || [], snap.spreads || []).map((x) => x && orientSpread(x, snap.ml)).find((x) => x && x.favorite === fav);
    if (!raw) return null;
    const favHd = Number(raw[fav]); const line = Math.abs(Number(raw.line));
    if (!(favHd > 1) || !(line > 0)) return null;
    const favMl = fav === 'away' ? a : h; const dogMl = fav === 'away' ? h : a;
    return { fav, favMl, dogMl, favHd, favLine: -line, cheap: favHd < dogMl, gap: Math.round((dogMl - favHd) * 100) / 100 };
  }
  // 熱門那邊人數 ≥ 冷門那邊（且至少一人）＝有人撐
  function spotBacked(spot, list) {
    const nf = list.filter((p) => p.side === spot.fav).length;
    return nf >= 1 && nf >= list.length - nf;
  }
  // 歷史：games＝officialId → 比賽（closing＝收盤快照、awayScore/homeScore/final）；只算「讓分價低於冷門獨贏」的場
  function spotRecord(annotated, games) {
    const backed = { n: 0, win: 0, mlP: 0, cover: 0, hdP: 0 }; const unbacked = { n: 0, win: 0 };
    for (const [id, list] of groupByGame(annotated)) {
      const g = games && games[id];
      if (!g || !g.final || g.awayScore == null || g.homeScore == null) continue;
      const sp = priceSpot(g.closing);
      if (!sp || !sp.cheap) continue;
      const margin = (sp.fav === 'away' ? 1 : -1) * (Number(g.awayScore) - Number(g.homeScore));
      if (!spotBacked(sp, list)) { unbacked.n++; if (margin > 0) unbacked.win++; continue; }
      backed.n++;
      if (margin > 0) { backed.win++; backed.mlP += sp.favMl - 1; } else backed.mlP -= 1;
      if (margin + sp.favLine > 0) { backed.cover++; backed.hdP += sp.favHd - 1; } else backed.hdP -= 1;
    }
    const r = (p) => (backed.n ? Math.round((p / backed.n) * 1000) / 1000 : null);
    return { games: backed.n + unbacked.n, backed: Object.assign(backed, { mlRoi: r(backed.mlP), hdRoi: r(backed.hdP) }), unbacked };
  }

  // picks＝今天這場每人一張主帳票（已排除忽略名單）；ann＝同聯盟、到前一天為止的歷史（已排除忽略名單）
  // anomaly＝{ cls, hdFav } 或 null；anomRecs＝{ convBoth, convOne }（anomalyRecord 結果，可缺）
  // lineMove＝NBA 今天 Stake 開盤→現在 { openFav, openLine, closeFav, closeLine }（fav 為 'away'|'home'）；core＝null＝不設主跟（NBA）
  function adviseGame({ picks = [], core = 'BOOKIE', ann = [], anomaly = null, anomRecs = {}, lineMove = null, lineRec = null, spot = null, spotRec = null } = {}) {
    const sideOf = (s) => picks.filter((p) => p.side === s);
    const away = sideOf('away'); const home = sideOf('home');
    const corePick = picks.find((p) => p.analyst === core) || null;
    const ev = { anomaly: null, clash: null, h2h: null, counts: { away: away.length, home: home.length } };
    const out = (tier, side, reason, extra = {}) => Object.assign({ tier, side, reason, core, corePick,
      follow: side && corePick ? (corePick.side === side ? 'core' : 'against') : null, ev }, extra);
    const rule = anomaly ? anomRule(anomaly.cls) : null;
    if (anomaly && anomaly.cls) {
      ev.anomaly = { cls: anomaly.cls, label: anomLabel(anomaly.cls), hdFav: anomaly.hdFav || null, rule,
        record: rule ? anomRecs[rule] || null : null };
    }
    const lineGroup = lineMoveGroup(lineMove);
    if (lineGroup) ev.lineMove = Object.assign({ group: lineGroup, label: LINE_GROUP_TXT[lineGroup], fav: lineMove.closeFav, record: lineRec || null }, lineMove);
    if (lineGroup === 'deeper') {
      const fav = lineMove.closeFav;
      if (picks.some((p) => p.side === fav)) return out('bet', fav, `Stake 讓分加深 ${lineMove.openLine}→${lineMove.closeLine}、熱門有人推 → 押熱門獨贏`, { by: 'lineMove' });
      if (picks.length) return out('skip', null, '讓分加深指向熱門，但沒人推那邊 → 訊號相反', { by: 'lineMove' });
    }
    if (spot) ev.spot = Object.assign({ record: spotRec || null, backed: spotBacked(spot, picks) }, spot);
    if (rule === 'convBoth' && anomaly.hdFav) {
      if (anomBacked(rule, anomaly.hdFav, picks)) return out('bet', anomaly.hdFav, '收斂·雙方對調、讓分方有人推 → 押讓分方', { by: 'anomaly' });
      if (picks.length) return out('skip', null, '收斂·雙方對調指向讓分方，但沒人推那邊 → 訊號相反', { by: 'anomaly' });
    }

    const convOneOn = rule === 'convOne' && anomaly.hdFav && anomBacked(rule, anomaly.hdFav, picks);
    if (spot && spot.cheap && !convOneOn && spotBacked(spot, picks)) {
      return out('bet', spot.fav, `熱門讓分 ${spot.favHd} 比冷門獨贏 ${spot.dogMl} 低、熱門那邊人數不少 → 押熱門`, { by: 'spot' });
    }

    // 分析師規則
    let base = null;
    if (!away.length && !home.length) base = { tier: 'none', side: null, reason: '沒有人推' };
    else if (!away.length || !home.length) {
      const side = away.length ? 'away' : 'home'; const list = away.length ? away : home;
      if (corePick) base = { tier: 'bet', side, reason: list.length > 1 ? `${core} 等 ${list.length} 人同邊、沒人反對` : `只有 ${core} 推、沒人反對` };
      else if (list.length > 1) base = { tier: 'bet', side, reason: `${list.length} 人同邊、沒人反對${core ? `（${core} 沒推）` : ''}` };
      else base = { tier: 'small', side, reason: `只有 ${list[0].analyst} 推${core ? `（${core} 沒推）` : ''}` };
      // 同聯盟「同樣人數同邊、沒人反對」過去的報酬是負的 → 降成小注（例 NBA 4 人同邊 −12%）
      const agree = summarize(ann.filter((r) => r.ctx.oppCount === 0 && r.ctx.ownCount === list.length));
      ev.agree = { n: list.length, rec: agree };
      if (base.tier === 'bet' && agree.priced >= 10 && agree.roi < 0) {
        base.tier = 'small';
        base.reason += `；但過去 ${list.length} 人同邊沒人反對時報酬是負的`;
      }
    } else {
      const tie = away.length === home.length;
      if (corePick) {
        const mine = corePick.side === 'away' ? away : home; const theirs = corePick.side === 'away' ? home : away;
        const clash = groupClash(ann, mine.map((p) => p.analyst), theirs.map((p) => p.analyst));
        const h2h = headToHead(ann, core, theirs.map((p) => p.analyst));
        ev.clash = Object.assign({ mine: mine.map((p) => p.analyst), theirs: theirs.map((p) => p.analyst) }, clash);
        ev.h2h = Object.assign({ who: core, opps: theirs.map((p) => p.analyst) }, h2h);   // h2h.hero／h2h.opp＝兩邊的票統計
        const sg = edgeSign(clash.x, clash.y, clash.games); const sh = edgeSign(h2h.hero, h2h.opp, h2h.games);
        ev.signals = { clash: sg, h2h: sh };
        const s = sg + sh; const other = corePick.side === 'away' ? 'home' : 'away';
        if (s >= 1) base = { tier: 'bet', side: corePick.side, reason: sg && sh ? `兩組對上、${core} 單挑都挺 ${core}` : sg ? `兩組對上挺 ${core}` : `${core} 單挑對面較好` };
        else if (s === 0 && !sg && !sh) base = { tier: mine.length >= theirs.length ? 'bet' : 'small', side: corePick.side, reason: `對上紀錄不夠（< ${ADVICE_MIN_N} 場）或差不多，照跟 ${core}` };
        else if (s === 0) base = { tier: 'skip', side: null, reason: '兩組對上和單挑結論相反' };
        else if (s === -1) base = { tier: 'skip', side: null, reason: `證據不挺 ${core}` };
        else base = { tier: 'small', side: other, reason: `兩組對上、單挑都是對面較好` };
        if (tie && base.tier !== 'skip') {
          base.tier = base.tier === 'bet' ? 'small' : 'skip';
          if (base.tier === 'skip') base.side = null;
          base.reason += `（${away.length}:${home.length} 人數一樣，降一級）`;
        }
      } else {
        const clash = groupClash(ann, away.map((p) => p.analyst), home.map((p) => p.analyst));
        ev.clash = Object.assign({ mine: away.map((p) => p.analyst), theirs: home.map((p) => p.analyst), awayFirst: true }, clash);
        const sg = edgeSign(clash.x, clash.y, clash.games);
        ev.signals = { clash: sg, h2h: 0 };
        const who = core ? `${core} 沒推；` : '';
        base = sg ? { tier: 'small', side: sg > 0 ? 'away' : 'home', reason: `${who}兩組對上這邊較好` }
          : { tier: 'skip', side: null, reason: `${who}兩組對上分不出高下` };
      }
    }
    if (rule === 'convOne' && anomaly.hdFav && anomBacked(rule, anomaly.hdFav, picks)) {
      const other = anomTarget(rule, anomaly.hdFav);
      if (base.side === other && base.tier === 'bet') return out(base.tier, other, `${base.reason}；收斂·只有一家對調也指向這邊`, { by: 'both' });
      return out('small', other, '收斂·只有一家對調、另一邊人數不少 → 押另一邊（小注）', { by: 'anomaly', analystView: base });
    }
    return out(base.tier, base.side, base.reason, { by: 'analysts' });
  }

  // 建議的盤口：跟主跟的人＝他的盤口；否則用那邊最多人押的盤口；沒人押那邊＝ML（收斂·只有一家＝受讓）
  function advicePick(advice, picks, fallbackMarket) {
    if (!advice || !advice.side) return null;
    // 收斂·雙方對調：讓分方就是熱門，+1.5 是另開盤（賠率很低）→ 一律 ML（11/12 前 26 場：ML 74%、報酬 +36%）
    if (advice.by === 'anomaly' && advice.ev && advice.ev.anomaly && advice.ev.anomaly.rule === 'convBoth') return { market: 'ML', line: 0 };
    // 冰球價差：主推獨贏、附熱門 −1.5（兩種整季報酬差不多，獨贏起伏較小）
    if (advice.by === 'spot' && advice.ev && advice.ev.spot) return { market: 'ML', line: 0, alt: { market: 'SPREAD', line: advice.ev.spot.favLine } };
    // NBA 讓分加深：熱門會贏但常贏不夠讓分（讓方過盤 12/26）→ 一律獨贏
    if (advice.by === 'lineMove') return { market: 'ML', line: 0 };
    if (advice.corePick && advice.corePick.side === advice.side) return { market: advice.corePick.market, line: pickLine(advice.corePick) };
    const same = picks.filter((p) => p.side === advice.side);
    if (same.length) {
      const counts = new Map();
      for (const p of same) { const k = `${p.market}|${pickLine(p)}`; counts.set(k, (counts.get(k) || 0) + 1); }
      const [k] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const [market, line] = k.split('|');
      return { market, line: Number(line) };
    }
    return fallbackMarket || { market: 'ML', line: 0 };
  }

  // NBA：建議押的是冷門（Stake 現在的受讓方）獨贏 → 降一級
  function dogMlAdjust(advice, pick, lineMove) {
    if (!advice || !advice.side || !pick || pick.market !== 'ML' || !lineMove || !lineMove.closeFav || advice.side === lineMove.closeFav) return advice;
    const tier = advice.tier === 'bet' ? 'small' : 'skip';
    return Object.assign({}, advice, { tier, side: tier === 'skip' ? null : advice.side, dogMl: true,
      reason: `${advice.reason}；押冷門獨贏，降一級` });
  }

  return {
    lineMoveOf, lineMoveGroup, lineMoveRecord, dogMlAdjust, LINE_GROUP_TXT, priceSpot, spotBacked, spotRecord,
    groupClash, headToHead, edgeSign, adviseGame, advicePick, anomClassify, anomEvidenceFromSnap, anomBestSnap, anomSnapScore,
    anomLabel, anomRule, anomalyRecord, anomTarget, anomBacked, ADVICE_MIN_N,
    ANALYSTS, WATCH, REVISERS, LAYERS, SCENARIOS: Object.keys(SCENARIOS), sideIndex, duel, marketKind,
    pickKey, pickLine, mergePicks, livePicks, settlePick, priceQuote, priceFrom, priceFor, relationToCard,
    buildLedger, summarize, filterRows, annotateContexts, inScenario, scenarioStats, pairMatrix, comboBoard,
  };
});
