(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.install(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const EMPTY_HISTORY = Object.freeze({ stakeBySid: {}, bet365Taiwan: [] });

  function lookupStakeNrfi(history, sid) {
    if (!sid || !history || !history.stakeBySid) return null;
    return history.stakeBySid[sid] || null;
  }

  function bucket() {
    return { n: 0, fw: 0, fwN: 0, cov: 0, covN: 0, ov: 0, ovN: 0, nr: 0, nrN: 0, games: [] };
  }

  function relationKey(value) {
    return value === '顛倒' ? 'inverted' : value === '收斂' ? 'converged' : null;
  }

  function addGame(target, game) {
    target.n += 1;
    target.games.push(game);
    if (typeof game.mlFavoriteWin === 'boolean') {
      target.fwN += 1;
      if (game.mlFavoriteWin) target.fw += 1;
    }
    if (game.handicapResult === 'cover') {
      target.covN += 1;
      target.cov += 1;
    } else if (game.handicapResult === 'nocover') target.covN += 1;
    if (game.totalResult === 'over') {
      target.ovN += 1;
      target.ov += 1;
    } else if (game.totalResult === 'under') target.ovN += 1;
    if (typeof game.nrfi === 'boolean') {
      target.nrN += 1;
      if (game.nrfi) target.nr += 1;
    }
  }

  function makeGroups() {
    return {
      inverted: { all: bucket(), neither: bucket(), taiwan_only: bucket(), bet365_only: bucket(), both: bucket() },
      converged: { all: bucket(), taiwan_only: bucket(), bet365_only: bucket(), both: bucket() },
    };
  }

  function classifyBet365TaiwanEvidence(evidence) {
    const value = evidence || {};
    const relation = value.relationCode === 'flip' ? '顛倒' : value.relationCode === 'was' ? '收斂' : null;
    if (!relation) return null;
    const bet365Swapped = !!value.bet365Swapped;
    const taiwanSwapped = !!value.taiwanSwapped;
    if (relation === '收斂' && !bet365Swapped && !taiwanSwapped) return null;
    const swapCombo = bet365Swapped && taiwanSwapped ? 'both'
      : bet365Swapped ? 'bet365_only' : taiwanSwapped ? 'taiwan_only' : 'neither';
    return {
      relation, swapCombo, bet365Swapped, taiwanSwapped,
      bet365Side: value.bet365Side || null,
      taiwanSide: value.taiwanSide || null,
    };
  }

  function buildBet365TaiwanSnapshot(intlState, verdict) {
    const state = intlState || {};
    const current = verdict || {};
    const betExplorer = current.be || null;
    const latchedBet365Swap = current.v === 'was' && !!state.eo
      && Number(state.lsw || 0) === 0;
    const titanBet365Swap = Number(state.sw || 0) > 0 || latchedBet365Swap;
    const betExplorerSwap = !!(betExplorer && betExplorer.flipEver);
    const classified = classifyBet365TaiwanEvidence({
      relationCode: current.v,
      // BetExplorer 的單一事件列可能缺少早先的變盤歷史；Titan 的 sw/eo 是永久鎖存證據。
      // 兩者是證據聯集，不能因 BetExplorer 有列但 flipEver=false 就把 Titan 歷史抹掉。
      bet365Swapped: betExplorerSwap || titanBet365Swap,
      taiwanSwapped: Number(state.lsw || 0) > 0,
      bet365Side: current.side || state.is || null,
      taiwanSide: state.ls || null,
    });
    if (!classified) return null;
    return Object.assign(classified, {
      bet365Line: current.line == null ? (state.il == null ? null : state.il) : current.line,
      taiwanLine: state.ll == null ? null : state.ll,
      bet365SwitchCount: Math.max(
        betExplorerSwap ? Math.max(1, (betExplorer.struck || []).length) : 0,
        Number(state.sw || 0),
        latchedBet365Swap ? 1 : 0,
      ),
      taiwanSwitchCount: Number(state.lsw || 0),
      evidenceSource: betExplorer
        ? (titanBet365Swap ? 'betexplorer+titan+playsport' : 'betexplorer+playsport')
        : 'titan+playsport',
      evidenceAt: state.u || (betExplorer && betExplorer.at) || null,
    });
  }

  function backfillBet365TaiwanSnapshots(games, verdictFor, intlStateFor) {
    if (!Array.isArray(games) || typeof verdictFor !== 'function') return 0;
    let changed = 0;
    games.forEach(function (game) {
      if (!game || game.bet365Taiwan) return;
      const resolvedState = typeof intlStateFor === 'function' ? intlStateFor(game) : null;
      const state = resolvedState || game.intlState;
      if (!state) return;
      const verdict = verdictFor(game, state);
      if (!verdict) return;
      const snapshot = buildBet365TaiwanSnapshot(state, verdict);
      if (!snapshot) return;
      if (!game.intlState) game.intlState = state;
      game.bet365Taiwan = snapshot;
      changed += 1;
    });
    return changed;
  }

  function resolveSettlementOfficialId(select, card) {
    const fromMatch = select && select.dataset && select.dataset.officialId;
    return fromMatch || (card && card.settled && card.settled.officialId) || (card && card.officialId) || null;
  }

  function settledGameToBet365TaiwanRow(game) {
    if (!game || !game.bet365Taiwan || !relationKey(game.bet365Taiwan.relation)) return null;
    const evidence = game.bet365Taiwan;
    let awayOdd = game.closeOddsAway, homeOdd = game.closeOddsHome;
    if (!(Number.isFinite(awayOdd) && Number.isFinite(homeOdd))) {
      awayOdd = game.flipOddsAway; homeOdd = game.flipOddsHome;
    }
    const mlFavorite = Number.isFinite(awayOdd) && Number.isFinite(homeOdd) && awayOdd !== homeOdd
      ? (awayOdd < homeOdd ? 'away' : 'home') : null;
    const winner = game.awayScore === game.homeScore ? null : (game.awayScore > game.homeScore ? 'away' : 'home');
    const nrfi = game.nrfiStatus === 'nrfi' ? true : game.nrfiStatus === 'yrfi' ? false : null;
    return Object.assign({}, evidence, {
      alertKey: game.officialId || game.sid || null,
      officialId: game.officialId || null,
      sid: game.sid || null,
      league: game.league,
      date: game.date,
      gameTime: game.gameTime || null,
      away: game.awayTeam,
      home: game.homeTeam,
      aScore: game.awayScore,
      hScore: game.homeScore,
      mlFavorite,
      mlFavoriteWin: mlFavorite && winner ? mlFavorite === winner : null,
      stakeAwayOdd: Number.isFinite(awayOdd) ? awayOdd : null,
      stakeHomeOdd: Number.isFinite(homeOdd) ? homeOdd : null,
      handicapFavorite: game.hdFav || null,
      handicapLine: game.hdVal == null ? null : game.hdVal,
      handicapResult: game.hdResult === 'fav_cover' ? 'cover' : game.hdResult === 'fav_nocover' ? 'nocover' : null,
      totalLine: game.totVal == null ? null : game.totVal,
      totalResult: game.totResult === 'over' || game.totResult === 'under' ? game.totResult : null,
      nrfi,
      nrfiStatus: game.nrfiStatus || 'pending',
      nrfiSource: game.nrfiSource || null,
      awayFirst: game.awayFirst == null ? null : game.awayFirst,
      homeFirst: game.homeFirst == null ? null : game.homeFirst,
      eventStatus: game.nrfiStatus === 'canceled' ? 'canceled' : null,
    });
  }

  function rowKey(game) {
    if (game.officialId) return `official:${game.officialId}`;
    if (game.alertKey) return `alert:${game.alertKey}`;
    return ['fallback', game.league, game.date, game.away || game.awayTeam, game.home || game.homeTeam, game.gameTime || ''].join('|');
  }

  function unionRows(history, settledGames) {
    const merged = new Map();
    const historical = history && Array.isArray(history.bet365Taiwan) ? history.bet365Taiwan : [];
    historical.forEach((game) => merged.set(rowKey(game), game));
    (Array.isArray(settledGames) ? settledGames : []).forEach((game) => {
      const row = settledGameToBet365TaiwanRow(game);
      if (row) merged.set(rowKey(row), row);
    });
    return [...merged.values()];
  }

  function collectBet365Taiwan(history, leagueFilter, settledGames) {
    const groups = makeGroups();
    const rows = unionRows(history, settledGames);
    let total = 0;
    rows.forEach((game) => {
      if (leagueFilter && leagueFilter !== 'all' && String(game.league || '').toLowerCase() !== String(leagueFilter).toLowerCase()) return;
      const rel = relationKey(game.relation);
      if (!rel || !Object.prototype.hasOwnProperty.call(groups[rel], game.swapCombo)) return;
      total += 1;
      addGame(groups[rel].all, game);
      addGame(groups[rel][game.swapCombo], game);
    });
    return { groups, total };
  }

  function pc(hit, total) {
    return total ? `${Math.round((100 * hit) / total)}%` : '—';
  }

  const RECOMMENDATION_MARKETS = Object.freeze([
    { market: 'ml', label: '獨贏', hitKey: 'fw', totalKey: 'fwN', positive: 'favorite', negative: 'underdog' },
    { market: 'hd', label: '讓分', hitKey: 'cov', totalKey: 'covN', positive: 'favorite', negative: 'underdog' },
    { market: 'ou', label: '大小', hitKey: 'ov', totalKey: 'ovN', positive: 'over', negative: 'under' },
    { market: 'nrfi', label: '首局', hitKey: 'nr', totalKey: 'nrN', positive: 'nrfi', negative: 'yrfi' },
  ]);

  // 單尾 80% Wilson 下界：避免把小樣本的表面高命中率直接當成真實機率。
  // 下注價另加 5% 安全邊際；兩套系統樣本重疊時取較保守者，不疊加樣本。
  function wilsonLower(hit, total, z) {
    const n = Number(total);
    const wins = Number(hit);
    const score = Number.isFinite(Number(z)) ? Number(z) : 0.84;
    if (!(n > 0) || !Number.isFinite(wins)) return null;
    const p = Math.max(0, Math.min(n, wins)) / n;
    const z2 = score * score;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const spread = score * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n)) / denom;
    return Math.max(0, center - spread);
  }

  function roundUpHundredth(value) {
    return Number.isFinite(value) ? Math.ceil((value - Number.EPSILON) * 100) / 100 : null;
  }

  function marketSide(game, market, direction) {
    const value = game || {};
    let favorite = value.favorite === 'home' ? 'home' : 'away';
    if (market === 'ml') {
      if (value.moneylineFavorite === 'home' || value.moneylineFavorite === 'away') favorite = value.moneylineFavorite;
      const away = Number(value.moneyline && value.moneyline.away);
      const home = Number(value.moneyline && value.moneyline.home);
      if (Number.isFinite(away) && Number.isFinite(home) && away !== home) favorite = away < home ? 'away' : 'home';
    }
    if (market === 'ml' || market === 'hd') {
      return direction === 'favorite' ? favorite : (favorite === 'away' ? 'home' : 'away');
    }
    return direction;
  }

  function marketPresentation(game, market, direction) {
    const value = game || {};
    const side = marketSide(value, market, direction);
    if (market === 'ml') {
      const offered = value.moneyline && value.moneyline[side];
      return {
        pickKey: side,
        pickLabel: `${side === 'away' ? value.away : value.home} 獨贏`,
        currentOdds: offered != null && Number.isFinite(Number(offered)) ? Number(offered) : null,
      };
    }
    if (market === 'hd') {
      const line = Number.isFinite(Number(value.line)) ? Number(value.line) : 1.5;
      const isFavorite = side === value.favorite;
      const offered = value.handicapOdds && value.handicapOdds[side];
      return {
        pickKey: side,
        pickLabel: `${side === 'away' ? value.away : value.home} ${isFavorite ? '-' : '+'}${line}`,
        currentOdds: offered != null && Number.isFinite(Number(offered)) ? Number(offered) : null,
      };
    }
    if (market === 'ou') {
      const line = value.totalLine == null ? (value.total && value.total.line) : value.totalLine;
      const offered = value.total && value.total[direction];
      return {
        pickKey: direction,
        pickLabel: `${direction === 'over' ? '大' : '小'} ${line == null ? '—' : line}`,
        currentOdds: offered != null && Number.isFinite(Number(offered)) ? Number(offered) : null,
      };
    }
    return { pickKey: direction, pickLabel: direction === 'nrfi' ? 'NRFI' : 'YRFI', currentOdds: null };
  }

  function sourceSignal(source, definition) {
    const item = source || {};
    const data = item.bucket || {};
    const total = Number(data[definition.totalKey]) || 0;
    const positiveHits = Number(data[definition.hitKey]) || 0;
    if (total < 15) return null;
    const positiveRate = positiveHits / total;
    if (positiveRate === 0.5) return null;
    const isPositive = positiveRate > 0.5;
    const hits = isPositive ? positiveHits : total - positiveHits;
    return {
      id: item.id || '',
      label: item.label || item.id || '異常統計',
      direction: isPositive ? definition.positive : definition.negative,
      sample: total,
      hit: hits,
      rawRate: hits / total,
      // 樣本可靠度已由 15/30/60 場分級處理；價格直接用歷史命中率，避免再做一次保守折減。
      estimatedRate: hits / total,
      tier: total >= 60 ? 'stable' : total >= 30 ? 'ready' : 'observe',
      category: item.category || '',
      leagueLabel: item.leagueLabel || '',
    };
  }

  function emptyMarket(definition) {
    return {
      market: definition.market, marketLabel: definition.label, status: 'no_data',
      pickKey: null, pickLabel: '樣本不足', currentOdds: null, minOdds: null,
      edgePct: null, estimatedRate: null, sample: 0, sourceMode: 'none', evidence: [],
    };
  }

  function buildMarketRecommendation(game, sources, definition, margin) {
    const signals = (Array.isArray(sources) ? sources : []).map((source) => sourceSignal(source, definition)).filter(Boolean);
    if (!signals.length) return emptyMarket(definition);
    const ready = signals.filter((signal) => signal.tier !== 'observe');
    const selected = ready.length ? ready : signals;
    const directions = new Set(selected.map((signal) => signal.direction));
    if (directions.size !== 1) {
      return Object.assign(emptyMarket(definition), {
        status: 'conflict', pickLabel: '兩套方向分歧', sourceMode: 'conflict',
        sample: Math.min(...selected.map((signal) => signal.sample)), evidence: selected,
      });
    }
    const direction = selected[0].direction;
    const presentation = marketPresentation(game, definition.market, direction);
    const estimatedRate = Math.min(...selected.map((signal) => signal.estimatedRate));
    const minOdds = estimatedRate > 0 ? roundUpHundredth((1 + margin) / estimatedRate) : null;
    const observationOnly = !ready.length;
    let status = observationOnly ? 'observe' : 'direction';
    let edgePct = null;
    if (!observationOnly && presentation.currentOdds != null && minOdds != null) {
      edgePct = (presentation.currentOdds * estimatedRate - 1) * 100;
      status = presentation.currentOdds >= minOdds ? 'bet' : 'wait';
    }
    return {
      market: definition.market,
      marketLabel: definition.label,
      direction,
      pickKey: presentation.pickKey,
      pickLabel: presentation.pickLabel,
      currentOdds: presentation.currentOdds,
      minOdds,
      edgePct,
      estimatedRate,
      sample: Math.min(...selected.map((signal) => signal.sample)),
      sourceMode: selected.length > 1 ? 'consensus' : 'single',
      status,
      evidence: selected,
    };
  }

  function buildAnomalyRecommendation(options) {
    const opts = options || {};
    const margin = Number.isFinite(Number(opts.margin)) ? Number(opts.margin) : 0.03;
    const markets = RECOMMENDATION_MARKETS.map((definition) => (
      buildMarketRecommendation(opts.game || {}, opts.sources || [], definition, margin)
    ));
    const rank = { bet: 0, wait: 1, direction: 2, observe: 3, conflict: 4, no_data: 5 };
    const summary = markets.filter((market) => market.status !== 'no_data').slice().sort((a, b) => {
      const byStatus = rank[a.status] - rank[b.status];
      if (byStatus) return byStatus;
      return (b.edgePct == null ? -Infinity : b.edgePct) - (a.edgePct == null ? -Infinity : a.edgePct);
    }).slice(0, 2);
    const hasConsensus = markets.some((market) => market.sourceMode === 'consensus');
    const hasConflict = markets.some((market) => market.status === 'conflict');
    const contexts = (Array.isArray(opts.sources) ? opts.sources : []).map((source) => {
      const data = source && source.bucket || {};
      const sample = Number(data.n) || Math.max(
        Number(data.fwN) || 0, Number(data.covN) || 0,
        Number(data.ovN) || 0, Number(data.nrN) || 0,
      );
      return {
        id: source.id || '', label: source.label || source.id || '異常統計',
        leagueLabel: source.leagueLabel || '', category: source.category || '', sample,
      };
    });
    return { markets, summary, hasConsensus, hasConflict, margin, contexts };
  }

  function fixedOdds(value) {
    return value == null ? '—' : Number(value).toFixed(2);
  }

  function verdictText(market) {
    if (market.status === 'bet') return '已到價';
    if (market.status === 'wait') return '未到價';
    if (market.status === 'direction') return '只看方向';
    if (market.status === 'observe') return '樣本觀察';
    if (market.status === 'conflict') return '不下注';
    return '暫無建議';
  }

  function appendPick(documentRef, parent, market, className) {
    const row = documentRef.createElement('div');
    row.className = `${className} ${market.status}`;
    row.dataset.market = market.market;
    const marketLabel = documentRef.createElement('span');
    marketLabel.className = 'anom-market';
    marketLabel.textContent = market.marketLabel;
    const choice = documentRef.createElement('strong');
    choice.className = 'anom-choice';
    choice.textContent = market.pickLabel;
    const price = documentRef.createElement('span');
    price.className = 'anom-price';
    if (market.market === 'nrfi') price.textContent = '';
    else if (market.minOdds != null) price.textContent = `${market.status === 'observe' ? '參考' : '門檻'} ${fixedOdds(market.minOdds)}${market.currentOdds == null ? '' : `／Stake ${fixedOdds(market.currentOdds)}`}`;
    else price.textContent = '—';
    const verdict = documentRef.createElement('span');
    verdict.className = 'anom-verdict';
    verdict.textContent = verdictText(market);
    row.append(marketLabel, choice, price, verdict);
    parent.appendChild(row);
    return row;
  }

  function renderAnomalyRecommendation(decision, documentRef) {
    if (!decision || !documentRef) return null;
    const root = documentRef.createElement('section');
    root.className = `anom-decision${decision.hasConflict ? ' has-conflict' : ''}`;
    const toggle = documentRef.createElement('button');
    toggle.type = 'button';
    toggle.className = 'anom-decision-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.title = '展開四個市場與兩套異常統計證據';
    const title = documentRef.createElement('span');
    title.className = 'anom-decision-title';
    title.textContent = '異常投注參考';
    const mode = documentRef.createElement('span');
    mode.className = 'anom-decision-mode';
    mode.textContent = decision.hasConflict ? '方向分歧' : decision.hasConsensus ? '兩套一致' : '單一系統';
    const caret = documentRef.createElement('span');
    caret.className = 'anom-decision-caret';
    caret.textContent = '⌄';
    toggle.append(title, mode, caret);
    root.appendChild(toggle);

    const context = documentRef.createElement('div');
    context.className = 'anom-context';
    (decision.contexts || []).forEach((item) => {
      const line = documentRef.createElement('div');
      line.className = 'anom-context-row';
      const source = documentRef.createElement('span');
      source.className = 'anom-context-source';
      source.textContent = item.label;
      const value = documentRef.createElement('span');
      value.className = 'anom-context-value';
      value.textContent = [item.leagueLabel, item.category].filter(Boolean).join('・') + (item.sample ? `・${item.sample} 場` : '');
      line.append(source, value);
      context.appendChild(line);
    });
    if (context.childNodes.length) root.appendChild(context);

    const summary = documentRef.createElement('div');
    summary.className = 'anom-picks';
    if (decision.summary.length) decision.summary.forEach((market) => appendPick(documentRef, summary, market, 'anom-pick'));
    else {
      const empty = documentRef.createElement('div');
      empty.className = 'anom-pick no_data';
      empty.textContent = '有效樣本未滿 15 場，暫不提供方向';
      summary.appendChild(empty);
    }
    root.appendChild(summary);

    const detail = documentRef.createElement('div');
    detail.className = 'anom-decision-detail';
    detail.hidden = true;
    decision.markets.forEach((market) => {
      const row = appendPick(documentRef, detail, market, 'anom-detail-row');
      if (market.evidence.length) {
        const evidence = documentRef.createElement('small');
        evidence.className = 'anom-evidence';
        evidence.textContent = `${market.estimatedRate == null ? '' : `計算${Math.round(market.estimatedRate * 100)}%｜`}${market.evidence.map((item) => (
          `${item.label} ${Math.round(item.rawRate * 100)}%（${item.hit}/${item.sample}）`
        )).join('｜')}`;
        row.appendChild(evidence);
      }
    });
    root.appendChild(detail);
    toggle.onclick = function (event) {
      event.stopPropagation();
      detail.hidden = !detail.hidden;
      toggle.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true');
      root.classList.toggle('open', !detail.hidden);
    };
    return root;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function detailRole(game) {
    const hot = game.mlFavoriteWin === true ? '<b>熱門勝</b>' : game.mlFavoriteWin === false ? '冷門勝' : '熱門不明';
    const hd = game.handicapResult === 'cover' ? '<span class="dr-hit">過盤</span>'
      : game.handicapResult === 'nocover' ? '<span class="dr-miss">沒過</span>' : '—';
    const total = game.totalResult === 'over' ? '大' : game.totalResult === 'under' ? '小' : '—';
    let first = '首局—';
    if (game.eventStatus === 'canceled') {
      first = `官方取消（${esc(game.officialSourceLabel || '官網')}確認，NRFI 不計）`;
    } else if (game.awayFirst != null && game.homeFirst != null) {
      const official = game.officialSourceLabel ? `・${esc(game.officialSourceLabel)}補` : '';
      first = `${game.nrfi ? 'NRFI' : 'YRFI'}（首局 ${esc(game.awayFirst)}-${esc(game.homeFirst)}）${official}`;
    } else if (game.nrfiStatus === 'nrfi' || game.nrfiStatus === 'yrfi') {
      first = `${game.nrfiStatus === 'nrfi' ? 'NRFI' : 'YRFI'}（${game.nrfiSource === 'manual' ? '手動' : '自動'}）`;
    } else if (game.nrfiStatus === 'pending') {
      first = '首局待補';
    }
    return `${hot}・讓分${hd}・開${total}・${first}`;
  }

  function renderBet365TaiwanSection(leagueFilter, history, helpers) {
    const opts = helpers || {};
    const drillBlock = typeof opts.drillBlock === 'function' ? opts.drillBlock : () => ({ id: '', html: '' });
    const today = opts.today || '';
    const collected = collectBet365Taiwan(history, leagueFilter || 'all', opts.settledGames);
    const groups = collected.groups;

    function row(label, item) {
      if (!item.n) {
        return `<tr class="rv-row"><td class="lbl" style="color:var(--ink-dim)">${label}</td><td>0</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
      }
      const detail = drillBlock(item.games, detailRole);
      const hasToday = item.games.some((game) => game.date === today);
      let html = `<tr class="rv-row drill-toggle"${detail.id ? ` onclick="toggleDrillById('${detail.id}',this)" style="cursor:pointer"` : ''}>`
        + `<td class="lbl">${label}${hasToday ? ' <span class="rv-alert-mk">❗</span>' : ''}</td><td>${item.n}</td>`
        + `<td>${pc(item.fw, item.fwN)} <span class="rv-samp">${item.fw}/${item.fwN}</span></td>`
        + `<td>${pc(item.cov, item.covN)} <span class="rv-samp">${item.cov}/${item.covN}</span></td>`
        + `<td>${pc(item.ov, item.ovN)} <span class="rv-samp">${item.ov}/${item.ovN}</span></td>`
        + `<td>${pc(item.nr, item.nrN)} <span class="rv-samp">${item.nr}/${item.nrN}</span></td></tr>`;
      if (detail.id) html += `<tr class="drill-tr"><td colspan="6" style="padding:0">${detail.html}</td></tr>`;
      return html;
    }

    function groupTable(title, group, definitions) {
      const all = group.all;
      let html = `<div class="rv-head" style="font-size:14px;margin-top:14px">${title}　<span class="rv-sub">${all.n} 場　熱門勝 ${pc(all.fw, all.fwN)}・讓分過盤 ${pc(all.cov, all.covN)}・開大 ${pc(all.ov, all.ovN)}・NRFI ${pc(all.nr, all.nrN)}</span></div>`;
      html += '<table class="rv-table"><thead><tr><th class="lbl">組合</th><th>場數</th><th>熱門勝</th><th>讓分過盤</th><th>開大</th><th>NRFI</th></tr></thead><tbody>';
      definitions.forEach(([key, label]) => { html += row(label, group[key]); });
      return `${html}</tbody></table>`;
    }

    let html = '<div class="rv-section" id="bet365TaiwanAnomalyStats">'
      + '<div class="rv-head">◆ Bet365 × 台彩七類 <span class="rv-sub">顛倒／收斂 × Stake 三市場＋NRFI</span></div>'
      + '<div style="font-size:12px;color:var(--ink-dim);line-height:1.7;margin:6px 0 10px">熱門、讓分線、大小分線與賽果皆以 Stake 結算紀錄為準；NRFI＝兩隊首局皆未得分。點任一列可核對逐場分類與首局比分。</div>';
    if (!collected.total) {
      html += '<div class="rv-empty">這個聯盟目前沒有 Bet365 × 台彩異常歷史場。</div>';
    } else {
      html += groupTable('顛倒', groups.inverted, [
        ['neither', '雙方未對調'], ['taiwan_only', '台彩對調'], ['bet365_only', 'Bet365 對調'], ['both', '雙方都對調'],
      ]);
      html += groupTable('收斂', groups.converged, [
        ['taiwan_only', '台彩對調'], ['bet365_only', 'Bet365 對調'], ['both', '雙方都對調'],
      ]);
    }
    return `${html}</div>`;
  }

  function install(browser) {
    const target = browser || {};
    target.anomalyNrfiHistory = target.anomalyNrfiHistory || EMPTY_HISTORY;
    target.lookupStakeNrfi = (sid) => lookupStakeNrfi(target.anomalyNrfiHistory, sid);
    target.buildBet365TaiwanSnapshot = buildBet365TaiwanSnapshot;
    target.backfillBet365TaiwanSnapshots = backfillBet365TaiwanSnapshots;
    target.resolveSettlementOfficialId = resolveSettlementOfficialId;
    target.collectBet365Taiwan = (league, settledGames) => collectBet365Taiwan(target.anomalyNrfiHistory, league, settledGames);
    target.renderBet365TaiwanSection = (league, helpers) => renderBet365TaiwanSection(league, target.anomalyNrfiHistory, helpers);
    target.buildAnomalyRecommendation = buildAnomalyRecommendation;
    target.renderAnomalyRecommendation = (decision) => renderAnomalyRecommendation(decision, target.document);

    if (typeof target.fetch !== 'function') {
      target.ANOMALY_NRFI_READY = Promise.resolve(target.anomalyNrfiHistory);
      return target;
    }
    target.ANOMALY_NRFI_READY = target.fetch('./data/anomaly_nrfi_history.json?v=20260823nrfi2', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((history) => {
        target.anomalyNrfiHistory = history;
        if (typeof target.render === 'function') target.render();
        const page = target.document && target.document.getElementById('reviewpage');
        if (page && page.classList && page.classList.contains('show') && typeof target.renderReviewPage === 'function') target.renderReviewPage();
        return history;
      })
      .catch((error) => {
        if (target.console && typeof target.console.warn === 'function') target.console.warn('NRFI 歷史資料載入失敗', error);
        return target.anomalyNrfiHistory;
      });
    return target;
  }

  return {
    lookupStakeNrfi, classifyBet365TaiwanEvidence, buildBet365TaiwanSnapshot, backfillBet365TaiwanSnapshots, resolveSettlementOfficialId, settledGameToBet365TaiwanRow,
    collectBet365Taiwan, renderBet365TaiwanSection, buildAnomalyRecommendation, renderAnomalyRecommendation, wilsonLower, install, detailRole,
  };
});
