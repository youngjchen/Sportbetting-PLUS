'use strict';

// 2026-10-11：NBA 的 BET365 備援改用 BetExplorer 的 BET365 欄（官網靜態頁只有正規賽，季前賽沒有）。
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseListPage, parseBet365Rows, matchPageDt, collectNbaBetExplorer } = require('../nba_betexplorer.js');

const FIXTURES_HTML = `
<tr><td class="table-main__datetime">Today 23:30</td><td class="h-text-left"><a href="/basketball/usa/nba/toronto-raptors-los-angeles-clippers/UPGfglXr/" class="in-match"><span>Toronto Raptors</span> - <span>Los Angeles Clippers</span></a></td></tr>
<tr><td class="table-main__datetime">Tomorrow 01:00</td><td class="h-text-left"><a href="/basketball/usa/nba/boston-celtics-philadelphia-76ers/4Eykcjo4/" class="in-match"><span>Boston Celtics</span> - <span>Philadelphia 76ers</span></a></td></tr>`;
const RESULTS_HTML = `
<tr><td class="h-text-left"><a data-test="11396917" href="/basketball/usa/nba/chicago-bulls-memphis-grizzlies/08aTHh6N/" class="in-match"><span>Chicago Bulls</span> - <span><strong>Memphis Grizzlies</strong></span></a></td></tr>
<tr><td class="h-text-left"><a data-test="1" href="/basketball/usa/nba/chicago-bulls-memphis-grizzlies/OLDGAME1/" class="in-match"><span>Chicago Bulls</span> - <span>Memphis Grizzlies</span></a></td></tr>`;

const cell = (odd, created, inactive) => `<td class="table-main__detail-odds${inactive ? ' inactive' : ''}" data-odd="${odd}" data-created="${created}" data-bookmaker-id="16"></td>`;
const row = (bookie, line, a, b, created, inactive) => `<tr><td><a>${bookie}</a></td>${line == null ? '' : `<td class="table-main__doubleparameter">${line}</td>`}${cell(a, created, inactive)}${cell(b, created, inactive)}</tr>`;
const ODDS = {
  ha: `<table>${row('bet365', null, '1.50', '2.50', '10,10,2026,13,04')}${row('Pinnacle', null, '1.48', '2.70', '10,10,2026,13,04')}</table>`,
  ah: `<table>${row('bet365', '-4.5', '1.86', '1.86', '10,10,2026,01,02')}${row('bet365', '-6.5', '2.30', '1.60', '10,10,2026,01,02')}${row('bet365', '2.5', '1.90', '1.85', '9,10,2026,20,00', true)}</table>`,
  ou: `<table>${row('bet365', '219.5', '1.86', '1.86', '10,10,2026,00,27', true)}${row('bet365', '218.5', '1.86', '1.86', '10,10,2026,17,12')}</table>`,
};

test('列表頁讀得到比賽編號、主客隊並翻成中文（含 Los Angeles Clippers）', () => {
  const games = parseListPage(FIXTURES_HTML + RESULTS_HTML);
  assert.deepEqual(games.map((g) => [g.eventId, g.away, g.home]), [
    ['UPGfglXr', '快艇', '暴龍'], ['4Eykcjo4', '76人', '塞爾提克'], ['08aTHh6N', '灰熊', '公牛'], ['OLDGAME1', '灰熊', '公牛'],
  ]);
  assert.match(games[0].url, /\/toronto-raptors-los-angeles-clippers\/UPGfglXr\/$/);
});

test('只讀 BET365 列：線（主隊視角）、雙邊賠率、開出時間、是否撤下', () => {
  const rows = parseBet365Rows(ODDS.ah);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { line: -4.5, active: true, created: '10,10,2026,01,02', first: 1.86, second: 1.86 });
  assert.equal(rows[2].active, false);
  assert.equal(parseBet365Rows(ODDS.ha).length, 1);   // Pinnacle 那列不收
  assert.equal(matchPageDt('<li id="match-date" data-dt="10,10,2026,23,30"></li>'), '10,10,2026,23,30');
});

test('配對：同隊名＋開賽時間（站方 +7 小時）±3 小時才算同一場；賽程「塞爾提」也配得上', async () => {
  const pages = {
    'fixtures/': FIXTURES_HTML, 'results/': RESULTS_HTML,
    'UPGfglXr/': '<div id="match-date" data-dt="10,10,2026,23,30"></div>',
    '4Eykcjo4/': '<div id="match-date" data-dt="11,10,2026,1,00"></div>',
    '08aTHh6N/': '<div id="match-date" data-dt="10,10,2026,1,00"></div>',
    'OLDGAME1/': '<div id="match-date" data-dt="2,10,2026,1,00"></div>',
  };
  const requested = [];
  const fetchText = async (url) => {
    requested.push(url);
    const odds = /match-odds-old\/[^/]+\/0\/(ha|ah|ou)\//.exec(url);
    if (odds) return JSON.stringify({ odds: ODDS[odds[1]] });
    const key = Object.keys(pages).find((k) => url.endsWith(k));
    if (!key) throw new Error(`unexpected ${url}`);
    return pages[key];
  };
  const pregame = { games: [
    { officialId: 'NBA_20261011_LAC@TOR', date: '2026-10-11', time: '06:30', away: '快艇', home: '暴龍', status: 'upcoming' },
    { officialId: 'NBA_20261011_PHI@BOS', date: '2026-10-11', time: '08:00', away: '76人', home: '塞爾提', status: 'upcoming' },
    { officialId: 'NBA_20261010_MEM@CHI', date: '2026-10-10', time: '08:00', away: '灰熊', home: '公牛', status: 'finished' },
  ] };
  const out = await collectNbaBetExplorer({ fetchText, pregame, sleepMs: 0, now: Date.parse('2026-10-10T20:00:00Z') });
  assert.deepEqual(out.health.unmatched, []);
  assert.equal(out.games['NBA_20261011_PHI@BOS'].eventId, '4Eykcjo4');
  const bulls = out.games['NBA_20261010_MEM@CHI'];
  assert.equal(bulls.eventId, '08aTHh6N');                 // 8 天前那場同對戰不會被配上
  assert.equal(bulls.complete, true);
  const raptors = out.games['NBA_20261011_LAC@TOR'];
  assert.equal(raptors.complete, false);
  assert.deepEqual(raptors.ml, { home: 1.5, away: 2.5, created: '10,10,2026,13,04' });
  assert.equal(raptors.hd.length, 3);
  assert.equal(out.siteOffsetHours, 7);

  // 第二輪：已定案的比賽直接沿用，不再抓
  requested.length = 0;
  const again = await collectNbaBetExplorer({ fetchText, pregame, previous: out, sleepMs: 0, now: Date.parse('2026-10-10T20:15:00Z') });
  assert.equal(again.health.cached, 1);
  assert.equal(requested.some((u) => u.includes('08aTHh6N')), false);
});
