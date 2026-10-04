(function initNhlBet365(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NhlBet365 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildNhlBet365() {
  'use strict';

  const TEAM_ZH = Object.freeze({
    Ducks: '巨鴨',
    Bruins: '棕熊',
    Sabres: '軍刀',
    Flames: '火焰',
    Hurricanes: '颶風',
    Blackhawks: '黑鷹',
    Avalanche: '雪崩',
    'Blue Jackets': '藍衣',
    Stars: '達拉斯',
    'Red Wings': '紅翼',
    Oilers: '油人',
    Panthers: '佛羅里',
    Kings: '國王',
    Wild: '荒野',
    Canadiens: '加拿大',
    Predators: '掠奪者',
    Devils: '魔鬼',
    Islanders: '島人',
    Rangers: '遊騎兵',
    Senators: '參議員',
    Flyers: '飛人',
    Penguins: '企鵝',
    Sharks: '鯊魚',
    Kraken: '海怪',
    Blues: '藍調',
    Lightning: '閃電',
    'Maple Leafs': '楓葉',
    Mammoth: '猛瑪象',
    Canucks: '加人',
    'Golden Knights': '騎士',
    Capitals: '首都',
    Jets: '噴射機',
  });

  function translateTeam(name) {
    const text = String(name || '').trim();
    const nickname = Object.keys(TEAM_ZH).find((key) => text === key || text.endsWith(` ${key}`));
    if (!nickname) throw new Error(`未知 NHL 隊名：${text || '(空白)'}`);
    return TEAM_ZH[nickname];
  }

  function stableGameKey(game) {
    return `${Number(game && game.startTime)}|${String(game && game.away || '')}|${String(game && game.home || '')}`;
  }

  function marketSnapshot(game) {
    const snapshot = { provider: game && game.provider || 'bet365-official' };
    if (game && game.ml) snapshot.ml = game.ml;
    if (game && game.hd) snapshot.hd = game.hd;
    if (game && game.total) snapshot.total = game.total;
    return snapshot;
  }

  function stableMarketJSON(game) {
    return JSON.stringify(marketSnapshot(game));
  }

  function mergeBet365Game(previous, current, observedAt) {
    const oldGame = previous && typeof previous === 'object' ? previous : {};
    const newGame = current && typeof current === 'object' ? current : {};
    const history = Array.isArray(oldGame.history) ? oldGame.history.slice() : [];
    const events = Array.isArray(oldGame.events) ? oldGame.events.slice() : [];
    const snapshot = { at: observedAt, ...marketSnapshot(newGame) };
    const latest = history[0] || null;

    if (!latest || stableMarketJSON(latest) !== stableMarketJSON(snapshot)) {
      if (latest && latest.provider !== snapshot.provider) {
        events.unshift({
          at: observedAt,
          type: 'source-change',
          from: latest.provider || 'bet365-official',
          to: snapshot.provider || 'bet365-official',
        });
      } else if (latest && latest.hd && snapshot.hd) {
        const beforeLine = Number(latest.hd.line);
        const afterLine = Number(snapshot.hd.line);
        if (Number.isFinite(beforeLine) && Number.isFinite(afterLine) && beforeLine !== afterLine) {
          events.unshift({ at: observedAt, type: 'handicap-line', from: beforeLine, to: afterLine });
        }
        const beforeFavorite = latest.hd.favSide;
        const afterFavorite = snapshot.hd.favSide;
        if (beforeFavorite && afterFavorite && beforeFavorite !== afterFavorite) {
          events.unshift({ at: observedAt, type: 'favorite-flip', from: beforeFavorite, to: afterFavorite });
        }
      }
      history.unshift(snapshot);
    }

    return {
      ...oldGame,
      ...newGame,
      provider: newGame.provider || oldGame.provider || 'bet365-official',
      history: history.slice(0, 240),
      events: events.slice(0, 120),
    };
  }

  function pregameStartMs(pregame) {
    const date = String(pregame && pregame.date || '');
    const time = String(pregame && pregame.time || '').slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return NaN;
    return Date.parse(`${date}T${time.padStart(5, '0')}:00+08:00`);
  }

  function findBet365Game(feed, pregame, toleranceMs = 12 * 3600000) {
    const targetMs = pregameStartMs(pregame);
    if (!Number.isFinite(targetMs)) return null;
    const rows = Object.values(feed && feed.games || {}).filter((game) => (
      game && game.awayZh === pregame.away && game.homeZh === pregame.home &&
      Number.isFinite(Number(game.startTime))
    ));
    rows.sort((a, b) => Math.abs(Number(a.startTime) - targetMs) - Math.abs(Number(b.startTime) - targetMs));
    const game = rows[0];
    if (!game || Math.abs(Number(game.startTime) - targetMs) > toleranceMs) return null;

    const history = Array.isArray(game.history) ? game.history : [];
    const latest = history[0] || game;
    const open = history[history.length - 1] || game;
    return {
      game,
      latest,
      open,
      ml: latest.ml || game.ml || null,
      hd: latest.hd || game.hd || null,
      total: latest.total || game.total || null,
      openTotal: open.total || game.total || null,
      changes: Math.max(0, history.length - 1),
    };
  }

  function marketOutcome(market, side) {
    if (!market || !Array.isArray(market.outcomes)) return null;
    return market.outcomes.find((outcome) => outcome && outcome.side === side) || null;
  }

  function applyBet365ToPregame(pregame, item, match, defaultFavorite = 'home') {
    const source = pregame && typeof pregame === 'object' ? pregame : {};
    const state = item && typeof item === 'object' ? item : {};
    const hd = match && match.hd;
    const bet365Favorite = hd && (hd.favSide === 'away' || hd.favSide === 'home') ? hd.favSide : null;
    let hdFav = bet365Favorite ||
      (source.hdFav === 'away' || source.hdFav === 'home' ? source.hdFav : defaultFavorite);
    if (state.hdFavOverride === 'away' || state.hdFavOverride === 'home') {
      hdFav = state.hdFavOverride;
    } else if (state.hdSwap) {
      hdFav = hdFav === 'away' ? 'home' : 'away';
    }

    const hasBet365Line = !!hd && hd.line != null && hd.line !== '';
    const hasSourceLine = source.hdVal != null && source.hdVal !== '';
    const bet365Line = hasBet365Line ? Number(hd.line) : NaN;
    const sourceLine = hasSourceLine ? Number(source.hdVal) : NaN;
    return {
      hdFav,
      hdVal: Number.isFinite(bet365Line) ? Math.abs(bet365Line) :
        (Number.isFinite(sourceLine) ? Math.abs(sourceLine) : source.hdVal),
      hdSrc: hd ? 'BET365' : source.hdSrc,
      bet365: match || null,
    };
  }

  return {
    TEAM_ZH,
    translateTeam,
    stableGameKey,
    mergeBet365Game,
    findBet365Game,
    marketOutcome,
    applyBet365ToPregame,
  };
});
