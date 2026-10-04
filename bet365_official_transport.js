'use strict';

const sidecar = require('./sidecar_client.js');

const DEFAULT_HEADERS = Object.freeze({
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
});

function isBet365Unavailable(html) {
  const source = String(html || '');
  if (!source.trim()) return true;
  if (/(?:just a moment|cf-chl|challenge-platform|cloudflare)/i.test(source)) return true;
  if (/無法顯示此內容|content is unavailable|unable to display this content/i.test(source)) return true;
  if (/bl-Preloader/.test(source) && !/(?:data-item-name|data-fixture-id|gl-MarketGroup|src-Participant)/.test(source)) {
    return true;
  }
  return false;
}

async function fetchBet365Page(url, options = {}) {
  const fetchRendered = options.fetchRendered || sidecar.fetchRendered;
  const result = await fetchRendered(url, {
    headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
    waitMs: options.waitMs == null ? 8000 : Number(options.waitMs),
    waitSelector: options.waitSelector || '',
    capturePatterns: options.capturePatterns || [
      'bet365.com/defaultapi/',
      'bet365.com/sportsbook',
      '365lpodds.com',
    ],
  }, options.timeoutMs || 90000);
  const page = typeof result === 'string'
    ? { html: result, finalUrl: url, captured: [] }
    : result;
  if (!page || isBet365Unavailable(page.html)) {
    throw new Error('Bet365 official content unavailable');
  }
  return {
    html: String(page.html || ''),
    finalUrl: String(page.finalUrl || url),
    captured: Array.isArray(page.captured) ? page.captured : [],
  };
}

module.exports = {
  DEFAULT_HEADERS,
  isBet365Unavailable,
  fetchBet365Page,
};
