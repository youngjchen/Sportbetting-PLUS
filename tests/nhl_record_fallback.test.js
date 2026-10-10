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

// 比賽資料檔只剩 10/03（10/01 已滾出）；10/01 只有本機比賽紀錄
const pregame = {
  updated: '2026-10-03T00:30:00.000Z',
  games: [{
    officialId: 'NHL_20261003_藍調@達拉斯_0900',
    league: 'NHL', date: '2026-10-03', time: '09:00',
    away: '藍調', home: '達拉斯', status: 'finished',
    awayScore: 4, homeScore: 0, hdFav: null, hdVal: null, totLine: null, hdSrc: '運彩',
  }],
};
const stakeFeed = {
  provider: 'stake-official', mode: 'official-page',
  updated: new Date().toISOString(), health: { succeeded: 1 },
  games: { one: {
    eventId: 'stake-1', league: 'nhl', date: '2026-10-03', startTime: '09:00',
    startISO: '2026-10-03T09:00:00+08:00', awayTeam: '藍調', homeTeam: '達拉斯',
    sourceMode: 'official-page', sourceUrl: 'https://stake.com/sports/ice-hockey/usa/nhl/stake-1',
    markets: {
      ml: { open: { away: 2.1, home: 1.8 }, active: { away: 2.0, home: 1.85 } },
      hd: { open: { line: 1.5, favorite: 'home', away: 1.45, home: 2.7 },
            active: { line: 1.5, favorite: 'home', away: 1.5, home: 2.6 } },
      ou: { open: { line: 5.5, over: 1.8, under: 2.0 }, active: { line: 6, over: 1.95, under: 1.85 } },
    },
    history: [],
  } },
};
const records = [
  { sid: 'NHL_20261001_企鵝@飛人_0730', date: '2026-10-01', league: 'NHL', awayTeam: '企鵝', homeTeam: '飛人',
    awayScore: 7, homeScore: 0, hdFav: 'away', hdVal: 1.5, totBasis: 6.25 },
  { sid: 'NHL_20261001_國王@火焰_1000', date: '2026-10-01', league: 'NHL', awayTeam: '國王', homeTeam: '火焰',
    awayScore: 4, homeScore: 8, hdFav: 'home', hdVal: 1.5, totBasis: null },
];

function openBoard(t, activeDate, docOverride) {
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
      window.localStorage.setItem('sportbetting_nhl_doc_v1', JSON.stringify(docOverride || {
        v: 1, activeDate, activeLeague: 'NHL', boards: {}, games: JSON.parse(JSON.stringify(records)),
      }));
      window.fetch = (url) => {
        const text = String(url);
        if (text.includes('nhl_pregame.json')) return jsonResponse(pregame);
        if (text.includes('stake_api_odds.json')) return jsonResponse(stakeFeed);
        if (text.includes('nhl_bet365_odds.json')) return jsonResponse({ provider: 'bet365-official', games: {} });
        if (text.includes('nhl_games.json')) return jsonResponse({ games: [], count: 0 });
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
  return { dom, jsdomErrors };
}

const section = (card, name) => [...card.querySelectorAll('.bmkt')]
  .find((node) => node.querySelector('.mname')?.textContent === name);

test('比賽資料檔滾掉的舊日期：用本機比賽紀錄畫卡片，大小用紀錄的線、沒有線才用預設 6.5', async (t) => {
  const { dom, jsdomErrors } = openBoard(t, '2026-10-01');
  const cards = await waitFor(() => {
    const list = [...dom.window.document.querySelectorAll('.card.bcard')];
    return list.length === 2 ? list : null;
  });
  const penguins = cards.find((card) => /企鵝/.test(card.textContent));
  assert.equal(penguins.querySelector('.basis input').value, '6.25');
  assert.match(section(penguins, '讓分').querySelector('.bmkt-row .bnm').textContent, /企鵝.*-1\.5/);
  const kings = cards.find((card) => /國王/.test(card.textContent));
  assert.equal(kings.querySelector('.basis input').value, '6.5');          // 紀錄也沒有大小線 → 預設

  // 舊日期不會重新自動結算，紀錄的大小線不被改寫
  const saved = JSON.parse(dom.window.localStorage.getItem('sportbetting_nhl_doc_v1'));
  assert.equal(saved.games.find((g) => g.awayTeam === '企鵝').totBasis, 6.25);
  assert.equal(saved.games.find((g) => g.awayTeam === '國王').totBasis, null);
  assert.deepEqual(jsdomErrors, []);
});

test('卡片恢復顯示大小基準線變動（開盤 5.5 → 收盤 6）', async (t) => {
  const { dom, jsdomErrors } = openBoard(t, '2026-10-03');
  const card = await waitFor(() => {
    const current = dom.window.document.querySelector('.card.bcard');
    return current && /STAKE/.test(current.textContent) ? current : null;
  });
  assert.match(section(card, '大小').textContent, /基準 5\.5→6/);
  assert.doesNotMatch(section(card, '讓分').textContent, /換邊|歷史/);   // 換邊次數只在上方監控列顯示
  assert.equal(card.querySelector('.basis input').value, '6');
  assert.deepEqual(jsdomErrors, []);
});

test('一次性大小線更正：預設 6.5 改成 Stake 收盤、空的補玩運彩，手填與手動結算不動', async (t) => {
  const rec = (date, away, home, a, h, totBasis, extra = {}) => ({
    sid: `NHL_${date.replace(/-/g, '')}_${away}@${home}_0700`, date, league: 'NHL', awayTeam: away, homeTeam: home,
    awayScore: a, homeScore: h, hdFav: 'home', hdVal: 1.5, totBasis, ...extra });
  const games = [
    rec('2026-10-02', '閃電', '遊騎兵', 1, 5, 6.5),                    // 6 球：小 → 走
    rec('2026-10-05', '猛瑪象', '遊騎兵', 2, 4, 6.5),                  // 6 球：小 → 大（5.5）
    rec('2026-09-30', '佛羅里', '颶風', 1, 0, null),                    // 空 → 6.25
    rec('2026-10-04', '魔鬼', '島人', 0, 6, 6.5),                     // 使用者手填 6.5 → 不動
    rec('2026-10-04', '國王', '鯊魚', 4, 5, 6.5, { manual: true }),  // 手動結算 → 不動
    rec('2026-10-03', '巨鴨', '騎士', 4, 3, 6.5),                     // 不在更正表 → 不動
  ];
  const item = (g, extra = {}) => ({ id: g.sid, settled: { awayScore: g.awayScore, homeScore: g.homeScore, tot: 'under' }, ...extra });
  const boards = {
    '2026-10-02': { items: [item(games[0])] },
    '2026-10-05': { items: [item(games[1])] },
    '2026-10-04': { items: [item(games[3], { totVal: '6.5' }), item(games[4])] },
  };
  const { dom, jsdomErrors } = openBoard(t, '2026-10-03', { v: 1, activeDate: '2026-10-03', activeLeague: 'NHL', boards, games, gamesVersion: 3 });
  await waitFor(() => dom.window.document.querySelector('.card.bcard'));
  const saved = JSON.parse(dom.window.localStorage.getItem('sportbetting_nhl_doc_v1'));
  const line = (away) => saved.games.find((g) => g.awayTeam === away).totBasis;
  const settled = (date, away) => saved.boards[date].items.find((it) => it.id.includes(`_${away}@`)).settled.tot;
  assert.deepEqual([line('閃電'), line('猛瑪象'), line('佛羅里')], [6, 5.5, 6.25]);
  assert.equal(settled('2026-10-02', '閃電'), 'push');
  assert.equal(settled('2026-10-05', '猛瑪象'), 'over');
  assert.deepEqual([line('魔鬼'), line('國王'), line('巨鴨')], [6.5, 6.5, 6.5]);
  assert.equal(settled('2026-10-04', '魔鬼'), 'under');
  assert.ok(saved.gamesVersion > 3);                                     // 隊伍統計快取要重算
  assert.deepEqual(jsdomErrors, []);
});
