(function (root, factory) {
  'use strict';
  var api = factory();
  if (root) root.__gameRecordUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function gameIdentityKey(game) {
    var value = game || {};
    if (value.officialId) return 'official:' + value.officialId;
    return [
      'game', String(value.league || '').toLowerCase(), value.date || '',
      value.awayTeam || value.away || '', value.homeTeam || value.home || '',
      value.gameTime || value.time || '',
    ].join('|');
  }

  function fallbackIdentityKey(game) {
    var value = game || {};
    return [
      'game', String(value.league || '').toLowerCase(), value.date || '',
      value.awayTeam || value.away || '', value.homeTeam || value.home || '',
      value.gameTime || value.time || '',
    ].join('|');
  }

  function sameGame(left, right) {
    if (!left || !right) return false;
    if (left.officialId && right.officialId) return left.officialId === right.officialId;
    return fallbackIdentityKey(left) === fallbackIdentityKey(right);
  }

  function missingSettledCards(doc) {
    var value = doc || {};
    var games = Array.isArray(value.games) ? value.games : [];
    var sids = new Set(games.map(function (game) { return game && game.sid; }).filter(Boolean));
    var official = new Set(games.map(function (game) { return game && game.officialId; }).filter(Boolean));
    var fallback = new Set(games.map(fallbackIdentityKey));
    var fallbackWithoutOfficial = new Set(games.filter(function (game) { return game && !game.officialId; }).map(fallbackIdentityKey));
    var missing = [];
    Object.keys(value.boards || {}).sort().forEach(function (date) {
      var board = value.boards[date];
      ((board && board.items) || []).forEach(function (item) {
        var picks = item && item.settled;
        if (!item || item.type !== 'match' || !picks || !picks._sid) return;
        if (sids.has(picks._sid)) return;
        var candidate = {
          officialId: picks.officialId || item.officialId || null,
          league: item.league || '', date: date,
          awayTeam: item.away, homeTeam: item.home, gameTime: item.gameTime || null,
        };
        var fallbackKey = fallbackIdentityKey(candidate);
        if (candidate.officialId) {
          if (official.has(candidate.officialId) || fallbackWithoutOfficial.has(fallbackKey)) return;
        } else if (fallback.has(fallbackKey)) return;
        missing.push({ date: date, item: item, picks: picks });
        sids.add(picks._sid);
        if (candidate.officialId) official.add(candidate.officialId);
        fallback.add(fallbackKey);
        if (!candidate.officialId) fallbackWithoutOfficial.add(fallbackKey);
      });
    });
    return missing;
  }

  return { gameIdentityKey: gameIdentityKey, fallbackIdentityKey: fallbackIdentityKey, sameGame: sameGame, missingSettledCards: missingSettledCards };
});
