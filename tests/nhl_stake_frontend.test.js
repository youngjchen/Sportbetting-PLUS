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
      if (Date.now() - started > timeoutMs) return reject(new Error('等待 Stake NHL 卡片逾時'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test('renders Stake ML/HD/OU as primary and keeps Bet365 as reference', async (t) => {
  const pregame = {
    updated: '2026-10-01T00:30:00.000Z',
    games: [{
      officialId: 'NHL_20261001_企鵝@飛人_0730',
      league: 'NHL', date: '2026-10-01', time: '07:30',
      away: '企鵝', home: '飛人', status: 'finished',
      awayScore: 4, homeScore: 1, hdFav: null, hdVal: null,
      totLine: null, hdSrc: '運彩', mlOffered: false,
    }],
  };
  const stakeGame = {
    eventId: 'stake-1', league: 'nhl', date: '2026-10-01', startTime: '07:30',
    startISO: '2026-10-01T07:30:00+08:00', awayTeam: '企鵝', homeTeam: '飛人',
    sourceUrl: 'https://www.oddsportal.com/hockey/h2h/example/#stake-1',
    markets: {
      ml: {
        open: { away: 2.15, home: 1.75 },
        active: { away: 2.05, home: 1.82 },
      },
      hd: {
        open: { line: 1.5, favorite: 'away', away: 2.7, home: 1.45 },
        active: { line: 1.5, favorite: 'away', away: 2.55, home: 1.5 },
      },
      ou: {
        open: { line: 6.0, over: 1.95, under: 1.85 },
        active: { line: 6.5, over: 2.02, under: 1.8 },
      },
    },
  };
  const stakeFeed = {
    source: 'OddsPortal', bookmaker: 'Stake.com', league: 'nhl',
    updatedAt: '2026-10-01T00:30:00+08:00', health: { succeeded: 1 },
    games: { one: stakeGame },
  };
  const betGame = {
    startTime: Date.parse('2026-09-30T23:30:00Z'),
    away: 'PIT Penguins', home: 'PHI Flyers', awayZh: '企鵝', homeZh: '飛人',
    ml: { outcomes: [{ side: 'away', odds: 2.25 }, { side: 'home', odds: 1.65 }] },
    hd: { line: 2.5, favSide: 'home', outcomes: [
      { side: 'away', line: 2.5, odds: 1.5 }, { side: 'home', line: -2.5, odds: 2.5 },
    ] },
  };
  betGame.history = [{ at: '2026-10-01T00:30:00.000Z', ml: betGame.ml, hd: betGame.hd }];
  betGame.events = [];
  const betFeed = {
    provider: 'bet365-official', updated: '2026-10-01T00:30:00.000Z',
    health: { status: 'ok', gameCount: 1 }, games: { one: betGame },
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
        return new Response(fs.readFileSync(file), {
          status: 200,
          headers: { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : 'text/plain' },
        });
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
        if (text.includes('nhl_oddsportal_stake.json')) return jsonResponse(stakeFeed);
        if (text.includes('nhl_bet365_odds.json')) return jsonResponse(betFeed);
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

  const card = await waitFor(() => {
    const current = dom.window.document.querySelector('.card.bcard');
    return current && /STAKE ✓/.test(current.textContent) ? current : null;
  });
  assert.match(card.textContent, /STAKE 2\.05/);
  assert.match(card.textContent, /STAKE 1\.82/);
  assert.match(card.textContent, /BET365 參考/);

  const sections = [...card.querySelectorAll('.bmkt')];
  const handicap = sections.find((section) => section.querySelector('.mname')?.textContent === '讓分');
  const handicapRows = [...handicap.querySelectorAll('.bmkt-row .bnm')].map((node) => node.textContent);
  assert.match(handicapRows[0], /企鵝.*-1\.5.*STAKE 2\.55/);
  assert.match(handicapRows[1], /飛人.*\+1\.5.*STAKE 1\.50/);

  const total = sections.find((section) => section.querySelector('.mname')?.textContent === '大小');
  const totalRows = [...total.querySelectorAll('.bmkt-row .bnm')].map((node) => node.textContent);
  assert.equal(card.querySelector('.basis input').value, '6.5');
  assert.match(totalRows[0], /大.*6\.5.*STAKE 2\.02/);
  assert.match(totalRows[1], /小.*6\.5.*STAKE 1\.80/);

  card.querySelector('.bbadge').click();
  assert.equal(dom.window.document.querySelector('#openOddsAway').value, '2.15');
  assert.equal(dom.window.document.querySelector('#openOddsHome').value, '1.75');
  assert.equal(dom.window.document.querySelector('#closeOddsAway').value, '2.05');
  assert.equal(dom.window.document.querySelector('#closeOddsHome').value, '1.82');
  assert.equal(dom.window.document.querySelector('#settleOpenHd').value, '1.5');
  assert.equal(dom.window.document.querySelector('#settleCloseHd').value, '1.5');
  assert.match(dom.window.document.querySelector('#settleBody').textContent, /STAKE 主盤/);
  dom.window.document.querySelector('#settleCancel').click();

  const settledDoc = JSON.parse(dom.window.localStorage.getItem('sportbetting_nhl_doc_v1'));
  const autoSettled = settledDoc.boards['2026-10-01'].items[0].settled;
  assert.equal(autoSettled.ml, 'away');
  assert.equal(autoSettled.hd, 'cover');
  assert.equal(autoSettled.tot, 'under');
  assert.equal(settledDoc.games[0].mlOffered, true);

  card.querySelector('.bswap').click();
  const swapped = await waitFor(() => {
    const current = dom.window.document.querySelector('.card.bcard');
    const section = [...current.querySelectorAll('.bmkt')]
      .find((item) => item.querySelector('.mname')?.textContent === '讓分');
    const text = section?.querySelector('.bmkt-row .bnm')?.textContent || '';
    return text.startsWith('飛人') ? { current, text } : null;
  });
  assert.match(swapped.text, /-1\.5↔\+1\.5 1\.50/);

  const totalInput = swapped.current.querySelector('.basis input');
  totalInput.value = '7.5';
  totalInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const saved = JSON.parse(dom.window.localStorage.getItem('sportbetting_nhl_doc_v1'));
  assert.equal(saved.boards['2026-10-01'].items[0].hdFavOverride, 'home');
  assert.equal(saved.boards['2026-10-01'].items[0].totVal, '7.5');
  assert.deepEqual(jsdomErrors, []);
});
