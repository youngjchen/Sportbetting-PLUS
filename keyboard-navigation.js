/* 共用方向鍵導航：↑↓ 切比賽卡片，←→ 切日期。 */
(function (root, factory) {
  var api = factory();
  if (root) {
    root.__boardKeyboardNavigation = api;
    var boot = function () {
      if (!root.__boardKeyboardNavigationController) {
        root.__boardKeyboardNavigationController = api.autoInstall(root.document, root);
      }
    };
    if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot);
    else if (root.document) boot();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function install(options) {
    options = options || {};
    var documentRef = options.document || (typeof document !== 'undefined' ? document : null);
    var windowRef = options.window || (typeof window !== 'undefined' ? window : null);
    if (!documentRef || !windowRef) throw new Error('方向鍵導航缺少 document/window');

    if (!documentRef.getElementById('board-keyboard-navigation-style')) {
      var style = documentRef.createElement('style');
      style.id = 'board-keyboard-navigation-style';
      style.textContent = '.card.kbd-focus{outline:2px solid var(--lit,#ffb02e);outline-offset:3px}';
      (documentRef.head || documentRef.documentElement).appendChild(style);
    }

    var focusedCard = null, focusTimer = null;
    function editable(target) {
      if (!target) return false;
      var tag = String(target.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
    }
    function cards() {
      var list = typeof options.getCards === 'function' ? options.getCards() : [];
      return Array.prototype.slice.call(list || []).filter(function (card) {
        return card && (!card.hidden) && (!card.getAttribute || card.getAttribute('aria-hidden') !== 'true');
      });
    }
    function nearestCardIndex(list, container) {
      if (focusedCard && list.indexOf(focusedCard) >= 0) return list.indexOf(focusedCard);
      var box = container && container.getBoundingClientRect ? container.getBoundingClientRect() : { top: 0, bottom: windowRef.innerHeight || 0 };
      var middle = (Number(box.top) + Number(box.bottom)) / 2;
      var best = Infinity, index = -1;
      list.forEach(function (card, cardIndex) {
        if (!card.getBoundingClientRect) return;
        var rect = card.getBoundingClientRect();
        var distance = Math.abs((Number(rect.top) + Number(rect.bottom)) / 2 - middle);
        if (distance < best) { best = distance; index = cardIndex; }
      });
      return index;
    }
    function moveCard(step) {
      var list = cards();
      var container = typeof options.getScrollContainer === 'function' ? options.getScrollContainer() : null;
      if (!list.length || !container) return false;
      var current = nearestCardIndex(list, container);
      if (current < 0) current = step > 0 ? -1 : list.length;
      var next = Math.max(0, Math.min(list.length - 1, current + step));
      var card = list[next];
      list.forEach(function (item) { item.classList.remove('kbd-focus'); });
      card.classList.add('kbd-focus');
      focusedCard = card;
      if (card.getBoundingClientRect && container.getBoundingClientRect) {
        var rect = card.getBoundingClientRect(), box = container.getBoundingClientRect();
        var delta = ((Number(rect.top) + Number(rect.bottom)) - (Number(box.top) + Number(box.bottom))) / 2;
        container.scrollTop = Math.max(0, Number(container.scrollTop || 0) + delta);
      } else if (typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ block: 'center' });
      }
      if (focusTimer) windowRef.clearTimeout(focusTimer);
      focusTimer = windowRef.setTimeout(function () { card.classList.remove('kbd-focus'); }, 1200);
      return true;
    }
    function moveDate(step) {
      var list = typeof options.getDateButtons === 'function' ? options.getDateButtons() : [];
      list = Array.prototype.slice.call(list || []);
      if (!list.length) return false;
      var active = list.findIndex(function (button) {
        return typeof options.isActiveDate === 'function' ? options.isActiveDate(button) : false;
      });
      var button = list[active + step];
      if (!button || typeof button.click !== 'function') return false;
      focusedCard = null;
      button.click();
      return true;
    }
    function onKeydown(event) {
      if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (typeof options.isBlocked === 'function' && options.isBlocked()) return;
      if (editable(event.target)) return;
      var handled = false;
      if (event.key === 'ArrowDown') handled = moveCard(1);
      else if (event.key === 'ArrowUp') handled = moveCard(-1);
      else if (event.key === 'ArrowRight') handled = moveDate(1);
      else if (event.key === 'ArrowLeft') handled = moveDate(-1);
      if (handled && typeof event.preventDefault === 'function') event.preventDefault();
    }

    documentRef.addEventListener('keydown', onKeydown);
    return {
      moveCard: moveCard,
      moveDate: moveDate,
      destroy: function () {
        documentRef.removeEventListener('keydown', onKeydown);
        if (focusTimer) windowRef.clearTimeout(focusTimer);
      },
    };
  }

  function autoInstall(documentRef, windowRef) {
    return install({
      document: documentRef,
      window: windowRef,
      getCards: function () {
        return documentRef.querySelectorAll('#canvas .card.bcard[data-id], #board .card.bcard[data-id]');
      },
      getScrollContainer: function () {
        return documentRef.getElementById('canvas') || documentRef.getElementById('board');
      },
      getDateButtons: function () {
        return Array.prototype.slice.call(documentRef.querySelectorAll('#datebar .datechip, #datebar .dbtn')).filter(function (button) {
          return !button.classList.contains('adddate') && String(button.textContent || '').trim().indexOf('＋') !== 0;
        });
      },
      isActiveDate: function (button) {
        return button.classList.contains('active') || button.classList.contains('on');
      },
      isBlocked: function () {
        return !!documentRef.querySelector('.modal.show, .overlay.show, #settleModal.show, #histEdit.show, #flipBackfill.show, #moreMenu.show, #reviewpage.show, #statspage.show, #statsPage.show');
      },
    });
  }

  return { install: install, autoInstall: autoInstall };
});
