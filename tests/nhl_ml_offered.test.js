'use strict';

// 獨贏有沒有開（2026-11-15）：冰球以 Stake／BET365 為準，台彩口徑的 false（種子檔每場都是）不得把紀錄改成「沒開」。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const DOC_KEY = 'sportbetting_nhl_doc_v1';

const jsonResponse = (value) => Promise.resolve({ ok: true, status: 200, json: async () => value });
function waitFor(check, timeoutMs = 4000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value; try { value = check(); } catch (error) { return reject(error); }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('等待逾時'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function openBoard(t, doc, feeds) {
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
        return new Response(fs.readFileSync(file), { status: 200,
          headers: { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : 'text/plain' } });
      })],
    },
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem(DOC_KEY, JSON.stringify(doc));
      window.localStorage.setItem(`${DOC_KEY}_archive_seen`, new Date().toISOString());   // 這裡不測存檔補齊
      window.fetch = (url) => {
        const text = String(url);
        if (text.includes('nhl_pregame.json')) return jsonResponse(feeds.pregame || { games: [] });
        if (text.includes('stake_api_odds.json')) return jsonResponse(feeds.stake || { provider: 'stake-official', games: {} });
        if (text.includes('nhl_bet365_odds.json')) return jsonResponse(feeds.b365 || { provider: 'bet365-official', games: {} });
        if (text.includes('nhl_games.json')) return jsonResponse(feeds.seed || { games: [], count: 0 });
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
  const saved = () => JSON.parse(dom.window.localStorage.getItem(DOC_KEY));
  return { dom, jsdomErrors, saved };
}

const rec = (date, away, home, extra = {}) => ({
  sid: `NHL_${date.replace(/-/g, '')}_${away}@${home}_0800`, date, league: 'NHL', awayTeam: away, homeTeam: home,
  awayScore: 3, homeScore: 2, hdFav: 'home', hdVal: 1.5, totBasis: 6.5, mlOffered: false, ...extra });
const seedOf = (r) => ({ ...r, hdFav: null, hdVal: null, totBasis: null, mlOffered: false });   // 種子＝台彩口徑

test('一次性更正：git 歷史有獨贏證據的舊場改回有開（手動結算也改），沒有證據的不動', async (t) => {
  const games = [
    rec('2026-11-12', '閃電', '軍刀'),                        // 表上有
    rec('2026-10-04', '國王', '鯊魚', { manual: true }),      // 表上有、手動結算 → 只改這一欄
    rec('2026-11-20', '甲隊', '乙隊'),                        // 表上沒有 → 不動
  ];
  const { dom, jsdomErrors, saved } = openBoard(t, { v: 1, activeDate: '2026-11-12', activeLeague: 'NHL', boards: {}, games, gamesVersion: 1 }, {});
  await waitFor(() => dom.window.document.querySelector('#stamp'));
  const doc = await waitFor(() => { const d = saved(); return d.games.find((g) => g.awayTeam === '閃電').mlOffered === true ? d : null; });
  assert.equal(doc.games.find((g) => g.awayTeam === '國王').mlOffered, true);
  assert.equal(doc.games.find((g) => g.awayTeam === '國王').manual, true);
  assert.equal(doc.games.find((g) => g.awayTeam === '國王').totBasis, 6.5);
  assert.equal(doc.games.find((g) => g.awayTeam === '甲隊').mlOffered, false);
  assert.ok(doc.gamesVersion > 1);
  assert.deepEqual(jsdomErrors, []);
});

test('載入種子：台彩口徑的 false 不蓋掉紀錄；本機沒有的場視為有開', async (t) => {
  const kept = rec('2026-11-20', '甲隊', '乙隊', { mlOffered: true });
  const fresh = rec('2026-11-21', '丙隊', '丁隊');
  const seed = { count: 2, builtAt: '2026-11-22T00:00:00Z', games: [seedOf(kept), seedOf(fresh)] };
  const { jsdomErrors, saved } = openBoard(t, { v: 1, activeDate: '2026-11-21', activeLeague: 'NHL', boards: {}, games: [kept] }, { seed });
  const doc = await waitFor(() => { const d = saved(); return d.games.some((g) => g.awayTeam === '丙隊') ? d : null; });
  assert.equal(doc.games.find((g) => g.awayTeam === '甲隊').mlOffered, true);
  assert.equal(doc.games.find((g) => g.awayTeam === '甲隊').hdVal, 1.5);       // 讓分線照舊保留
  assert.equal(doc.games.find((g) => g.awayTeam === '丙隊').mlOffered, true);
  assert.deepEqual(jsdomErrors, []);
});

test('自動結算：盤口已滾出資料檔時沿用紀錄的「有開」，不再改成沒開', async (t) => {
  const old = rec('2026-11-20', '甲隊', '乙隊', { mlOffered: true });
  const pregame = { updated: new Date().toISOString(), games: [{
    officialId: old.sid, league: 'NHL', date: old.date, time: '08:00', away: '甲隊', home: '乙隊', status: 'finished',
    awayScore: 3, homeScore: 2, hdFav: null, hdVal: null, totLine: null, hdSrc: '運彩', mlOffered: false }] };
  const { dom, jsdomErrors, saved } = openBoard(t, { v: 1, activeDate: old.date, activeLeague: 'NHL', boards: {}, games: [old] }, { pregame });
  await waitFor(() => dom.window.document.querySelector('.card.bcard'));
  const doc = await waitFor(() => { const d = saved(); const it = d.boards[old.date] && d.boards[old.date].items.find((x) => x.id === old.sid); return it && it.settled ? d : null; });
  assert.equal(doc.games.find((g) => g.sid === old.sid).mlOffered, true);
  assert.deepEqual(jsdomErrors, []);
});
