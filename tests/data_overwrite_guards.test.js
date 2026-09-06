'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function inTempDir(fn) {
  const oldCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sportbetting-guard-'));
  fs.mkdirSync(path.join(dir, 'data'));
  try {
    process.chdir(dir);
    return fn(dir);
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('sidecar protocol forwards request headers and timeout to Scrapling', () => {
  const sidecar = require('../sidecar_client.js');
  assert.equal(typeof sidecar.makeSidecarRequest, 'function');
  assert.deepEqual(
    sidecar.makeSidecarRequest(
      7,
      'https://www.playsport.cc/billboard/winRate',
      { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      20000
    ),
    {
      id: 7,
      url: 'https://www.playsport.cc/billboard/winRate',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      timeoutMs: 20000,
    }
  );
});

test('playsport refuses to replace malformed tracked pregame data', () => {
  const scraper = require('../playsport_scraper.js');
  inTempDir(() => {
    fs.writeFileSync(path.join('data', 'pregame_data.json'), '{broken');
    assert.throws(() => scraper.loadStore(), /pregame_data/);
  });
});

test('playsport refuses to replace malformed tracked lottery history', () => {
  const scraper = require('../playsport_scraper.js');
  inTempDir(() => {
    fs.writeFileSync(path.join('data', 'lottery_series.json'), '{broken');
    assert.throws(() => scraper.loadSeries(), /lottery_series/);
  });
});

test('playsport replaces a successfully refreshed league-date slate instead of retaining stale schedule rows', () => {
  const scraper = require('../playsport_scraper.js');
  const date = '2099-09-06';
  const existing = [
    { league: 'KBO', date, officialId: 'KBO_20990906_NC@NEXEN_1800', time: '18:00', awayTeam: '恐龍', homeTeam: '培證' },
    { league: 'KBO', date, officialId: 'KBO_20990906_DOOSAN@HANWHA_1730', time: '17:30', awayTeam: '斗山熊', homeTeam: '華老鷹' },
    { league: 'MLB', date, officialId: 'MLB_20990906_CHC@MIL_0800', time: '08:00', awayTeam: '小熊', homeTeam: '釀酒人' },
  ];
  const fresh = [
    { league: 'KBO', date, officialId: 'KBO_20990906_NC@NEXEN_1300', time: '13:00', awayTeam: '恐龍', homeTeam: '培證' },
    { league: 'KBO', date, officialId: 'KBO_20990906_SAMSUNG@LG_1600', time: '16:00', awayTeam: '三星獅', homeTeam: '雙子' },
  ];

  const merged = scraper.mergeStore(existing, fresh, 5, new Set([`KBO|${date}`]));

  assert.deepEqual(merged.map(game => game.officialId).sort(), [
    'KBO_20990906_NC@NEXEN_1300',
    'KBO_20990906_SAMSUNG@LG_1600',
    'MLB_20990906_CHC@MIL_0800',
  ]);
});

test('playsport never grants an empty scrape permission to erase a league-date slate', () => {
  const scraper = require('../playsport_scraper.js');
  const date = '2099-09-06';
  const existing = [{
    league: 'KBO', date, officialId: 'KBO_20990906_NC@NEXEN_1300',
    time: '13:00', awayTeam: '恐龍', homeTeam: '培證',
  }];

  const merged = scraper.mergeStore(existing, [], 5, new Set([`KBO|${date}`]));

  assert.deepEqual(merged, existing);
});

test('expert scraper refuses to replace malformed prior picks', () => {
  const oldLeague = process.env.EP_LEAGUE;
  process.env.EP_LEAGUE = 'mlb';
  const expert = require('../expert_picks.js');
  if (oldLeague == null) delete process.env.EP_LEAGUE;
  else process.env.EP_LEAGUE = oldLeague;

  assert.equal(typeof expert.loadPrev, 'function');
  inTempDir(() => {
    fs.writeFileSync(path.join('data', 'expert_picks_mlb.json'), '{broken');
    assert.throws(() => expert.loadPrev(), /expert_picks_mlb/);
  });
});

test('expert scope replacement requires complete discovery and at least one valid page', () => {
  const expert = require('../expert_picks.js');
  assert.equal(typeof expert.shouldReplaceScope, 'function');
  assert.equal(expert.shouldReplaceScope({
    discoveryComplete: false, attempted: 10, succeeded: 10, previous: 20, current: 20,
  }), false);
  assert.equal(expert.shouldReplaceScope({
    discoveryComplete: true, attempted: 10, succeeded: 9, previous: 20, current: 19,
  }), true);
  assert.equal(expert.shouldReplaceScope({
    discoveryComplete: true, attempted: 10, succeeded: 10, previous: 20, current: 18,
  }), true);
  assert.equal(expert.shouldReplaceScope({
    discoveryComplete: true, attempted: 10, succeeded: 10, previous: 20, current: 0,
  }), false);
});

test('expert merge replaces only successful user-date pages and never duplicates a pick key', () => {
  const expert = require('../expert_picks.js');
  const date = '2026-07-29';
  const base = {
    league: 'mlb',
    date,
    away: '小熊',
    home: '釀酒人',
    time: '08:10',
    market: 'hd',
    team: '小熊',
    side: null,
  };
  const previous = [
    { ...base, uid: 'ok-user', line: 1.5, at: 'old-ok' },
    { ...base, uid: 'failed-user', line: 1.5, at: 'old-failed' },
  ];
  const current = [
    { ...base, uid: 'ok-user', line: 2.5, at: 'new-ok' },
  ];
  const fetchedByLg = {
    mlb: new Set([`ok-user|${date}`]),
  };

  const merged = expert.mergePicks(
    previous,
    current,
    new Set([`mlb|${date}`]),
    fetchedByLg
  );

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((pick) => [pick.uid, pick.line, pick.at]).sort(),
    [
      ['failed-user', 1.5, 'old-failed'],
      ['ok-user', 2.5, 'new-ok'],
    ]
  );
});

test('expert merge keeps valid new picks as a union when an incomplete scope is not allowed to delete old picks', () => {
  const expert = require('../expert_picks.js');
  const previous = [{
    uid: 'old-user', league: 'mlb', date: '2026-07-29',
    away: '小熊', home: '釀酒人', time: '08:10',
    market: 'hd', team: '小熊', side: null, line: 1.5,
  }];
  const current = [{
    uid: 'new-user', league: 'mlb', date: '2026-07-29',
    away: '小熊', home: '釀酒人', time: '08:10',
    market: 'ml', team: '釀酒人', side: null, line: null,
  }];

  const merged = expert.mergePicks(previous, current, new Set(), { mlb: new Set() });

  assert.deepEqual(merged.map(p => p.uid).sort(), ['new-user', 'old-user']);
});

test('expert scraper refuses malformed whitelist and existing archive', () => {
  const expert = require('../expert_picks.js');
  assert.equal(typeof expert.loadArchivePicks, 'function');
  inTempDir(() => {
    fs.writeFileSync(path.join('data', 'expert_whitelist.json'), '{broken');
    assert.throws(() => expert.loadWhitelist(), /expert_whitelist/);

    const archive = path.join('data', 'archive.json');
    fs.writeFileSync(archive, '{broken');
    assert.throws(() => expert.loadArchivePicks(archive), /archive/);
  });
});

test('odds scraper refuses to replace malformed prior odds log', () => {
  const odds = require('../index.js');
  assert.equal(typeof odds.loadLog, 'function');
  inTempDir(() => {
    fs.writeFileSync(path.join('data', 'odds_log.json'), '{broken');
    assert.throws(() => odds.loadLog(), /odds_log/);
  });
});

test('intl state refuses malformed prior state instead of rebuilding from empty', () => {
  const odds = require('../index.js');
  assert.equal(typeof odds.buildIntlState, 'function');
  inTempDir(() => {
    fs.writeFileSync(path.join('data', 'pregame_data.json'), '[]');
    fs.writeFileSync(path.join('data', 'lottery_series.json'), '{"games":{}}');
    fs.writeFileSync(path.join('data', 'intl_state.json'), '{broken');
    assert.throws(
      () => odds.buildIntlState({ matches: {} }, '2026-07-28T03:00:00+08:00'),
      /intl_state/
    );
  });
});

function runLedgerWithMalformedData(scriptName, ledgerName) {
  return inTempDir((dir) => {
    const ledger = path.join(dir, 'data', ledgerName);
    const preload = path.join(dir, 'fake_axios.js');
    fs.writeFileSync(ledger, '{broken');
    fs.writeFileSync(preload, `
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request !== 'axios') return originalLoad.apply(this, arguments);
        return { get: async (url) => {
          if (String(url).includes('statsapi.mlb.com')) {
            const gameDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
            return { data: { dates: [{ games: [{
              gamePk: 999999, gameDate, gameType: 'R',
              teams: {
                away: { team: { name: 'Away' } },
                home: { team: { name: 'Home' } }
              }
            }] }] } };
          }
          return { data: { pulse: {
            outputValue: 'ab'.repeat(64),
            timeStamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
          } } };
        } };
      };
    `);

    const result = spawnSync(process.execPath, [path.join(ROOT, scriptName)], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
    });
    return { result, content: fs.readFileSync(ledger, 'utf8') };
  });
}

for (const [scriptName, ledgerName] of [
  ['liuyao_cast_daily.js', 'liuyao_casts.json'],
  ['qiuqian_cast_daily.js', 'qiuqian_casts.json'],
  ['xiaoliuren_cast_daily.js', 'xiaoliuren_casts.json'],
]) {
  test(`${scriptName} fails closed when its ledger is malformed`, () => {
    const { result, content } = runLedgerWithMalformedData(scriptName, ledgerName);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(content, '{broken');
  });
}
