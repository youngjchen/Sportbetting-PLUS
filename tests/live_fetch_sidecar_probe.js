'use strict';

// Manual live integration probe. It intentionally is not named *.test.js because
// CI/unit runs must not depend on 玩運彩 availability.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const python = process.env.PYTHON_BIN || 'python';
const sidecar = spawn(python, [path.resolve(__dirname, '..', 'fetch_sidecar.py')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const requests = [
  {
    id: 1,
    url: 'https://www.playsport.cc/billboard/winRate?allianceid=1&mode=1&during=season&page=1',
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    timeoutMs: 60000,
  },
  {
    id: 2,
    url: 'https://www.playsport.cc/member/tzuyusana061499/prediction?allianceid=1&gameday=today',
    headers: {},
    timeoutMs: 60000,
  },
];
const seen = [];
let buffer = '';
const timeout = setTimeout(() => {
  sidecar.kill();
  throw new Error('live sidecar probe timed out');
}, 180000);

function sendNext() {
  if (requests.length) {
    sidecar.stdin.write(JSON.stringify(requests.shift()) + '\n');
  } else {
    sidecar.stdin.write('{"quit":true}\n');
  }
}

sidecar.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.ready === true) {
      sendNext();
      continue;
    }
    if (message.ready === false) throw new Error(message.err);
    assert.equal(message.status, 200, message.err || JSON.stringify(message));
    const body = Buffer.from(message.b64, 'base64').toString('utf8');
    if (message.id === 1) {
      const parsed = JSON.parse(body);
      assert.ok(parsed.rankers || parsed.data || Object.keys(parsed).length, 'billboard JSON is empty');
    } else {
      assert.ok(body.length > 1000, 'member HTML is unexpectedly short');
      assert.equal(body.includes('Just a moment'), false);
      assert.equal(body.includes('challenges.cloudflare.com'), false);
    }
    seen.push({ id: message.id, layer: message.layer, bytes: Buffer.byteLength(body) });
    sendNext();
  }
});

sidecar.on('exit', (code) => {
  clearTimeout(timeout);
  assert.equal(code, 0);
  assert.equal(seen.length, 2);
  console.log(JSON.stringify(seen));
});
