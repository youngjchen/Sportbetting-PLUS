(function initNhlStake(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NhlStake = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildNhlStake() {
  'use strict';

  const MATCH_TOLERANCE_MS = 12 * 60 * 60 * 1000;

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
    findStakeGame,
    marketSnapshot,
    marketOutcome,
    applyOddsToPregame,
  };
});
