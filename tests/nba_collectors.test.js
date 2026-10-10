'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractLive, mergeDayGames, collectNbaPregame } = require('../nba_scraper.js');
const { flattenSchedule, collectStakeNbaOdds } = require('../nba_stake_odds.js');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseMonth,
  parseChangeRows,
  keepPregameRows,
  parseBet365BasketballPage,
  translateBasketballTeam,
  collectBet365BasketballOdds,
} = require('../nba_bet365_odds.js');

const BET365_BASKETBALL_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'bet365-basketball-markets.html'),
  'utf8'
);

const LIVE_HTML = `
<div class="outer-gamebox" id="outer-gamebox-41137761" data-oid="NBA_20261004_MIA@TOR">
  <div class="js-gamePreviewBox">
    <table class="no_start_team"><tr><td><a>熱火</a></td><td><a>暴龍</a></td></tr></table>
    <span class="team_cinter">07:00</span>
  </div>
  <div class="js-gameOnbox" data-namea="熱火" data-nameh="暴龍" style="display:none"></div>
</div>`;

const TAIWAN_RESULT = {
  officialId: 'NBA_20261004_MIA@TOR', league: 'NBA', date: '2026-10-04', time: '07:00',
  away: '熱火', home: '暴龍', hdFav: 'home', hdVal: 3.5, hdSrc: '運彩', totLine: 229.5,
  taiwan: {
    ml: { away: 1.96, home: 1.5 },
    hd: { favorite: 'home', line: 3.5, away: 1.7, home: 1.73 },
    ou: { line: 229.5, over: 1.7, under: 1.73 },
  },
};

function groups() {
  return [{ markets: [
    { name: 'Winner (Incl. Overtime)', status: 'active', outcomes: [
      { name: 'Toronto Raptors', odds: 1.61 }, { name: 'Miami Heat', odds: 2.18 },
    ] },
    { name: 'Handicap (Incl. Overtime)', status: 'active', specifiers: 'hcp=-3.5', outcomes: [
      { name: 'Toronto Raptors (-3.5)', odds: 1.88 }, { name: 'Miami Heat (3.5)', odds: 1.83 },
    ] },
    { name: 'Total (Incl. Overtime)', status: 'active', specifiers: 'total=229.5', outcomes: [
      { name: 'Over 229.5', odds: 1.85 }, { name: 'Under 229.5', odds: 1.85 },
    ] },
  ] }];
}

test('NBA livescore 的熱火場不再被 WNBA 前綴守門丟掉', () => {
  const games = extractLive(LIVE_HTML, '2026-10-04');
  assert.equal(games.length, 1);
  assert.equal(games[0].officialId, 'NBA_20261004_MIA@TOR');
  assert.equal(games[0].status, 'upcoming');
  assert.equal(games[0].away, '熱火');
  assert.equal(games[0].home, '暴龍');
});

test('結果頁三盤覆蓋賽程骨架但保留賽事狀態', () => {
  const live = extractLive(LIVE_HTML, '2026-10-04');
  const merged = mergeDayGames(live, [TAIWAN_RESULT]);
  assert.equal(merged[0].status, 'upcoming');
  assert.deepEqual(merged[0].taiwan.ml, { away: 1.96, home: 1.5 });
  assert.equal(merged[0].hdFav, 'home');
  assert.equal(merged[0].totLine, 229.5);
});

test('玩運彩官方縮寫 GS 與結果頁自建縮寫 GSW 仍合併成同一張勇士卡', () => {
  const live = [{ officialId: 'NBA_20261005_GS@LAC', league: 'NBA', date: '2026-10-05', time: '07:00', away: '勇士', home: '快艇', status: 'upcoming' }];
  const result = [{ ...TAIWAN_RESULT, officialId: 'NBA_20261005_GSW@LAC', date: '2026-10-05', time: '07:00', away: '勇士', home: '快艇' }];
  const merged = mergeDayGames(live, result);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].officialId, 'NBA_20261005_GS@LAC');
  assert.deepEqual(merged[0].taiwan.ml, { away: 1.96, home: 1.5 });
});

test('單一日期來源只回一場時保留同日其他既有卡片，避免短暫缺漏讓比賽消失', async () => {
  const prior = { officialId: 'NBA_20261004_BOS@NYK', league: 'NBA', date: '2026-10-04', time: '08:00', away: '塞爾提克', home: '尼克', status: 'upcoming' };
  const fetchText = async (url) => url.includes('livescore') && url.includes('20261004') ? LIVE_HTML : '<html></html>';
  const output = await collectNbaPregame({ fetchText, now: Date.parse('2026-10-03T16:00:00Z'), previous: { games: [prior] } });
  assert.ok(output.games.some((game) => game.officialId === prior.officialId));
  assert.ok(output.games.some((game) => game.officialId === 'NBA_20261004_MIA@TOR'));
});

test('新鮮官方 ID 會清掉同場舊縮寫別名，避免卡片永久重複', async () => {
  const liveHtml = LIVE_HTML.replace('NBA_20261004_MIA@TOR', 'NBA_20261005_GS@LAC').replaceAll('熱火', '勇士').replaceAll('暴龍', '快艇');
  const oldAlias = { officialId: 'NBA_20261005_GSW@LAC', league: 'NBA', date: '2026-10-05', time: '07:00', away: '勇士', home: '快艇', status: 'upcoming' };
  const fetchText = async (url) => url.includes('livescore') && url.includes('20261005') ? liveHtml : '<html></html>';
  const output = await collectNbaPregame({ fetchText, now: Date.parse('2026-10-04T00:00:00Z'), previous: { games: [oldAlias] } });
  assert.equal(output.games.filter((game) => game.away === '勇士' && game.home === '快艇').length, 1);
  assert.ok(output.games.some((game) => game.officialId === 'NBA_20261005_GS@LAC'));
});

test('STAKE NBA 同時聯集季前賽與正規賽且以 slug 去重', () => {
  const fixture = { slug: 'heat-raptors', name: 'Toronto Raptors - Miami Heat', date: Date.parse('2026-10-03T23:00:00Z') };
  const payloads = [
    { schedule: [{ fixtures: [fixture] }] },
    { schedule: [{ fixtures: [fixture, { slug: 'wolves-heat', name: 'Miami Heat - Minnesota Timberwolves', date: Date.parse('2026-10-21T23:00:00Z') }] }] },
  ];
  assert.deepEqual(flattenSchedule(payloads).map((game) => game.slug), ['heat-raptors', 'wolves-heat']);
});

test('STAKE 收集器用季前賽熱火場配對官方卡片並輸出三盤', async () => {
  const start = Date.parse('2026-10-03T23:00:00Z');
  const request = async (path) => {
    if (path.endsWith('/nba-preseason')) return { schedule: [{ fixtures: [{ slug: 'heat-raptors', name: 'Toronto Raptors - Miami Heat', date: start, status: 'active' }] }] };
    if (path.endsWith('/nba')) return { schedule: [] };
    if (path === '/odds/heat-raptors') return { fixture: { slug: 'heat-raptors', name: 'Toronto Raptors - Miami Heat', date: start, status: 'active' }, groups: groups() };
    throw new Error(`unexpected ${path}`);
  };
  const output = await collectStakeNbaOdds({
    request,
    pregame: { games: [{ officialId: 'NBA_20261004_MIA@TOR', league: 'NBA', date: '2026-10-04', time: '07:00', away: '熱火', home: '暴龍' }] },
    previous: { matches: {} },
    now: Date.parse('2026-10-03T20:00:00Z'),
  });
  const game = output.matches.NBA_20261004_MIA_AT_TOR || output.matches['NBA_20261004_MIA@TOR'];
  assert.ok(game);
  assert.deepEqual(game.moneyline, { away: 2.18, home: 1.61 });
  assert.equal(game.favorite, 'home');
  assert.equal(game.line, 3.5);
  assert.equal(game.total.line, 229.5);
  assert.equal(output.health.preseason.discovered, 1);
  assert.equal(output.health.regular.discovered, 0);
});

test('Titan NBA 26-27 月檔解析主客與 ScheId', () => {
  const js = `var arrTeam=[[3,'迈阿密热火','邁亞密熱火','Miami Heat','热火','熱火','Heat'],[21,'多伦多猛龙','多倫多暴龍','Toronto Raptors','猛龙','暴龍','Raptors']];\nvar arrData=[[800001,1,'2026-10-04 07:00',21,3,null,null,'','',0,null,null,0,0,0]];`;
  assert.deepEqual(parseMonth(js), [{ scheId: 800001, startBJ: '2026-10-04 07:00', home: '暴龍', away: '熱火' }]);
});

test('Bet365 變盤只保留開賽前列，不讓場中盤污染收盤', () => {
  const html = `
    <tr><td>1.90</td><td>-4.5</td><td>1.90</td><td>10-4 07:01</td></tr>
    <tr><td>1.88</td><td>-3.5</td><td>1.92</td><td>10-4 06:59</td></tr>`;
  const rows = parseChangeRows(html);
  const pregame = keepPregameRows(rows, '2026-10-04 07:00');
  assert.deepEqual(pregame, [{ t: '10-4 06:59', line: -3.5, o1: 1.88, o2: 1.92 }]);
});

test('Bet365 官方籃球頁合併獨贏讓分大小分', () => {
  const games = parseBet365BasketballPage(BET365_BASKETBALL_HTML);
  const nba = games.find((game) => game.league === 'NBA');
  assert.equal(nba.away, '熱火');
  assert.equal(nba.home, '暴龍');
  assert.deepEqual(nba.fixtureIds, { ml: 'nba-ml', hd: 'nba-hd', total: 'nba-ou' });
  assert.equal(nba.markets.hd.favorite, 'home');
  assert.equal(nba.markets.hd.line, 3.5);
  assert.deepEqual(nba.markets.total, { line: 229.5, over: 1.85, under: 1.85 });
});

test('NBA 與 WNBA 同名隊伍使用各自聯盟翻譯', () => {
  assert.equal(translateBasketballTeam('NBA', 'PHX Suns'), '太陽');
  assert.equal(translateBasketballTeam('WNBA', 'CON Sun'), '太陽');
  assert.equal(translateBasketballTeam('WNBA', 'NY Liberty'), '自由');
});

test('籃球收集器以 Bet365 官網資料同時配對 NBA 與 WNBA', async () => {
  const output = await collectBet365BasketballOdds({
    now: Date.parse('2026-10-05T20:00:00.000Z'),
    previous: { matches: {}, leagues: {} },
    nbaPregame: { games: [{
      officialId: 'NBA_20261006_MIA@TOR', league: 'NBA', date: '2026-10-06', time: '07:00',
      away: '熱火', home: '暴龍', status: 'upcoming',
    }] },
    wnbaPregame: { games: [{
      officialId: 'WNBA_20261006_自由_美夢_0800', league: 'WNBA', date: '2026-10-06', time: '08:00',
      away: '自由', home: '美夢', status: 'upcoming',
    }] },
    betExplorer: { games: {} },
    fetchPages: async () => [{ html: BET365_BASKETBALL_HTML }],
  });

  assert.equal(output.provider, 'bet365-official-first');
  assert.equal(output.leagues.NBA.officialMatched, 1);
  assert.equal(output.leagues.WNBA.officialMatched, 1);
  assert.equal(output.matches['NBA_20261006_MIA@TOR'].provider, 'bet365-official');
  assert.equal(output.matches['NBA_20261006_MIA@TOR'].total.line, 229.5);
  assert.equal(output.matches['WNBA_20261006_自由_美夢_0800'].moneyline.away, 2.1);
});

// 2026-10-10：快艇@暴龍抓不到獨贏／讓分（Stake 賽事名「LA Clippers」、選項「Los Angeles Clippers」），
// 76人@塞爾提克配不上賽程（玩運彩賽程寫「塞爾提」）。
function clipperGroups() {
  return [{ name: 'Main', markets: [
    { name: 'Winner (Incl. Overtime)', status: 'active', outcomes: [
      { name: 'Toronto Raptors', odds: 1.51 }, { name: 'Los Angeles Clippers', odds: 2.39 }] },
    { name: 'Handicap (Incl. Overtime)', status: 'active', specifiers: 'hcp=-2.5', outcomes: [
      { name: 'Toronto Raptors (-2.5)', odds: 1.66 }, { name: 'Los Angeles Clippers (2.5)', odds: 2.09 }] },
    { name: 'Total (Incl. Overtime)', status: 'active', specifiers: 'total=215.5', outcomes: [
      { name: 'Over 215.5', odds: 1.72 }, { name: 'Under 215.5', odds: 2.01 }] },
  ] }];
}

test('STAKE 同隊異名：賽事名 LA Clippers、選項 Los Angeles Clippers 仍讀得到獨贏與讓分', async () => {
  const start = Date.parse('2026-10-10T22:00:00Z');
  const fixture = { slug: '46894505-toronto-raptors-la-clippers', name: 'Toronto Raptors - LA Clippers', date: start, status: 'active' };
  const request = async (p) => {
    if (p.endsWith('/nba-preseason')) return { schedule: [{ fixtures: [fixture] }] };
    if (p.endsWith('/nba')) return { schedule: [] };
    if (p === `/odds/${fixture.slug}`) return { fixture, groups: clipperGroups() };
    throw new Error(`unexpected ${p}`);
  };
  const output = await collectStakeNbaOdds({ request, now: Date.parse('2026-10-10T10:00:00Z'), previous: { matches: {} },
    pregame: { games: [{ officialId: 'NBA_20261011_LAC@TOR', league: 'NBA', date: '2026-10-11', time: '06:30', away: '快艇', home: '暴龍' }] } });
  const game = output.matches['NBA_20261011_LAC@TOR'];
  assert.ok(game);
  assert.deepEqual(game.moneyline, { away: 2.39, home: 1.51 });
  assert.equal(game.favorite, 'home');
  assert.equal(game.line, 2.5);
});

test('賽程寫「塞爾提」也配得上 Stake 的塞爾提克，臨時鍵的舊歷史搬到正式編號', async () => {
  const start = Date.parse('2026-10-11T00:00:00Z');
  const fixture = { slug: '46894540-boston-celtics-philadelphia-76ers', name: 'Boston Celtics - Philadelphia 76ers', date: start, status: 'active' };
  const groups = [{ name: 'Main', markets: [
    { name: 'Winner (Incl. Overtime)', status: 'active', outcomes: [{ name: 'Boston Celtics', odds: 1.51 }, { name: 'Philadelphia 76ers', odds: 2.39 }] },
  ] }];
  const request = async (p) => {
    if (p.endsWith('/nba-preseason')) return { schedule: [{ fixtures: [fixture] }] };
    if (p.endsWith('/nba')) return { schedule: [] };
    if (p === `/odds/${fixture.slug}`) return { fixture, groups };
    throw new Error(`unexpected ${p}`);
  };
  const tempKey = 'NBA_2026-10-11T00_00_76___';
  const oldHistory = [{ observedAt: '2026-10-09T10:00:00.000Z', favorite: 'home', line: 3.5, moneyline: null, handicapOdds: null, total: null }];
  const previous = { matches: { [tempKey]: { provider: 'stake-official', slug: fixture.slug, scheduledStart: new Date(start).toISOString(),
    away: '76人', home: '塞爾提克', officialId: tempKey, observedAt: '2026-10-09T10:00:00.000Z', history: oldHistory } } };
  const output = await collectStakeNbaOdds({ request, previous, now: Date.parse('2026-10-10T10:00:00Z'),
    pregame: { games: [{ officialId: 'NBA_20261011_PHI@BOS', league: 'NBA', date: '2026-10-11', time: '08:00', away: '76人', home: '塞爾提' }] } });
  assert.equal(output.matches[tempKey], undefined);
  const game = output.matches['NBA_20261011_PHI@BOS'];
  assert.ok(game);
  assert.equal(game.officialId, 'NBA_20261011_PHI@BOS');
  assert.ok(game.history.length >= 2);                     // 舊的 3.5 那筆保留、新觀測追加
  assert.equal(game.history[0].line, 3.5);
});

// ===== 2026-10-11：台彩盤沒抓到 =====
// ①完賽後玩運彩結果頁把兩隊＋比分擠在第一列（巢狀表格），舊解析整場跳過 → 下一輪把台彩盤洗成空的。
// ②賽程隊名「塞爾提」對不上代碼表 → 整天結果頁解析失敗（同一天所有比賽都沒台彩盤）。
const { parseTaiwanResult } = require('../nba_odds_core.js');
function finishedRow(gid, away, home, awayPts, homePts, bank) {
  return `
  <tr gameid="${gid}">
    <td rowspan="2" class="td-gameinfo"><div><h3>323</h3><h4>AM 08:00</h4></div></td>
    <td rowspan="2" class="td-teaminfo"><table><tbody>
      <tr><td rowspan="3" class="scores"><ul><li class="${awayPts > homePts ? 'winnerscores' : ''}"> ${awayPts} </li><li class="vsicon">V.S.</li><li class="${homePts > awayPts ? 'winnerscores' : ''}"> ${homePts} </li></ul></td>
          <td class="${awayPts > homePts ? 'winnerteam' : 'secondteam'}"><a>${away}</a></td></tr>
      <tr><td class="teamgap">&nbsp;</td></tr>
      <tr><td class="${homePts > awayPts ? 'winnerteam' : 'secondteam'}"><a>${home}</a></td></tr>
    </tbody></table></td>
    <td class="td-bank-bet01"><div><strong>客</strong><span class="data-wrap"><strong>${bank.awayHd}</strong><span>, 1.72</span></span></div></td>
    <td class="td-bank-bet03"><div><strong>客</strong><span class="data-wrap"><strong></strong><span>${bank.awayMl}</span></span></div></td>
    <td class="td-bank-bet02"><div><strong>大</strong><span class="data-wrap"><strong>${bank.total}</strong><span>, 1.75</span></span></div></td>
  </tr>
  <tr gameid="${gid}">
    <td class="td-bank-bet01"><div><strong>主</strong><span class="data-wrap"><strong>${bank.homeHd}</strong><span>, 1.72</span></span></div></td>
    <td class="td-bank-bet03"><div><strong>主</strong><span class="data-wrap"><strong></strong><span>${bank.homeMl}</span></span></div></td>
    <td class="td-bank-bet02"><div><strong>小</strong><span class="data-wrap"><strong>${bank.total}</strong><span>, 1.68</span></span></div></td>
  </tr>`;
}
const FINISHED_HTML = `<table class="gamedata-results">${
  finishedRow('2026101031001', '灰熊', '公牛', 104, 100, { awayHd: '+2.5', homeHd: '-2.5', awayMl: '1.88', homeMl: '1.56', total: '239.5' })}${
  finishedRow('2026100931001', '塞爾提', '騎士', 124, 113, { awayHd: '+3.5', homeHd: '-3.5', awayMl: '1.96', homeMl: '1.5', total: '222.5' })}${
  finishedRow('2026100939999', '外星隊', '騎士', 90, 80, { awayHd: '+1.5', homeHd: '-1.5', awayMl: '2', homeMl: '1.8', total: '200.5' })}
</table>`;

test('完賽版面讀得到兩隊、比分與台彩盤；「塞爾提」視同塞爾提克；認不得的隊只跳過那一場', () => {
  const games = parseTaiwanResult(FINISHED_HTML, '2026-10-10');
  assert.equal(games.length, 2);                                   // 外星隊那場跳過，其他照常
  const [bulls, celtics] = games;
  assert.deepEqual([bulls.officialId, bulls.away, bulls.home, bulls.awayScore, bulls.homeScore], ['NBA_20261010_MEM@CHI', '灰熊', '公牛', 104, 100]);
  assert.deepEqual([bulls.hdFav, bulls.hdVal, bulls.totLine], ['home', 2.5, 239.5]);
  assert.deepEqual(bulls.taiwan.ml, { away: 1.88, home: 1.56 });
  assert.equal(celtics.officialId, 'NBA_20261010_BOS@CLE');
  assert.equal(celtics.away, '塞爾提');
});

test('昨天與回補日以既有紀錄為底：補回台彩盤、節分不被洗掉；本輪沒讀到台彩盤時保留舊的', async () => {
  const prior = (id, date, extra = {}) => ({ officialId: id, league: 'NBA', date, time: '08:00', away: '灰熊', home: '公牛', status: 'finished',
    awayScore: 104, homeScore: 100, qAway: [30, 30, 25, 19], qHome: [27, 23, 32, 18], hdFav: null, hdVal: null,
    taiwan: { ml: null, hd: null, ou: null }, ...extra });
  const yesterday = prior('NBA_20261010_MEM@CHI', '2026-10-10');
  const backfill = { ...prior('NBA_20261007_MEM@CHI', '2026-10-07'), away: '灰熊', home: '公牛' };
  const kept = prior('NBA_20261011_MEM@CHI', '2026-10-11', { status: 'upcoming', awayScore: null, homeScore: null, qAway: [], qHome: [],
    hdFav: 'home', hdVal: 3.5, hdSrc: '運彩', totLine: 230.5, taiwan: { ml: { away: 2, home: 1.8 }, hd: { favorite: 'home', line: 3.5 }, ou: { line: 230.5 } } });
  const requested = [];
  const fetchText = async (url) => {
    requested.push(url);
    if (url.includes('gamesData/result') && url.includes('20261010')) return FINISHED_HTML;
    if (url.includes('gamesData/result') && url.includes('20261007')) return FINISHED_HTML.replaceAll('2026101031001', '2026100731001');
    if (url.includes('livescore') && url.includes('20261011')) return LIVE_HTML.replace('NBA_20261004_MIA@TOR', 'NBA_20261011_MEM@CHI').replaceAll('熱火', '灰熊').replaceAll('暴龍', '公牛');
    return '<html></html>';
  };
  const output = await collectNbaPregame({ fetchText, now: Date.parse('2026-10-10T20:00:00Z'), previous: { games: [yesterday, backfill, kept] } });
  const y = output.games.find((g) => g.officialId === 'NBA_20261010_MEM@CHI');
  assert.deepEqual([y.hdFav, y.hdVal, y.totLine], ['home', 2.5, 239.5]);    // 補回台彩盤
  assert.deepEqual(y.qAway, [30, 30, 25, 19]);                                // 節分沒被洗掉
  assert.ok(requested.some((u) => u.includes('result') && u.includes('20261007')));   // 回補日有去讀
  const b = output.games.find((g) => g.officialId === 'NBA_20261007_MEM@CHI');
  assert.equal(b.hdFav, 'home');
  const k = output.games.find((g) => g.officialId === 'NBA_20261011_MEM@CHI');
  assert.deepEqual([k.hdFav, k.hdVal, k.totLine], ['home', 3.5, 230.5]);    // 本輪只讀到即時比分 → 舊台彩盤保留
});
