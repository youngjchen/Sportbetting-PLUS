'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseBet365NhlHub,
  collectBet365NhlOdds,
  updateOddsFile,
} = require('../nhl_bet365_odds.js');
const { stableGameKey } = require('../nhl_bet365_core.js');

const FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'nhl-bet365-hub.html'),
  'utf8',
);
const MARKET_FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'bet365-nhl-markets.html'),
  'utf8',
);

test('joins separate Bet365 fixture ids without reversing away and home', () => {
  const games = parseBet365NhlHub(FIXTURE_HTML);
  assert.equal(games.length, 2);
  assert.deepEqual(games[0], {
    startTime: 1790809200000,
    away: 'FLA Panthers',
    home: 'CAR Hurricanes',
    awayZh: '佛羅里',
    homeZh: '颶風',
    fixtureIds: { ml: 'ml-1001', hd: 'hd-1001' },
    ml: {
      market: 'Money Line',
      outcomes: [
        { name: 'FLA Panthers', side: 'away', odds: 2.05 },
        { name: 'CAR Hurricanes', side: 'home', odds: 1.72 },
      ],
    },
    hd: {
      market: 'Puck Line',
      line: 1.5,
      favSide: 'home',
      outcomes: [
        { name: 'FLA Panthers', side: 'away', line: 1.5, odds: 1.4 },
        { name: 'CAR Hurricanes', side: 'home', line: -1.5, odds: 2.85 },
      ],
    },
  });
  assert.equal(games[1].hd.favSide, 'away');
  assert.deepEqual(games[1].hd.outcomes.map((outcome) => outcome.line), [-1.5, 1.5]);
});

test('does not accept non-numeric decimal odds as a complete market', () => {
  const html = FIXTURE_HTML.replace('data-item-odds="2.05"', 'data-item-odds="suspended"');
  const games = parseBet365NhlHub(html);
  assert.equal(games[0].ml, undefined);
  assert.ok(games[0].hd);
});

test('reads the official NHL game total without changing puck-line direction', () => {
  const [game] = parseBet365NhlHub(MARKET_FIXTURE_HTML);
  assert.deepEqual(game.total, {
    market: 'Game Totals',
    line: 6.5,
    outcomes: [
      { name: 'Over', side: 'over', line: 6.5, odds: 1.91 },
      { name: 'Under', side: 'under', line: 6.5, odds: 1.91 },
    ],
  });
  assert.equal(game.hd.favSide, 'home');
});

test('collector fills a hub game total from the Bet365 official event detail', async () => {
  const output = await collectBet365NhlOdds({
    fetchText: async () => FIXTURE_HTML,
    fetchDetails: async (game) => game.away === 'FLA Panthers' ? MARKET_FIXTURE_HTML : '',
    previous: { games: {} },
    now: Date.parse('2026-09-30T12:00:00Z'),
  });
  const game = Object.values(output.games).find((item) => item.away === 'FLA Panthers');
  assert.equal(game.total.line, 6.5);
  assert.equal(game.total.outcomes[0].odds, 1.91);
});

test('rejects a Cloudflare challenge instead of creating an empty feed', async () => {
  await assert.rejects(
    () => collectBet365NhlOdds({
      fetchText: async () => '<html><title>Just a moment...</title><div>cf-chl</div></html>',
      previous: { games: {} },
      now: Date.parse('2026-09-30T12:00:00Z'),
    }),
    /Cloudflare|挑戰/,
  );
});

test('rejects a partially loaded page missing one required market', async () => {
  const partial = FIXTURE_HTML.replace(
    /<li data-item-category2="NHL" data-item-category3="Puck Line"[\s\S]*?<\/li>/,
    '',
  );
  await assert.rejects(
    () => collectBet365NhlOdds({
      fetchText: async () => partial,
      previous: { games: {} },
      now: Date.parse('2026-09-30T12:00:00Z'),
    }),
    /不完整/,
  );
});

test('merges prior history and prunes games more than three days old', async () => {
  const previous = {
    provider: 'bet365-official',
    games: {
      old: {
        startTime: Date.parse('2026-09-25T00:00:00Z'),
        away: 'OLD Away', home: 'OLD Home', awayZh: '舊客', homeZh: '舊主',
      },
    },
  };
  const output = await collectBet365NhlOdds({
    fetchText: async () => FIXTURE_HTML,
    previous,
    now: Date.parse('2026-09-30T12:00:00Z'),
  });

  assert.equal(output.provider, 'bet365-official');
  assert.equal(output.health.status, 'ok');
  assert.equal(output.health.gameCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(output.games, 'old'), false);
  assert.ok(Object.values(output.games).every((game) => game.history.length === 1));
});

test('started Bet365 fixtures keep their last pregame snapshot unchanged', async () => {
  const [started] = parseBet365NhlHub(FIXTURE_HTML);
  const key = stableGameKey(started);
  const frozen = {
    ...started,
    ml: {
      market: 'Money Line',
      outcomes: [
        { name: started.away, side: 'away', odds: 2.25 },
        { name: started.home, side: 'home', odds: 1.65 },
      ],
    },
    history: [{
      at: '2026-09-30T22:59:00.000Z',
      ml: {
        market: 'Money Line',
        outcomes: [
          { name: started.away, side: 'away', odds: 2.25 },
          { name: started.home, side: 'home', odds: 1.65 },
        ],
      },
      hd: started.hd,
    }],
    events: [],
  };

  const output = await collectBet365NhlOdds({
    fetchText: async () => FIXTURE_HTML,
    previous: { games: { [key]: frozen } },
    now: started.startTime + 1,
  });

  assert.deepEqual(output.games[key], frozen);
  assert.equal(output.health.gameCount, 1);
});

test('final thirty seconds are excluded and keep the last NHL pregame snapshot unchanged', async () => {
  const [closing] = parseBet365NhlHub(FIXTURE_HTML);
  const key = stableGameKey(closing);
  const frozen = {
    ...closing,
    ml: {
      market: 'Money Line',
      outcomes: [
        { name: closing.away, side: 'away', odds: 2.25 },
        { name: closing.home, side: 'home', odds: 1.65 },
      ],
    },
    history: [{ at: '2026-09-30T22:58:00.000Z', ml: closing.ml, hd: closing.hd }],
    events: [],
  };

  const output = await collectBet365NhlOdds({
    fetchText: async () => FIXTURE_HTML,
    previous: { games: { [key]: frozen } },
    now: closing.startTime - 20000,
  });

  assert.deepEqual(output.games[key], frozen);
});

test('failed collection leaves the last valid file byte-for-byte unchanged', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-bet365-'));
  const out = path.join(dir, 'odds.json');
  const original = '{"provider":"bet365-official","games":{"safe":{}}}\n';
  fs.writeFileSync(out, original);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => updateOddsFile({
      out,
      fetchText: async () => '<html><title>Just a moment...</title></html>',
      now: Date.parse('2026-09-30T12:00:00Z'),
    }),
    /Cloudflare|挑戰/,
  );
  assert.equal(fs.readFileSync(out, 'utf8'), original);
});
