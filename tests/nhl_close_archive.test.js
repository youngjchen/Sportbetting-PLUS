'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NhlStake = require('../nhl_stake_core.js');
const NhlBet365 = require('../nhl_bet365_core.js');
const { buildGames, slimHistory, slimStakeGame, slimB365Game, run } = require('../nhl_close_archive.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-11-15T00:00:00Z');

function hd(fav, line, away, home, at) {
  return { at, hd: { market: 'Handicap', line, favSide: fav, outcomes: [
    { name: 'A', side: 'away', odds: away, line: fav === 'away' ? -line : line },
    { name: 'H', side: 'home', odds: home, line: fav === 'home' ? -line : line },
  ] }, ml: { outcomes: [{ side: 'away', odds: 2 }, { side: 'home', odds: 1.8 }] } };
}

test('slimHistory 只刪讓分沒變的列，換邊次數與關係不變', () => {
  const rows = [   // 新→舊
    hd('home', 1.5, 1.9, 1.9, '2026-11-14T10:00:00Z'),
    hd('home', 1.5, 1.9, 1.9, '2026-11-14T09:00:00Z'),
    hd('away', 1.5, 1.8, 2.0, '2026-11-14T08:00:00Z'),
    hd('away', 1.5, 1.8, 2.0, '2026-11-14T07:00:00Z'),
    hd('away', 1.5, 1.8, 2.0, '2026-11-14T06:00:00Z'),
    hd('home', 1.5, 1.9, 1.9, '2026-11-14T05:00:00Z'),
  ];
  const slim = slimHistory(rows);
  assert.ok(slim.length < rows.length);
  assert.equal(slim[0], rows[0]);                       // 最新列原樣（BET365 latest）
  assert.equal(slim[slim.length - 1], rows[rows.length - 1]);   // 最舊列原樣（BET365 初盤）
  const full = NhlStake.summarizeHandicapHistory({ game: { history: rows } }, null);
  const cut = NhlStake.summarizeHandicapHistory({ game: { history: slim } }, null);
  assert.deepEqual(cut, full);
  assert.equal(full.stake.swapCount, 2);
});

test('已完賽才存；滾出即時檔的場沿用舊存檔；超過保留天數刪掉', () => {
  const g = (id, date, status) => ({ officialId: id, date, time: '08:00', away: '甲', home: '乙', status, awayScore: status === 'finished' ? 3 : null, homeScore: status === 'finished' ? 2 : null });
  const prev = { games: {
    old: { pregame: g('old', '2026-10-01', 'finished'), stake: null, b365: null },
    kept: { pregame: g('kept', '2026-11-05', 'finished'), stake: { fixtureId: 'x' }, b365: null },
  } };
  const pregame = { games: [g('kept', '2026-11-05', 'finished'), g('new', '2026-11-14', 'finished'), g('live', '2026-11-15', 'live')] };
  const games = buildGames({ prev, pregame, stake: { games: {} }, b365: { games: {} }, nowMs: NOW });
  assert.deepEqual(Object.keys(games), ['kept', 'new']);
  assert.deepEqual(games.kept.stake, { fixtureId: 'x' });
  assert.equal(games.new.stake, null);
});

test('run：內容沒變就不寫檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-archive-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const pregame = { games: [{ officialId: 'NHL_20261114_甲@乙_0800', date: '2026-11-14', time: '08:00', away: '甲', home: '乙', status: 'finished', awayScore: 1, homeScore: 2 }] };
  fs.writeFileSync(path.join(dir, 'data/nhl_pregame.json'), JSON.stringify(pregame));
  assert.equal(run(dir, NOW).changed, true);
  const first = fs.readFileSync(path.join(dir, 'data/nhl_close_archive.json'), 'utf8');
  assert.equal(run(dir, NOW + 3600e3).changed, false);
  assert.equal(fs.readFileSync(path.join(dir, 'data/nhl_close_archive.json'), 'utf8'), first);
});

// 用 repo 裡當下的真實資料：存檔算出的讓分歷史判定、收盤盤口，必須與即時檔算的一模一樣
test('真實資料：存檔與即時檔的判定完全相同', (t) => {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  let pregame, stake, b365;
  try { pregame = read('data/nhl_pregame.json'); stake = read('data/stake_api_odds.json'); b365 = read('data/nhl_bet365_odds.json'); }
  catch (e) { t.skip('沒有即時資料檔'); return; }
  const games = buildGames({ prev: { games: {} }, pregame, stake, b365, nowMs: Date.now() });
  const stakeArch = { games: {} }, b365Arch = { games: {} };
  for (const [id, e] of Object.entries(games)) {
    if (e.stake) stakeArch.games[id] = e.stake;
    if (e.b365) b365Arch.games[id] = e.b365;
  }
  let compared = 0;
  for (const e of Object.values(games)) {
    const g = e.pregame;
    const sl = NhlStake.findStakeGame(stake, g), sa = NhlStake.findStakeGame(stakeArch, g);
    const bl = NhlBet365.findBet365Game(b365, g), ba = NhlBet365.findBet365Game(b365Arch, g);
    if (!sl && !bl) continue;
    compared++;
    assert.deepEqual(NhlStake.summarizeHandicapHistory(sa, ba), NhlStake.summarizeHandicapHistory(sl, bl), g.officialId);
    if (sl) for (const k of ['ml', 'hd', 'ou', 'open']) assert.deepEqual(sa[k], sl[k], `${g.officialId} stake ${k}`);
    if (bl) for (const k of ['ml', 'hd', 'total', 'openTotal']) assert.deepEqual(ba[k], bl[k], `${g.officialId} b365 ${k}`);
    const item = {};
    assert.deepEqual(
      NhlStake.applyOddsToPregame(g, item, sa, ba, 'home').hdFav,
      NhlStake.applyOddsToPregame(g, item, sl, bl, 'home').hdFav, g.officialId);
  }
  t.diagnostic(`比對 ${compared} 場`);
});

test('瘦身後 Stake／BET365 仍保留比對要用的欄位', () => {
  const s = slimStakeGame({ league: 'nhl', awayTeam: '甲', homeTeam: '乙', startISO: '2026-11-14T00:00:00Z', rawMarkets: [1], events: [1], markets: {}, history: [] });
  assert.equal(s.rawMarkets, undefined);
  assert.equal(s.events, undefined);
  assert.equal(s.awayTeam, '甲');
  const b = slimB365Game({ awayZh: '甲', homeZh: '乙', startTime: 1, sourceUrls: ['x'], events: [1], history: [] });
  assert.equal(b.sourceUrls, undefined);
  assert.equal(b.awayZh, '甲');
});
