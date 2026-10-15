'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const jsonResponse = (value) => Promise.resolve({ ok: true, status: 200, json: async () => value });

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

// 已過 Stake 開賽時間、最後一筆在開賽前 3 分：卡片標「STAKE 收盤」並沿用 Stake 收盤盤口，不換成 BET365、不標停更
test('started game keeps Stake closing odds and is labelled closed, not stopped', async (t) => {
  const startMs = Date.now() - 60 * 60 * 1000;
  const tw = new Date(startMs + 8 * 3600 * 1000).toISOString();
  const date = tw.slice(0, 10), time = tw.slice(11, 16);
  const officialId = `NHL_${date.replace(/-/g, '')}_颶風@飛人_${time.replace(':', '')}`;
  const pregame = {
    updated: new Date().toISOString(),
    games: [{
      officialId, league: 'NHL', date, time, away: '颶風', home: '飛人',
      status: 'inprogress', awayScore: 1, homeScore: 1, hdFav: null, hdVal: null, totLine: null, hdSrc: '運彩',
    }],
  };
  const lastPregameAt = new Date(startMs - 3 * 60 * 1000).toISOString();
  const stakeFeed = {
    provider: 'stake-official', updated: new Date().toISOString(),
    games: { one: {
      league: 'nhl', startISO: new Date(startMs).toISOString(), date, startTime: time,
      awayTeam: '颶風', homeTeam: '飛人', lastPregameAt,
      markets: {
        ml: { active: { away: 1.4, home: 3.0 } },
        hd: { active: { line: 1.5, favorite: 'away', away: 2.4, home: 1.5 } },
        ou: { active: { line: 6.5, over: 1.9, under: 1.9 } },
      },
      history: [{ at: lastPregameAt, hd: { line: 1.5, favSide: 'away', outcomes: [
        { side: 'away', line: -1.5, odds: 2.4 }, { side: 'home', line: 1.5, odds: 1.5 },
      ] } }],
    } },
  };
  const betGame = {
    startTime: startMs, awayZh: '颶風', homeZh: '飛人', away: 'CAR Hurricanes', home: 'PHI Flyers',
    ml: { outcomes: [{ side: 'away', odds: 2.2 }, { side: 'home', odds: 1.7 }] },
    hd: { line: 2.5, favSide: 'home', outcomes: [
      { side: 'away', line: 2.5, odds: 1.5 }, { side: 'home', line: -2.5, odds: 2.5 },
    ] },
    history: [], events: [],
  };
  const betFeed = { provider: 'bet365-official', updated: new Date().toISOString(), games: { one: betGame } };
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'nhl.html'), 'utf8'), {
    url: 'http://local.test/nhl.html', runScripts: 'dangerously', pretendToBeVisual: true,
    resources: { interceptors: [requestInterceptor((request) => {
      const parsed = new URL(request.url);
      if (parsed.hostname === 'fonts.googleapis.com') return new Response('', { status: 200 });
      if (parsed.origin !== 'http://local.test') return new Response('', { status: 404 });
      const file = path.join(ROOT, decodeURIComponent(parsed.pathname).replace(/^\//, ''));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('', { status: 404 });
      return new Response(fs.readFileSync(file), { status: 200, headers: {
        'Content-Type': file.endsWith('.js') ? 'application/javascript' : 'text/plain',
      } });
    })] },
    virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem('sportbetting_nhl_doc_v1', JSON.stringify({
        v: 1, activeDate: date, activeLeague: 'NHL', boards: {}, games: [],
      }));
      window.fetch = (url) => {
        const text = String(url);
        if (text.includes('nhl_pregame.json')) return jsonResponse(pregame);
        if (text.includes('stake_api_odds.json')) return jsonResponse(stakeFeed);
        if (text.includes('nhl_bet365_odds.json')) return jsonResponse(betFeed);
        if (text.includes('nhl_games.json')) return jsonResponse({ games: [] });
        if (text.includes('expert_picks_nhl.json')) return jsonResponse({ picks: [] });
        return jsonResponse({});
      };
      window.confirm = () => true;
      window.alert = () => {};
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    },
  });
  t.after(() => dom.window.close());

  const card = await waitFor(() => {
    const current = dom.window.document.querySelector('.card.bcard');
    return current && /STAKE 收盤/.test(current.textContent) ? current : null;
  });
  assert.doesNotMatch(card.textContent, /停更/);
  const monitorHead = card.querySelector('.market-monitor-head');
  assert.match(monitorHead.textContent, /STAKE颶風讓1\.5/);
  const handicap = [...card.querySelectorAll('.bmkt')]
    .find((section) => section.querySelector('.mname')?.textContent === '讓分');
  assert.match(handicap.querySelector('.bmkt-row .bnm').textContent, /颶風.*STAKE 2\.40/);
  assert.deepEqual(jsdomErrors, []);
});
