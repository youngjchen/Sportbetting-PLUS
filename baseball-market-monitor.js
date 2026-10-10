'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.__baseballMarketMonitor = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function sideName(card, side) {
    return side === 'away' ? card.away : side === 'home' ? card.home : '—';
  }

  function numberText(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : String(value);
  }

  function timeText(value) {
    const stamp = Date.parse(value || '');
    if (!Number.isFinite(stamp)) return '時間不明';
    return new Date(stamp + 8 * 3600000).toISOString().slice(11, 16);
  }

  function sameNumber(left, right) {
    if (left == null && right == null) return true;
    return Number(left) === Number(right);
  }

  function meaningfulStakeEvents(game) {
    if (!game) return [];
    const events = [];
    const seen = new Set();
    const push = function (event) {
      const key = [event.at || '', event.kind, event.text].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      events.push(event);
    };

    for (const transition of Array.isArray(game.favoriteTransitions) ? game.favoriteTransitions : []) {
      if (!transition || transition.from === transition.to) continue;
      push({
        at: transition.at || null,
        kind: 'favorite',
        text: `${sideName(game, transition.from)} → ${sideName(game, transition.to)}`,
      });
    }

    const snapshots = (Array.isArray(game.history) ? game.history : [])
      .filter(Boolean)
      .slice()
      .sort((left, right) => Date.parse(left.observedAt || '') - Date.parse(right.observedAt || ''));
    if (snapshots.length) {
      const current = {
        observedAt: game.observedAt,
        canonicalLine: game.canonicalLine,
        total: game.total,
      };
      const rows = snapshots.concat(current);
      for (let index = 1; index < rows.length; index++) {
        const before = rows[index - 1] || {};
        const after = rows[index] || {};
        if (!sameNumber(before.canonicalLine, after.canonicalLine)) {
          push({
            at: after.observedAt || null,
            kind: 'handicap-line',
            text: `讓分線 ${numberText(before.canonicalLine)} → ${numberText(after.canonicalLine)}`,
          });
        }
        const beforeTotal = before.total && before.total.line;
        const afterTotal = after.total && after.total.line;
        if (!sameNumber(beforeTotal, afterTotal)) {
          push({
            at: after.observedAt || null,
            kind: 'total-line',
            text: `大小 ${numberText(beforeTotal)} → ${numberText(afterTotal)}`,
          });
        }
      }
    }
    return events.sort((left, right) => Date.parse(left.at || '') - Date.parse(right.at || ''));
  }

  function meaningfulTaiwanEvents(taiwan) {
    if (!taiwan) return [];
    if (Array.isArray(taiwan.events) && taiwan.events.length) {
      return taiwan.events.filter(Boolean).map((event) => ({
        at: event.at || null,
        displayTime: event.displayTime,
        text: event.text || '',
      }));
    }
    const transitionText = String(taiwan.transitionText || '').trim();
    if (!transitionText) return [];
    const parsed = transitionText.split(/\s*→\s*/).map((part) => {
      const match = part.trim().match(/^(\d{1,2}:\d{2})\s+(.+)$/);
      return match ? { displayTime: match[1].padStart(5, '0'), text: match[2].trim() } : null;
    });
    if (parsed.length > 1 && parsed.every(Boolean)) return parsed;
    return [{ displayTime: '', text: transitionText }];
  }

  function currentLabel(card, source) {
    if (!source || (source.side !== 'away' && source.side !== 'home')) return '未取得方向';
    return `${sideName(card, source.side)}讓${numberText(source.line)}`;
  }

  function addText(parent, className, text) {
    const element = parent.ownerDocument.createElement('span');
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function addSummary(head, label, current, changed, tone) {
    const cell = head.ownerDocument.createElement('span');
    cell.className = `market-platform ${tone || ''}${changed === true ? ' changed' : ''}`.trim();
    addText(cell, 'market-source', label);
    addText(cell, 'market-current', current);
    // changed＝'unknown'：方向已確認、但有沒有換過邊沒有任何來源能證明（人工確認的 BET365 亞洲場）→ 不替它下「未對調」的結論
    addText(cell, 'market-state', current === '未取得方向' ? '待資料' : (changed === 'unknown' ? '未確認' : (changed ? '曾對調' : '未對調')));
    head.appendChild(cell);
    return cell;
  }

  function addDetailLine(section, label, text) {
    const line = section.ownerDocument.createElement('div');
    line.className = 'market-detail-line';
    addText(line, 'market-detail-key', label);
    addText(line, 'market-detail-value', text);
    section.appendChild(line);
  }

  function addEvents(section, events) {
    if (!events.length) {
      addDetailLine(section, '變動', '沒有讓分方或基準線變動');
      return;
    }
    const list = section.ownerDocument.createElement('div');
    list.className = 'market-timeline';
    for (const event of events) {
      const row = section.ownerDocument.createElement('div');
      const embeddedTime = Object.prototype.hasOwnProperty.call(event, 'displayTime') && event.displayTime === '';
      row.className = `market-event${embeddedTime ? ' no-time' : ''}`;
      if (!embeddedTime) addText(row, 'market-event-time', event.displayTime || timeText(event.at));
      addText(row, 'market-event-text', event.text);
      list.appendChild(row);
    }
    section.appendChild(list);
  }

  function currentStakeLines(card, game) {
    if (!game) return [];
    const favorite = game.favorite;
    const dog = favorite === 'away' ? 'home' : 'away';
    const line = numberText(game.canonicalLine);
    const ml = game.moneyline || {};
    const handicap = game.handicapOdds || {};
    const total = game.total || {};
    return [
      ['目前', `${sideName(card, favorite)}讓${line}｜大小 ${numberText(total.line)}`],
      ['獨贏', `客 ${card.away} ${numberText(ml.away)}／主 ${card.home} ${numberText(ml.home)}`],
      ['讓分', `${sideName(card, favorite)} -${line} ${numberText(handicap[favorite])}／${sideName(card, dog)} +${line} ${numberText(handicap[dog])}`],
      ['大小', `大 ${numberText(total.line)} ${numberText(total.over)}／小 ${numberText(total.line)} ${numberText(total.under)}`],
    ];
  }

  function currentBet365Lines(card, bet365) {
    if (!bet365) return [];
    const markets = bet365.markets || {};
    const ml = markets.ml || {};
    const total = markets.ou || markets.total || {};
    const lines = [['目前', currentLabel(card, bet365)]];
    if (ml.away != null || ml.home != null) lines.push(['獨贏', `客 ${card.away} ${numberText(ml.away)}／主 ${card.home} ${numberText(ml.home)}`]);
    if (total.line != null) lines.push(['大小', `大 ${numberText(total.line)} ${numberText(total.over)}／小 ${numberText(total.line)} ${numberText(total.under)}`]);
    return lines;
  }

  function section(documentRef, title, className) {
    const element = documentRef.createElement('section');
    element.className = `market-detail-section ${className}`;
    const heading = documentRef.createElement('h4');
    heading.textContent = title;
    element.appendChild(heading);
    return element;
  }

  function renderMonitor(options) {
    const documentRef = options && options.documentRef;
    const card = options && options.card;
    if (!documentRef || !card) return null;
    const stake = options.stakeGame || null;
    const bet365 = options.bet365 || null;
    const taiwan = options.taiwan || null;
    const stakeChanged = !!(stake && ((Number(stake.favoriteFlipCount) || 0) > 0 ||
      (Array.isArray(stake.favoriteTransitions) && stake.favoriteTransitions.length > 0)));
    const betSwapSeen = !!(bet365 && (bet365.flipEver || (Array.isArray(bet365.events) && bet365.events.length)));
    // 使用者手動標的對調（亮／暗）優先於自動判斷（2026-10-10）
    const manualSwap = typeof options.bet365ManualSwap === 'boolean' ? options.bet365ManualSwap : null;
    const betChanged = manualSwap != null ? manualSwap : (betSwapSeen ? true : (bet365 && bet365.swapUnknown ? 'unknown' : false));
    const taiwanChanged = !!(taiwan && Number(taiwan.flipCount));

    const root = documentRef.createElement('div');
    const sides = [stake && stake.favorite, bet365 && bet365.side, taiwan && taiwan.side]
      .filter((side) => side === 'away' || side === 'home');
    const diverged = sides.length > 1 && sides.some((side) => side !== sides[0]);
    root.className = `market-monitor${diverged ? ' diverged' : ' aligned'}`;

    const head = documentRef.createElement('button');
    head.type = 'button';
    head.className = 'market-monitor-head';
    head.setAttribute('aria-expanded', 'false');
    head.title = '展開三方盤口變動明細';
    addSummary(head, 'STAKE', currentLabel(card, stake && { side: stake.favorite, line: stake.canonicalLine }), stakeChanged, 'stake');
    const betCell = addSummary(head, 'BET365', currentLabel(card, bet365), betChanged, 'bet365');
    // 手動調整 BET365（2026-10-10 使用者規格）：點讓分隊名＝換成另一隊；點圓圈＝亮（有對調）／暗（沒對調）。不觸發展開明細。
    if (typeof options.onBet365Side === 'function') {
      const el = betCell.querySelector('.market-current');
      el.classList.add('market-edit');
      el.title = '點隊名：把 BET365 讓分方換成另一隊（手動）';
      el.addEventListener('click', (event) => {
        event.stopPropagation(); event.preventDefault();
        const now = bet365 && (bet365.side === 'away' || bet365.side === 'home') ? bet365.side : null;
        options.onBet365Side(now === 'away' ? 'home' : 'away');
      });
    }
    if (typeof options.onBet365Swap === 'function') {
      const el = betCell.querySelector('.market-source');
      el.classList.add('market-edit');
      el.title = '點圓圈：亮＝BET365 有對調、暗＝沒對調（手動）';
      el.addEventListener('click', (event) => { event.stopPropagation(); event.preventDefault(); options.onBet365Swap(betChanged !== true); });
    }
    addSummary(head, '台彩', currentLabel(card, taiwan), taiwanChanged, 'taiwan');
    root.appendChild(head);

    const details = documentRef.createElement('div');
    details.className = 'market-monitor-details';
    details.hidden = true;

    const stakeSection = section(documentRef, 'STAKE', 'stake');
    if (stake) {
      for (const [label, text] of currentStakeLines(card, stake)) addDetailLine(stakeSection, label, text);
      addEvents(stakeSection, meaningfulStakeEvents(stake));
      addDetailLine(stakeSection, '來源', 'Stake 官網');
      const controls = documentRef.createElement('div');
      controls.className = 'market-auto-controls';
      if (card.stakeAutoHandicap === false && typeof options.onRestoreHandicap === 'function') {
        const button = documentRef.createElement('button');
        button.type = 'button'; button.textContent = '↻ 恢復自動讓分';
        button.onclick = (event) => { event.stopPropagation(); options.onRestoreHandicap(); };
        controls.appendChild(button);
      }
      if (card.stakeAutoTotal === false && typeof options.onRestoreTotal === 'function') {
        const button = documentRef.createElement('button');
        button.type = 'button'; button.textContent = '↻ 恢復自動大小';
        button.onclick = (event) => { event.stopPropagation(); options.onRestoreTotal(); };
        controls.appendChild(button);
      }
      if (controls.childNodes.length) stakeSection.appendChild(controls);
    } else addDetailLine(stakeSection, '狀態', options.stakeMissingText || '尚未配對');
    details.appendChild(stakeSection);

    const betSection = section(documentRef, 'BET365', 'bet365');
    if (bet365) {
      for (const [label, text] of currentBet365Lines(card, bet365)) addDetailLine(betSection, label, text);
      const events = (Array.isArray(bet365.events) ? bet365.events : [])
        .filter((event) => event && event.type === 'favorite-flip')
        .map((event) => ({ at: event.at, text: `${sideName(card, event.from)} → ${sideName(card, event.to)}` }));
      if (!events.length && bet365.transitionText) events.push({ displayTime: '', text: bet365.transitionText });
      if (!events.length && betChanged === 'unknown') addDetailLine(betSection, '變動', '沒有任何來源記到換邊紀錄，有沒有對調未確認');
      else addEvents(betSection, events);
      addDetailLine(betSection, '來源', bet365.providerLabel || 'BET365');
    } else addDetailLine(betSection, '狀態', '尚未取得盤口');
    if (options.bet365Manual && typeof options.onBet365Restore === 'function') {
      const controls = documentRef.createElement('div');
      controls.className = 'market-auto-controls';
      const button = documentRef.createElement('button');
      button.type = 'button'; button.textContent = '↻ 恢復自動判斷';
      button.onclick = (event) => { event.stopPropagation(); options.onBet365Restore(); };
      controls.appendChild(button);
      betSection.appendChild(controls);
    }
    details.appendChild(betSection);

    const taiwanSection = section(documentRef, '台彩', 'taiwan');
    if (taiwan && (taiwan.side === 'away' || taiwan.side === 'home')) {
      addDetailLine(taiwanSection, '目前', currentLabel(card, taiwan));
      addEvents(taiwanSection, meaningfulTaiwanEvents(taiwan));
      addDetailLine(taiwanSection, '來源', taiwan.live ? '玩運彩盤中序列' : '玩運彩開盤');
    } else addDetailLine(taiwanSection, '狀態', '尚未取得盤口');
    details.appendChild(taiwanSection);

    head.onclick = function () {
      const open = details.hidden;
      details.hidden = !open;
      head.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    root.appendChild(details);
    return root;
  }

  return { meaningfulStakeEvents, meaningfulTaiwanEvents, renderMonitor, timeText };
});
