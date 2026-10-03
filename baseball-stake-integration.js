'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  const RAW_URL = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/baseball_stake_odds.json';
  const LOCAL_URL = './data/baseball_stake_odds.json';
  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_MS = 30 * 60 * 1000;

  function league(value) {
    const text = String(value || '').toUpperCase();
    return ['MLB', 'NPB', 'KBO', 'CPBL'].includes(text) ? text : '';
  }

  const TEAM_SYNONYM = { '韓華鷹': '華老鷹', '韓華': '華老鷹', '橫濱DeNA': '橫濱' };
  function team(value) {
    const text = String(value || '').trim();
    return TEAM_SYNONYM[text] || text;
  }

  function cardLeague(card) {
    if (card && card.league) return league(card.league);
    try { if (typeof leagueOf === 'function') return league(leagueOf(card)); } catch (_) {}
    return '';
  }

  function hhmm(value) {
    const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function taiwanDateTime(game) {
    const stamp = Date.parse(game && game.scheduledStart || '');
    if (!Number.isFinite(stamp)) return { date: '', minute: null };
    const text = new Date(stamp + 8 * 3600000).toISOString();
    return { date: text.slice(0, 10), minute: Number(text.slice(11, 13)) * 60 + Number(text.slice(14, 16)) };
  }

  function findGame(feed, card, activeDate) {
    if (!feed || !feed.matches || !card) return null;
    if (card.officialId && feed.matches[card.officialId]) return feed.matches[card.officialId];
    const wantedLeague = cardLeague(card);
    const wantedDate = String(activeDate || '').slice(0, 10);
    const wantedMinute = hhmm(card.gameTime || card.time);
    let best = null;
    let bestDiff = Infinity;
    for (const game of Object.values(feed.matches)) {
      if (!game || (wantedLeague && league(game.league) !== wantedLeague)) continue;
      if (team(game.away) !== team(card.away) || team(game.home) !== team(card.home)) continue;
      const when = taiwanDateTime(game);
      if (wantedDate && when.date !== wantedDate) continue;
      const diff = wantedMinute == null || when.minute == null ? 0 : Math.abs(wantedMinute - when.minute);
      if (diff < bestDiff && diff <= 120) {
        best = game;
        bestDiff = diff;
      }
    }
    return best;
  }

  function isUsable(game, now) {
    if (!game) return false;
    if (game.frozenAt) return true;
    const seen = Date.parse(game.observedAt || '');
    return Number.isFinite(seen) && Number(now) - seen <= STALE_MS;
  }

  function applyToCard(card, game, now) {
    if (!card || !game || card.settled || !isUsable(game, now == null ? Date.now() : now)) return false;
    let changed = false;
    if (card.stakeAutoHandicap === undefined) {
      card.stakeAutoHandicap = card.hdVal == null || card.hdVal === '';
    }
    if (card.stakeAutoTotal === undefined) {
      card.stakeAutoTotal = card.totVal == null || card.totVal === '';
    }
    if (card.stakeAutoHandicap && (game.favorite === 'away' || game.favorite === 'home') && game.canonicalLine != null) {
      if (card.hdFav !== game.favorite) { card.hdFav = game.favorite; changed = true; }
      if (Number(card.hdVal) !== Number(game.canonicalLine) || card.hdVal === '') {
        card.hdVal = Number(game.canonicalLine);
        changed = true;
      }
    }
    if (card.stakeAutoTotal && game.total && game.total.line != null &&
        (Number(card.totVal) !== Number(game.total.line) || card.totVal === '')) {
      card.totVal = Number(game.total.line);
      changed = true;
    }
    card.stakeMonitorOfficialId = game.officialId || null;
    card.stakeMonitorObservedAt = game.observedAt || null;
    return changed;
  }

  function markManual(card, field) {
    if (!card) return;
    if (field === 'handicap') card.stakeAutoHandicap = false;
    if (field === 'total') card.stakeAutoTotal = false;
  }

  function restoreAuto(card, field, game, now) {
    if (!card) return false;
    if (field === 'handicap') card.stakeAutoHandicap = true;
    if (field === 'total') card.stakeAutoTotal = true;
    return applyToCard(card, game, now == null ? Date.now() : now);
  }

  function timeText(value) {
    const stamp = Date.parse(value || '');
    if (!Number.isFinite(stamp)) return '時間不明';
    return new Date(stamp + 8 * 3600000).toISOString().slice(11, 16);
  }

  function healthLabel(game, now) {
    if (game && game.frozenAt) return '已凍結';
    const seen = Date.parse(game && game.observedAt || '');
    if (!Number.isFinite(seen) || Number(now) - seen > STALE_MS) return '已過期';
    if (game && game.partial) return '部分缺漏';
    return '正常';
  }

  function sideName(game, side) {
    return side === 'away' ? game.away : side === 'home' ? game.home : '—';
  }

  function statusText(game, now) {
    if (!game) return 'Stake：無資料';
    const favorite = sideName(game, game.favorite);
    const odds = game.handicapOdds && game.handicapOdds[game.favorite];
    const dogSide = game.favorite === 'away' ? 'home' : 'away';
    const dog = sideName(game, dogSide);
    const dogOdds = game.handicapOdds && game.handicapOdds[dogSide];
    const ml = game.moneyline || {};
    const total = game.total || {};
    const line = game.canonicalLine == null ? '—' : game.canonicalLine;
    const transitions = Array.isArray(game.favoriteTransitions) ? game.favoriteTransitions : [];
    const latest = transitions[transitions.length - 1];
    const flip = latest
      ? `換邊 ${game.favoriteFlipCount || transitions.length} 次｜${sideName(game, latest.from)}→${sideName(game, latest.to)} ${timeText(latest.at)}`
      : '讓分方未換邊';
    return `Stake：${favorite}讓 ${line}${odds == null ? '' : `（${odds}）`}` +
      `｜獨贏 客 ${game.away} ${ml.away == null ? '—' : ml.away}／主 ${game.home} ${ml.home == null ? '—' : ml.home}` +
      `｜讓 ${favorite} -${line} ${odds == null ? '—' : odds}／受讓 ${dog} +${line} ${dogOdds == null ? '—' : dogOdds}` +
      `｜大小 ${total.line == null ? '—' : total.line}｜大 ${total.line == null ? '—' : total.line} ${total.over == null ? '—' : total.over}` +
      `／小 ${total.line == null ? '—' : total.line} ${total.under == null ? '—' : total.under}` +
      `｜${flip}｜${healthLabel(game, now == null ? Date.now() : now)}`;
  }

  function noGameText(feed, card) {
    const wantedLeague = cardLeague(card);
    const state = feed && feed.leagues && feed.leagues[wantedLeague];
    if (state && state.status === 'ok' && state.health && Number(state.health.discovered) === 0) {
      return 'Stake：官方目前未開盤（持續監控）';
    }
    if (state && state.status && state.status !== 'ok') return 'Stake：管線異常（持續重試）';
    return 'Stake：本場尚未配對（持續監控）';
  }

  function renderCardStatus(card, game, now, documentRef, feed) {
    if (!card || !documentRef) return null;
    const row = documentRef.createElement('div');
    const health = game ? healthLabel(game, now == null ? Date.now() : now) : '未開盤';
    row.className = `bstake-monitor ${health === '已過期' ? 'stale' : health === '部分缺漏' ? 'partial' : health === '已凍結' ? 'frozen' : 'ok'}`;
    row.title = game ? `方向：${game.sources && game.sources.direction || '無'}；讓分賠率：${game.sources && game.sources.handicapOdds || '無'}；大小：${game.sources && game.sources.total || '無'}；更新 ${timeText(game.observedAt)}` : 'Stake 官方盤口會每五分鐘持續重試';
    const text = documentRef.createElement('span');
    text.className = 'bstake-monitor-text';
    text.textContent = game ? statusText(game, now) : noGameText(feed, card);
    row.appendChild(text);

    if (!game) return row;

    function restoreButton(field, label) {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'bstake-auto';
      button.textContent = label;
      button.title = field === 'handicap' ? '恢復由 Stake 自動同步讓分方' : '恢復由 Stake 自動同步大小分';
      button.onclick = function (event) {
        event.stopPropagation();
        restoreAuto(card, field, game, Date.now());
        const view = documentRef.defaultView;
        try { if (view && typeof view.save === 'function') view.save(); } catch (_) {}
        try { if (view && typeof view.render === 'function') view.render(); } catch (_) {}
      };
      row.appendChild(button);
    }
    if (card.stakeAutoHandicap === false) restoreButton('handicap', '↻讓');
    if (card.stakeAutoTotal === false) restoreButton('total', '↻大');
    const snapshots = Array.isArray(game.history) ? game.history : [];
    if (snapshots.length) {
      const toggle = documentRef.createElement('button');
      toggle.type = 'button';
      toggle.className = 'bstake-history-toggle';
      toggle.textContent = '▾';
      toggle.title = '展開 Stake 盤口歷史明細';
      toggle.onclick = function (event) {
        event.stopPropagation();
        let history = row.querySelector('.bstake-history');
        if (!history) {
          history = documentRef.createElement('div');
          history.className = 'bstake-history';
          history.hidden = true;
          for (const snapshot of snapshots) {
            const line = documentRef.createElement('div');
            const favorite = sideName(game, snapshot.favorite);
            const hdOdds = snapshot.handicapOdds || {};
            const totalLine = snapshot.total && snapshot.total.line != null ? snapshot.total.line : '—';
            line.textContent = `${timeText(snapshot.observedAt)} ${favorite}讓 ${snapshot.canonicalLine == null ? '—' : snapshot.canonicalLine}` +
              `（客 ${hdOdds.away == null ? '—' : hdOdds.away}／主 ${hdOdds.home == null ? '—' : hdOdds.home}）` +
              `｜大小 ${totalLine}`;
            history.appendChild(line);
          }
          row.appendChild(history);
        }
        history.hidden = !history.hidden;
        toggle.textContent = history.hidden ? '▾' : '▴';
      };
      row.appendChild(toggle);
    }
    return row;
  }

  function install(global) {
    if (global.__baseballStakeIntegration) return global.__baseballStakeIntegration;
    let feed = { schemaVersion: 1, matches: {}, leagues: {} };

    function validFeed(value) {
      return value && value.schemaVersion === 1 && value.provider === 'stake-official' &&
        value.matches && typeof value.matches === 'object';
    }

    function boardDoc() {
      try { if (typeof doc !== 'undefined' && doc && doc.boards) return doc; } catch (_) {}
      return global.doc && global.doc.boards ? global.doc : null;
    }

    function activeDate() {
      const value = boardDoc();
      return value && value.activeDate || '';
    }

    function gameFor(card, date) {
      return findGame(feed, card, date || activeDate());
    }

    function autoApply() {
      const value = boardDoc();
      if (!value) return 0;
      let changed = 0;
      for (const [date, board] of Object.entries(value.boards || {})) {
        for (const card of (board && board.items) || []) {
          if (!card || card.type !== 'match') continue;
          const game = gameFor(card, date);
          if (game && applyToCard(card, game, Date.now())) changed++;
        }
      }
      if (changed) {
        try { if (typeof global.save === 'function') global.save(); } catch (_) {}
      }
      return changed;
    }

    async function fetchFeed(url) {
      const response = await global.fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
        cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (!validFeed(value)) throw new Error('Stake 棒球監控資料格式不合法');
      return value;
    }

    async function refresh() {
      try { feed = await fetchFeed(RAW_URL); }
      catch (_) { feed = await fetchFeed(LOCAL_URL); }
      autoApply();
      try { if (typeof global.render === 'function') global.render(); } catch (_) {}
      return feed;
    }

    const api = {
      refresh,
      autoApply,
      gameFor,
      findGame,
      applyToCard,
      markManual,
      restoreAuto: function (card, field) {
        const changed = restoreAuto(card, field, gameFor(card), Date.now());
        try { if (typeof global.save === 'function') global.save(); } catch (_) {}
        try { if (typeof global.render === 'function') global.render(); } catch (_) {}
        return changed;
      },
      statusText: function (card) { return statusText(gameFor(card), Date.now()); },
      renderCardStatus: function (card) {
        const game = gameFor(card);
        return renderCardStatus(card, game, Date.now(), global.document, feed);
      },
      _setFeed: function (value) { if (validFeed(value)) feed = value; },
      _getFeed: function () { return feed; },
    };
    global.__baseballStakeIntegration = api;

    const start = function () {
      refresh().catch((error) => console.warn('[Stake 棒球] 監控資料載入失敗:', error));
      global.setInterval(() => refresh().catch((error) => console.warn('[Stake 棒球] 更新失敗:', error)), REFRESH_MS);
    };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    return api;
  }

  return {
    install,
    findGame,
    applyToCard,
    markManual,
    restoreAuto,
    statusText,
    renderCardStatus,
  };
});
