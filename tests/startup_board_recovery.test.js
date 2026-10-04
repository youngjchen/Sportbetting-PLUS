'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('function startupDateFor(');
const end = html.indexOf('/* ---------------- team stats', start);

assert.ok(start >= 0, 'index.html 必須提供 startupDateFor() 啟動日期守門');
assert.ok(end > start, '找不到 startupDateFor() 測試區段結尾');

const sandbox = {};
vm.runInNewContext(`${html.slice(start, end)}\nthis.startupDateFor = startupDateFor;`, sandbox);

test('跨日後今天是空盤時，先顯示最近一個有卡片的日期', () => {
  const doc = {
    activeDate: '2026-10-05',
    boards: {
      '2026-10-02': { items: [{ type: 'match' }] },
      '2026-10-04': { items: [{ type: 'match' }, { type: 'match' }] },
      '2026-10-05': { items: [] },
    },
  };

  assert.equal(sandbox.startupDateFor(doc, '2026-10-05'), '2026-10-04');
});

test('今天已有卡片時仍然直接進今天', () => {
  const doc = {
    activeDate: '2026-10-04',
    boards: {
      '2026-10-04': { items: [{ type: 'match' }] },
      '2026-10-05': { items: [{ type: 'match' }] },
    },
  };

  assert.equal(sandbox.startupDateFor(doc, '2026-10-05'), '2026-10-05');
});

test('完全沒有卡片的新使用者仍停在今天', () => {
  const doc = {
    activeDate: '2026-10-05',
    boards: {
      '2026-10-05': { items: [] },
    },
  };

  assert.equal(sandbox.startupDateFor(doc, '2026-10-05'), '2026-10-05');
});

test('不會跳到今天之後的未來盤', () => {
  const doc = {
    activeDate: '2026-10-05',
    boards: {
      '2026-10-04': { items: [{ type: 'match' }] },
      '2026-10-05': { items: [] },
      '2026-10-06': { items: [{ type: 'match' }] },
    },
  };

  assert.equal(sandbox.startupDateFor(doc, '2026-10-05'), '2026-10-04');
});
