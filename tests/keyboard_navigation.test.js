'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

let navigation = {};
try { navigation = require('../keyboard-navigation.js'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function setup() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="dates">
      <button class="date active" data-date="2026-10-05">10/5</button>
      <button class="date" data-date="2026-10-06">10/6</button>
      <button class="date add">＋新日期</button>
    </div>
    <div id="board">
      <article class="card" data-id="a"></article>
      <article class="card" data-id="b"></article>
      <article class="card" data-id="c"></article>
    </div>
    <input id="editor">
    <div id="modal"></div>
  </body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const board = document.getElementById('board');
  board.scrollTop = 0;
  board.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400 });
  Array.from(document.querySelectorAll('.card')).forEach((card, index) => {
    card.getBoundingClientRect = () => ({
      top: 110 + index * 420 - board.scrollTop,
      bottom: 490 + index * 420 - board.scrollTop,
      height: 380,
    });
  });
  document.querySelectorAll('.date').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.classList.contains('add')) return;
      document.querySelectorAll('.date').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
    });
  });
  const controller = navigation.install({
    document,
    window,
    getCards: () => Array.from(document.querySelectorAll('.card')),
    getScrollContainer: () => board,
    getDateButtons: () => Array.from(document.querySelectorAll('.date:not(.add)')),
    isActiveDate: (button) => button.classList.contains('active'),
    isBlocked: () => document.getElementById('modal').classList.contains('show'),
  });
  return { dom, window, document, board, controller };
}

test('arrow keys move between cards and dates through the shared navigator', () => {
  assert.equal(typeof navigation.install, 'function', '尚未提供共用方向鍵導航器');
  const { window, document, board, controller } = setup();

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.querySelector('.kbd-focus')?.dataset.id, 'b');
  assert.equal(board.scrollTop, 420);

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.equal(document.querySelector('.kbd-focus')?.dataset.id, 'a');

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(document.querySelector('.date.active')?.dataset.date, '2026-10-06');

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(document.querySelector('.date.active')?.dataset.date, '2026-10-05');
  controller.destroy();
});

test('arrow keys do not hijack inputs or an open modal', () => {
  assert.equal(typeof navigation.install, 'function', '尚未提供共用方向鍵導航器');
  const { window, document, controller } = setup();
  const input = document.getElementById('editor');

  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(document.querySelector('.date.active')?.dataset.date, '2026-10-05');

  document.getElementById('modal').classList.add('show');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.querySelector('.kbd-focus'), null);
  controller.destroy();
});

test('auto installer discovers the shared sports-page card and date controls', () => {
  assert.equal(typeof navigation.autoInstall, 'function', '尚未提供三個運動頁共用的自動安裝');
  const dom = new JSDOM(`<!doctype html><body>
    <div id="datebar">
      <button class="datechip active" title="2026-10-05">10/5</button>
      <button class="datechip" title="2026-10-06">10/6</button>
      <button class="datechip adddate">＋新日期</button>
    </div>
    <main id="canvas"><article class="card bcard" data-id="game-1"></article></main>
  </body>`, { pretendToBeVisual: true });
  const { window } = dom;
  window.document.querySelectorAll('.datechip:not(.adddate)').forEach((button) => {
    button.addEventListener('click', () => {
      window.document.querySelectorAll('.datechip').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
    });
  });
  const controller = navigation.autoInstall(window.document, window);

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

  assert.equal(window.document.querySelector('.datechip.active')?.title, '2026-10-06');
  controller.destroy();
});
