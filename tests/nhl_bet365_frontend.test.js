'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

function jsonResponse(value) {
  return Promise.resolve({ ok: true, status: 200, json: async () => value });
}

function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = check();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('等待 NHL 卡片逾時'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test('renders Bet365 prices, official favorite, manual swap, and the official total', async (t) => {
  const pregame = {
    updated: '2026-09-30T12:00:00.000Z',
    games: [{
      officialId: 'NHL_20261001_佛羅里@颶風_0700',
      league: 'NHL', date: '2026-10-01', time: '07:00',
      away: '佛羅里', home: '颶風', status: 'scheduled',
      awayScore: null, homeScore: null, hdFav: null, hdVal: null,
      totLine: null, hdSrc: '運彩', mlOffered: false,
    }],
  };
  const game = {
    startTime: Date.parse('2026-09-30T23:00:00Z'),
    away: 'FLA Panthers', home: 'CAR Hurricanes', awayZh: '佛羅里', homeZh: '颶風',
    ml: { market: 'Money Line', outcomes: [
      { name: 'FLA Panthers', side: 'away', odds: 2.05 },
      { name: 'CAR Hurricanes', side: 'home', odds: 1.72 },
    ] },
    hd: { market: 'Puck Line', line: 1.5, favSide: 'home', outcomes: [
      { name: 'FLA Panthers', side: 'away', line: 1.5, odds: 1.4 },
      { name: 'CAR Hurricanes', side: 'home', line: -1.5, odds: 2.85 },
    ] },
    total: { market: 'Game Totals', line: 7, outcomes: [
      { name: 'Over', side: 'over', line: 7, odds: 1.91 },
      { name: 'Under', side: 'under', line: 7, odds: 1.91 },
    ] },
  };
  game.history = [{ at: '2026-09-30T12:00:00.000Z', ml: game.ml, hd: game.hd, total: game.total }];
  game.events = [];
  const odds = {
    provider: 'bet365-official', updated: '2026-09-30T12:00:00.000Z',
    health: { status: 'ok', gameCount: 1 }, games: { sample: game },
  };

  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'nhl.html'), 'utf8'), {
    url: 'http://local.test/nhl.html',
    runScripts: 'dangerously',
    resources: {
      interceptors: [requestInterceptor((request) => {
        const parsed = new URL(request.url);
        if (parsed.hostname === 'fonts.googleapis.com') {
          return new Response('', { status: 200, headers: { 'Content-Type': 'text/css' } });
        }
        if (parsed.origin !== 'http://local.test') return new Response('', { status: 404 });
        const file = path.join(ROOT, decodeURIComponent(parsed.pathname).replace(/^\//, ''));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('', { status: 404 });
        const contentType = file.endsWith('.js') ? 'application/javascript' : 'text/plain';
        return new Response(fs.readFileSync(file), { status: 200, headers: { 'Content-Type': contentType } });
      })],
    },
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem('sportbetting_nhl_doc_v1', JSON.stringify({
        v: 1, activeDate: '2026-10-01', activeLeague: 'NHL', boards: {}, games: [],
      }));
      window.fetch = (url) => {
        const text = String(url);
        if (text.includes('nhl_pregame.json')) return jsonResponse(pregame);
        if (text.includes('nhl_bet365_odds.json')) return jsonResponse(odds);
        if (text.includes('nhl_games.json')) return jsonResponse({ games: [], count: 0 });
        if (text.includes('nhl_lottery_series.json')) return jsonResponse({});
        if (text.includes('expert_picks_nhl.json')) return jsonResponse({ picks: [] });
        return jsonResponse({});
      };
      window.confirm = () => true;
      window.alert = () => {};
      window.prompt = () => null;
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    },
  });
  t.after(() => dom.window.close());

  const card = await waitFor(() => dom.window.document.querySelector('.card.bcard'));
  assert.match(card.textContent, /BET365 ✓/);
  assert.match(card.textContent, /BET365 2\.05/);
  assert.match(card.textContent, /BET365 1\.72/);
  const monitor = card.querySelector('.market-monitor');
  assert.ok(monitor.classList.contains('source-count-2'));
  assert.match(monitor.querySelector('.market-monitor-head').textContent, /BET365颶風讓1\.5未對調/);
  assert.doesNotMatch(monitor.querySelector('.market-monitor-head').textContent, /2\.05|1\.72|官網/);

  const handicap = [...card.querySelectorAll('.bmkt')]
    .find((section) => section.querySelector('.mname')?.textContent === '讓分');
  const handicapRows = [...handicap.querySelectorAll('.bmkt-row .bnm')].map((node) => node.textContent);
  assert.match(handicapRows[0], /颶風.*-1\.5.*BET365 2\.85/);
  assert.match(handicapRows[1], /佛羅里.*\+1\.5.*BET365 1\.40/);
  assert.equal(card.querySelector('.basis input').value, '7');
  const totalRows = [...card.querySelectorAll('.bmkt')]
    .find((section) => section.querySelector('.mname')?.textContent === '大小')
    .querySelectorAll('.bmkt-row .bnm');
  assert.match(totalRows[0].textContent, /7 · BET365 1\.91/);
  assert.match(totalRows[1].textContent, /7 · BET365 1\.91/);

  card.querySelector('.bswap').click();
  const swapped = await waitFor(() => {
    const current = dom.window.document.querySelector('.card.bcard');
    const section = [...current.querySelectorAll('.bmkt')]
      .find((item) => item.querySelector('.mname')?.textContent === '讓分');
    const text = section?.querySelector('.bmkt-row .bnm')?.textContent || '';
    return text.startsWith('佛羅里') ? { current, text } : null;
  });
  assert.match(swapped.text, /-1\.5↔\+1\.5 1\.40/);
  assert.equal(
    JSON.parse(dom.window.localStorage.getItem('sportbetting_nhl_doc_v1'))
      .boards['2026-10-01'].items[0].hdFavOverride,
    'away',
  );
  assert.deepEqual(jsdomErrors, []);
});
