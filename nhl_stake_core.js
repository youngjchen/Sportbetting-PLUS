(function initNhlStake(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NhlStake = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildNhlStake() {
  'use strict';

  const MATCH_TOLERANCE_MS = 12 * 60 * 60 * 1000;
  const FEED_FRESH_MS = 30 * 60 * 1000;

  function numberOrNaN(value) {
    return value == null || value === '' ? NaN : Number(value);
  }

  function cardStartMs(pregame) {
    const date = String(pregame && pregame.date || '').slice(0, 10);
    const time = String(pregame && (pregame.time || pregame.gameTime) || '').slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return NaN;
    return Date.parse(`${date}T${time.padStart(5, '0')}:00+08:00`);
  }

  function gameStartMs(game) {
    const direct = Date.parse(String(game && game.startISO || ''));
    if (Number.isFinite(direct)) return direct;
    return cardStartMs({ date: game && game.date, time: game && game.startTime });
  }

  function isFeedFresh(feed, nowMs = Date.now(), maxAgeMs = FEED_FRESH_MS) {
    const updatedMs = Date.parse(String(feed && (feed.updated || feed.updatedAt) || ''));
    return Number.isFinite(updatedMs) && Number.isFinite(Number(nowMs)) &&
      Number(nowMs) - updatedMs <= maxAgeMs && updatedMs - Number(nowMs) <= 5 * 60 * 1000;
  }

  function historyOutcome(hd, side) {
    const direct = numberOrNaN(hd && hd[side]);
    if (Number.isFinite(direct)) return direct;
    const row = (hd && Array.isArray(hd.outcomes) ? hd.outcomes : []).find((item) => item && item.side === side);
    const odds = numberOrNaN(row && row.odds);
    return Number.isFinite(odds) ? odds : null;
  }

  function historyFavorite(hd) {
    if (hd && (hd.favSide === 'away' || hd.favSide === 'home')) return hd.favSide;
    if (hd && (hd.favorite === 'away' || hd.favorite === 'home')) return hd.favorite;
    const negative = (hd && Array.isArray(hd.outcomes) ? hd.outcomes : [])
      .find((item) => item && (item.side === 'away' || item.side === 'home') && Number(item.line) < 0);
    return negative ? negative.side : null;
  }

  function normalizedHistory(match) {
    const game = match && match.game || {};
    let source = Array.isArray(game.history) ? game.history : [];
    if (!source.length) {
      const fallbackHd = game.hd || (match && match.hd);
      if (fallbackHd) source = [{ at: fallbackHd.at || match.updated || null, hd: fallbackHd }];
    }
    const rows = source.map((entry) => {
      const hd = entry && entry.hd;
      const favorite = historyFavorite(hd);
      const line = Math.abs(numberOrNaN(hd && hd.line));
      if (!favorite || !Number.isFinite(line)) return null;
      return {
        at: String(entry.at || hd.at || ''),
        favorite,
        line,
        awayOdds: historyOutcome(hd, 'away'),
        homeOdds: historyOutcome(hd, 'home'),
      };
    }).filter(Boolean).sort((a, b) => {
      const am = Date.parse(a.at), bm = Date.parse(b.at);
      return (Number.isFinite(am) ? am : 0) - (Number.isFinite(bm) ? bm : 0);
    });
    const compressed = [];
    for (const row of rows) {
      const prior = compressed[compressed.length - 1];
      const signature = `${row.favorite}|${row.line}|${row.awayOdds}|${row.homeOdds}`;
      if (prior && prior._signature === signature) continue;
      compressed.push({ ...row, _signature: signature });
    }
    let swapCount = 0;
    for (let i = 1; i < compressed.length; i += 1) {
      if (compressed[i - 1].favorite !== compressed[i].favorite) swapCount += 1;
    }
    return {
      rows: compressed.map(({ _signature, ...row }) => row),
      swapCount,
    };
  }

  function summarizeHandicapHistory(stakeMatch, bet365Match) {
    const stake = normalizedHistory(stakeMatch);
    const bet365 = normalizedHistory(bet365Match);
    const timeline = [
      ...stake.rows.map((row) => ({ ...row, source: 'STAKE' })),
      ...bet365.rows.map((row) => ({ ...row, source: 'BET365' })),
    ].sort((a, b) => {
      const am = Date.parse(a.at), bm = Date.parse(b.at);
      return (Number.isFinite(am) ? am : 0) - (Number.isFinite(bm) ? bm : 0) ||
        (a.source === 'STAKE' ? -1 : 1);
    });
    const current = { STAKE: null, BET365: null };
    const relationTransitions = [];
    let relation = null;
    let everDiverged = false;
    for (const row of timeline) {
      current[row.source] = row.favorite;
      if (!current.STAKE || !current.BET365) continue;
      const next = current.STAKE === current.BET365 ? 'aligned' : 'diverged';
      if (next === 'diverged') everDiverged = true;
      if (relation && next !== relation) {
        relationTransitions.push({ at: row.at, source: row.source, relation: next });
      }
      relation = next;
    }
    let classification = 'none';
    if (relation === 'diverged') classification = 'flipped';
    else if (relation === 'aligned' && everDiverged) {
      if (stake.swapCount > 0 && bet365.swapCount > 0) classification = 'converged_both';
      else if (stake.swapCount > 0) classification = 'converged_stake';
      else if (bet365.swapCount > 0) classification = 'converged_bet365';
      else classification = 'converged_unknown';
    }
    return {
      stake,
      bet365,
      relationTransitions,
      currentRelation: relation,
      classification,
    };
  }

  function marketSnapshot(game, market, phase) {
    const value = game && game.markets && game.markets[market];
    if (!value || typeof value !== 'object') return null;
    if (phase) return value[phase] && typeof value[phase] === 'object' ? value[phase] : null;
    return value.active || value.close || value.open || null;
  }

  function findStakeGame(feed, pregame, toleranceMs = MATCH_TOLERANCE_MS) {
    const targetMs = cardStartMs(pregame);
    if (!Number.isFinite(targetMs)) return null;
    const rows = Object.values(feed && feed.games || {}).filter((game) => (
      game && String(game.league || '').toLowerCase() === 'nhl' &&
      game.awayTeam === pregame.away && game.homeTeam === pregame.home &&
      Number.isFinite(gameStartMs(game))
    ));
    rows.sort((a, b) => Math.abs(gameStartMs(a) - targetMs) - Math.abs(gameStartMs(b) - targetMs));
    const game = rows[0];
    if (!game || Math.abs(gameStartMs(game) - targetMs) > toleranceMs) return null;
    return {
      game,
      ml: marketSnapshot(game, 'ml'),
      hd: marketSnapshot(game, 'hd'),
      ou: marketSnapshot(game, 'ou'),
      open: {
        ml: marketSnapshot(game, 'ml', 'open'),
        hd: marketSnapshot(game, 'hd', 'open'),
        ou: marketSnapshot(game, 'ou', 'open'),
      },
    };
  }

  function marketOutcome(snapshot, side) {
    if (!snapshot || !['away', 'home', 'over', 'under'].includes(side)) return null;
    const odds = numberOrNaN(snapshot[side]);
    if (!Number.isFinite(odds)) return null;
    const result = { side, odds };
    const line = numberOrNaN(snapshot.line);
    if (Number.isFinite(line)) {
      if (side === 'away' || side === 'home') {
        const favorite = snapshot.favorite === 'away' || snapshot.favorite === 'home'
          ? snapshot.favorite
          : (line < 0 ? 'home' : 'away');
        result.line = side === favorite ? -Math.abs(line) : Math.abs(line);
      } else {
        result.line = Math.abs(line);
      }
    }
    return result;
  }

  function applyOddsToPregame(pregame, item, stakeMatch, bet365Match, defaultFavorite = 'home') {
    const source = pregame && typeof pregame === 'object' ? pregame : {};
    const state = item && typeof item === 'object' ? item : {};
    const stakeHd = stakeMatch && stakeMatch.hd;
    const stakeFavorite = stakeHd && (stakeHd.favorite === 'away' || stakeHd.favorite === 'home')
      ? stakeHd.favorite : null;
    const stakeLine = numberOrNaN(stakeHd && stakeHd.line);
    const hasStakeHd = !!stakeFavorite && Number.isFinite(stakeLine);
    const betHd = bet365Match && bet365Match.hd;
    const betFavorite = betHd && (betHd.favSide === 'away' || betHd.favSide === 'home')
      ? betHd.favSide : null;
    const betLine = numberOrNaN(betHd && betHd.line);
    const hasBetHd = !!betFavorite && Number.isFinite(betLine);
    const sourceFavorite = source.hdFav === 'away' || source.hdFav === 'home' ? source.hdFav : defaultFavorite;

    let hdFav = hasStakeHd ? stakeFavorite : (hasBetHd ? betFavorite : sourceFavorite);
    if (state.hdFavOverride === 'away' || state.hdFavOverride === 'home') {
      hdFav = state.hdFavOverride;
    } else if (state.hdSwap) {
      hdFav = hdFav === 'away' ? 'home' : 'away';
    }

    const sourceLine = numberOrNaN(source.hdVal);
    const activeTotal = numberOrNaN(stakeMatch && stakeMatch.ou && stakeMatch.ou.line);
    const sourceTotal = numberOrNaN(source.totLine);
    return {
      hdFav,
      hdVal: hasStakeHd ? Math.abs(stakeLine) :
        (hasBetHd ? Math.abs(betLine) : (Number.isFinite(sourceLine) ? Math.abs(sourceLine) : source.hdVal)),
      totLine: Number.isFinite(activeTotal) ? Math.abs(activeTotal) :
        (Number.isFinite(sourceTotal) ? Math.abs(sourceTotal) : null),
      hdSrc: hasStakeHd ? 'STAKE' : (hasBetHd ? 'BET365' : source.hdSrc),
      stake: stakeMatch || null,
      bet365: bet365Match || null,
    };
  }

  return {
    MATCH_TOLERANCE_MS,
    FEED_FRESH_MS,
    findStakeGame,
    marketSnapshot,
    marketOutcome,
    applyOddsToPregame,
    isFeedFresh,
    summarizeHandicapHistory,
  };
});
