'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTaiwanResult,
  parseStakeMarkets,
  matchPregameGame,
  mergeStakeObservation,
  isPregameObservation,
  translateNbaTeam,
} = require('../nba_odds_core.js');

const HEAT_RESULT_HTML = `
<table class="gamedata-results">
  <tr gameid="2026100431001">
    <td class="td-gameinfo"><h4>359 AM 07:00</h4></td>
    <td class="td-teaminfo">熱火</td>
    <td class="td-bank-bet01">客+3.5, 1.7</td>
    <td class="td-bank-bet03">客1.96</td>
    <td class="td-bank-bet02"><div class="data-wrap"><strong>229.5</strong></div>大229.5, 1.7</td>
  </tr>
  <tr gameid="2026100431001">
    <td class="td-teaminfo">暴龍</td>
    <td class="td-bank-bet01">主-3.5, 1.73</td>
    <td class="td-bank-bet03">主1.5</td>
    <td class="td-bank-bet02">小229.5, 1.73</td>
  </tr>
</table>`;

function stakeGroups() {
  return [{
    name: 'Main',
    markets: [
      {
        name: 'Winner (Incl. Overtime)', status: 'active', outcomes: [
          { name: 'Toronto Raptors', odds: 1.61 },
          { name: 'Miami Heat', odds: 2.18 },
        ],
      },
      ...[
        [-1.5, 1.68, 2.07],
        [-3.5, 1.88, 1.83],
        [-5.5, 2.09, 1.66],
      ].map(([line, home, away]) => ({
        name: 'Handicap (Incl. Overtime)', status: 'active', specifiers: `hcp=${line}`,
        outcomes: [
          { name: `Toronto Raptors (${line})`, odds: home },
          { name: `Miami Heat (${Math.abs(line)})`, odds: away },
        ],
      })),
      ...[
        [227.5, 1.70, 2.03],
        [229.5, 1.85, 1.85],
        [231.5, 2.02, 1.71],
      ].map(([line, over, under]) => ({
        name: 'Total (Incl. Overtime)', status: 'active', specifiers: `total=${line}`,
        outcomes: [
          { name: `Over ${line}`, odds: over },
          { name: `Under ${line}`, odds: under },
        ],
      })),
      {
        name: 'Miami Heat Total (Incl. Overtime)', status: 'active', specifiers: 'total=113.5',
        outcomes: [{ name: 'Over 113.5', odds: 1.84 }, { name: 'Under 113.5', odds: 1.79 }],
      },
    ],
  }];
}

test('台彩結果頁保留熱火場三個盤別的雙邊賠率', () => {
  const games = parseTaiwanResult(HEAT_RESULT_HTML, '2026-10-04');
  assert.equal(games.length, 1);
  assert.deepEqual(games[0], {
    officialId: 'NBA_20261004_MIA@TOR',
    gid: '2026100431001',
    league: 'NBA',
    date: '2026-10-04',
    time: '07:00',
    away: '熱火',
    home: '暴龍',
    awayScore: null,
    homeScore: null,
    hdFav: 'home',
    hdVal: 3.5,
    hdSrc: '運彩',
    totLine: 229.5,
    mlOffered: true,
    taiwan: {
      ml: { away: 1.96, home: 1.5 },
      hd: { favorite: 'home', line: 3.5, away: 1.7, home: 1.73 },
      ou: { line: 229.5, over: 1.7, under: 1.73 },
    },
  });
});

test('STAKE 選擇雙邊賠率最接近的全場讓分與大小基準線', () => {
  const fixture = { name: 'Toronto Raptors - Miami Heat' };
  const market = parseStakeMarkets(stakeGroups(), fixture);
  assert.deepEqual(market.moneyline, { away: 2.18, home: 1.61 });
  assert.equal(market.favorite, 'home');
  assert.equal(market.line, 3.5);
  assert.deepEqual(market.handicapOdds, { away: 1.83, home: 1.88 });
  assert.deepEqual(market.total, { line: 229.5, over: 1.85, under: 1.85 });
});

test('STAKE 不把單隊大小分誤當成全場大小分', () => {
  const market = parseStakeMarkets(stakeGroups(), { name: 'Toronto Raptors - Miami Heat' });
  assert.notEqual(market.total.line, 113.5);
});

test('英文字隊名明確翻成板面繁中隊名', () => {
  assert.equal(translateNbaTeam('Miami Heat'), '熱火');
  assert.equal(translateNbaTeam('Toronto Raptors'), '暴龍');
  assert.throws(() => translateNbaTeam('Unknown Expansion Club'), /未知 NBA 隊名/);
});

test('STAKE 主隊在 fixture title 前面，仍能配對玩運彩客隊在前的比賽', () => {
  const stake = {
    scheduledStart: '2026-10-03T23:00:00.000Z',
    away: '熱火', home: '暴龍',
  };
  const pregame = [
    { officialId: 'NBA_20261004_MIA@TOR', date: '2026-10-04', time: '07:00', away: '熱火', home: '暴龍' },
  ];
  assert.equal(matchPregameGame(stake, pregame).officialId, 'NBA_20261004_MIA@TOR');
});

test('觀測完成落在開賽前最後三十秒即拒絕', () => {
  const start = '2026-10-03T23:00:00.000Z';
  assert.equal(isPregameObservation(start, '2026-10-03T22:59:29.999Z'), true);
  assert.equal(isPregameObservation(start, '2026-10-03T22:59:30.000Z'), false);
  assert.equal(isPregameObservation(start, '2026-10-03T23:00:01.000Z'), false);
});

test('最後三十秒的新盤被拒絕並凍結上一筆有效 STAKE 資料', () => {
  const previous = {
    officialId: 'NBA_20261004_MIA@TOR',
    scheduledStart: '2026-10-03T23:00:00.000Z',
    favorite: 'home', line: 3.5,
    moneyline: { away: 2.18, home: 1.61 },
    handicapOdds: { away: 1.83, home: 1.88 },
    total: { line: 229.5, over: 1.85, under: 1.85 },
    observedAt: '2026-10-03T22:58:00.000Z',
    history: [{
      observedAt: '2026-10-03T22:58:00.000Z', favorite: 'home', line: 3.5,
      moneyline: { away: 2.18, home: 1.61 },
      handicapOdds: { away: 1.83, home: 1.88 },
      total: { line: 229.5, over: 1.85, under: 1.85 },
    }],
  };
  const current = { ...previous, favorite: 'away', line: 1.5 };
  const merged = mergeStakeObservation(previous, current, '2026-10-03T22:59:45.000Z');
  assert.equal(merged.favorite, 'home');
  assert.equal(merged.line, 3.5);
  assert.equal(merged.frozenAt, '2026-10-03T22:59:45.000Z');
  assert.equal(merged.history.length, 1);
});

test('相同快照不重複、盤口變化才追加歷史', () => {
  const current = {
    officialId: 'NBA_20261004_MIA@TOR',
    scheduledStart: '2026-10-03T23:00:00.000Z',
    favorite: 'home', line: 3.5,
    moneyline: { away: 2.18, home: 1.61 },
    handicapOdds: { away: 1.83, home: 1.88 },
    total: { line: 229.5, over: 1.85, under: 1.85 },
  };
  const first = mergeStakeObservation(null, current, '2026-10-03T20:00:00.000Z');
  const same = mergeStakeObservation(first, current, '2026-10-03T20:05:00.000Z');
  const changed = mergeStakeObservation(same, { ...current, total: { line: 230.5, over: 1.9, under: 1.8 } }, '2026-10-03T20:10:00.000Z');
  assert.equal(first.history.length, 1);
  assert.equal(same.history.length, 1);
  assert.equal(changed.history.length, 2);
});
