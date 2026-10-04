'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sidecar = require('../sidecar_client.js');
const {
  fetchBet365Page,
  isBet365Unavailable,
} = require('../bet365_official_transport.js');

test('sidecar rendered request keeps bounded render instructions', () => {
  assert.deepEqual(
    sidecar.makeSidecarRequest(7, 'https://www.bet365.com/', {}, 90000, {
      rendered: true,
      waitMs: 8000,
      waitSelector: '.event-list',
      capturePatterns: ['bet365.com/defaultapi/'],
    }),
    {
      id: 7,
      url: 'https://www.bet365.com/',
      headers: {},
      timeoutMs: 90000,
      rendered: true,
      waitMs: 8000,
      waitSelector: '.event-list',
      capturePatterns: ['bet365.com/defaultapi/'],
    }
  );
});

test('official page transport rejects the sportsbook unavailable shell', async () => {
  const unavailable = '<html><body><div>無法顯示此內容</div></body></html>';
  assert.equal(isBet365Unavailable(unavailable), true);
  await assert.rejects(
    () => fetchBet365Page('https://www.bet365.com/', {
      fetchRendered: async () => ({
        html: unavailable,
        finalUrl: 'https://www.bet365.com/#/AS/B16/',
        captured: [],
      }),
    }),
    /Bet365 official content unavailable/
  );
});

test('official page transport rejects a preloader-only response', async () => {
  const preloader = '<html><body><div class="bl-Preloader">Loading</div></body></html>';
  assert.equal(isBet365Unavailable(preloader), true);
  await assert.rejects(
    () => fetchBet365Page('https://www.bet365.com/', {
      fetchRendered: async () => ({ html: preloader, finalUrl: '', captured: [] }),
    }),
    /Bet365 official content unavailable/
  );
});

test('official page transport returns rendered event content and captures', async () => {
  const page = {
    html: '<html><body><li data-item-name="Away @ Home" data-fixture-id="1"></li></body></html>',
    finalUrl: 'https://www.bet365.com/hub/en-us/baseball/mlb',
    captured: [{ url: 'https://www.bet365.com/defaultapi/event', status: 200, body: '{"ok":true}' }],
  };
  const result = await fetchBet365Page(page.finalUrl, {
    fetchRendered: async () => page,
    waitMs: 2500,
  });

  assert.deepEqual(result, page);
});

