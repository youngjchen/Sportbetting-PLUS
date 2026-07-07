/* ============================================================
   求籤前瞻起籤守護程序（divination-lab 實驗 Q・pilot/confirmatory 共用）
   每次執行：抓 MLB 今明賽程 → 對「開打前 40–180 分鐘、未起籤」的 (比賽×市場)，
   取「開賽前 240 分」信標脈衝（v1.2 熵源釘選同 L）→ qiuqian_engine 全儀式
   （允筊3聖→抽籤→確筊3聖，D3′ 改日再問=棄場留痕）→ 追加 ledger。
   三市場一事一占：totals(confirmatory)、ml/hd(exploratory)，各自獨立位元流。
   層表凍結前：只記原始儀式結果（lot/throws），判讀與 picks 於凍結後由籤號決定性重導。
   盤面快照（belt-and-suspenders，非必要條件）：state/board_state.json.gz 可讀則記線值。
   鐵則：一場一市場一籤永不重抽；beacon 失敗＝留痕下輪重試，絕不偽隨機頂替（--dry 除外）。
   用法：node qiuqian_cast_daily.js [--dry] [--commit]
   排程：.github/workflows/qiuqian-cast.yml（勿用 PowerShell 編輯——BOM 會讓 Actions 拒收）
   ============================================================ */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const axios = require('axios');
const { execSync } = require('child_process');
const eng = require('./qiuqian_engine.js');

const LEDGER = 'data/qiuqian_casts.json';
const DRY = process.argv.includes('--dry');
const WIN_MIN = 40, WIN_MAX = 180;
const MISS_LOOKBACK = -240;
const MARKETS = ['totals', 'ml', 'hd'];

const pad = (x) => String(x).padStart(2, '0');
const GAN = '甲乙丙丁戊己庚辛壬癸', ZE = '子寅辰午申戌', ZO = '丑卯巳未酉亥';
const ganzhiOf = (n) => { const s = Math.floor((n - 1) / 6), b = (n - 1) % 6; return GAN[s] + (s % 2 === 0 ? ZE[b] : ZO[b]); };

function loadTables() {
  try {
    const t = JSON.parse(fs.readFileSync('divination_lab/qiuqian_layer_tables.json', 'utf8'));
    const t3 = JSON.parse(fs.readFileSync('divination_lab/qiuqian_layer3_table.json', 'utf8'));
    if (!t.frozen || !t3.frozen) return null;   // 未凍結不作判讀
    return { layer1: t.layer1, layer2: t.layer2, layer3: t3.layer3 };
  } catch (e) { return null; }
}

function boardSnapshot(gamePk) {
  // 盡力而為：盤面 state 存在且含該場 officialId 才記；任何失敗一律 null（不影響儀式）
  try {
    const gz = fs.readFileSync('state/board_state.json.gz');
    const doc = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    const games = (doc && (doc.games || (doc.doc && doc.doc.games))) || [];
    const g = games.find(x => String(x.officialId || '') === String(gamePk));
    if (!g) return null;
    return { totVal: g.totVal != null ? g.totVal : null, hdFav: g.hdFav != null ? g.hdFav : null, hdLine: g.hdLine != null ? g.hdLine : null };
  } catch (e) { return null; }
}

async function fetchSchedule() {
  const t = new Date(Date.now() + 8 * 3600e3);
  const d0 = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  const y = new Date(t.getTime() - 86400000), d1 = `${y.getUTCFullYear()}-${pad(y.getUTCMonth() + 1)}-${pad(y.getUTCDate())}`;
  const r = await axios.get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${d1}&endDate=${d0}`, { timeout: 30000 });
  const games = [];
  for (const dd of r.data.dates || []) for (const g of dd.games || []) games.push({ gamePk: g.gamePk, ts: Date.parse(g.gameDate), gameType: g.gameType, away: g.teams.away.team.name, home: g.teams.home.team.name });
  return games;
}
async function beaconPulseFor(gameTs) {
  const anchorMs = Math.floor((gameTs - 240 * 60000) / 60000) * 60000;
  try {
    const r = await axios.get('https://beacon.nist.gov/beacon/2.0/pulse/time/previous/' + anchorMs, { timeout: 20000 });
    return { pulse: r.data.pulse, anchorMs, pinned: true };
  } catch (e) {
    const r2 = await axios.get('https://beacon.nist.gov/beacon/2.0/pulse/last', { timeout: 20000 });
    return { pulse: r2.data.pulse, anchorMs, pinned: false };
  }
}

(async function main() {
  const now = Date.now();
  const games = await fetchSchedule();
  const ledger = (() => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { return []; } })();
  const done = new Set(ledger.filter(e => e.gamePk && e.market).map(e => e.gamePk + '|' + e.market));
  const tables = loadTables();
  const inWindow = games.filter(g => { const m = (g.ts - now) / 60000; return m >= WIN_MIN && m <= WIN_MAX; });
  const missed = games.filter(g => { const m = (g.ts - now) / 60000; return m < WIN_MIN && m > MISS_LOOKBACK; });
  console.log(`賽程 ${games.length}｜視窗內 ${inWindow.length}｜層表${tables ? '已凍結' : '未凍結（只記原始儀式）'}${DRY ? '｜dry' : ''}`);
  let dirty = false;

  if (!DRY) for (const g of missed) for (const mk of MARKETS) {
    if (done.has(g.gamePk + '|' + mk)) continue;
    ledger.push({ gamePk: g.gamePk, market: mk, exploratory: mk !== 'totals', gameType: g.gameType, matchup: `${g.away}@${g.home}`, gameTimeUTC: new Date(g.ts).toISOString(), missedWindow: true, notedAt: new Date().toISOString(), phase: 'pilot-2026' });
    done.add(g.gamePk + '|' + mk); dirty = true;
    console.log(`  漏籤留痕（棄場） ${g.away}@${g.home} [${mk}]`);
  }

  for (const g of inWindow) {
    const todo = MARKETS.filter(mk => !done.has(g.gamePk + '|' + mk));
    if (!todo.length) continue;
    let bp;
    if (DRY) bp = { pulse: { outputValue: crypto.randomBytes(64).toString('hex'), timeStamp: 'DRY' }, anchorMs: g.ts - 240 * 60000, pinned: false };
    else {
      try { bp = await beaconPulseFor(g.ts); }
      catch (e) { ledger.push({ failedAt: new Date().toISOString(), reason: 'beacon:' + e.message, gamePks: [g.gamePk] }); dirty = true; console.error(`beacon 失敗（${g.away}@${g.home}），留痕下輪重試`); continue; }
    }
    const snap = boardSnapshot(g.gamePk);
    for (const mk of todo) {
      const r = eng.castRitual(bp.pulse.outputValue, g.gamePk, mk);
      const layers = r.aborted ? null : eng.applyLayers(r.lot, tables);
      const picks = layers ? Object.fromEntries(Object.entries(layers).map(([L, v]) => [L, eng.directionFor(mk, v)])) : null;
      const entry = {
        gamePk: g.gamePk, market: mk, exploratory: mk !== 'totals', gameType: g.gameType,
        matchup: `${g.away}@${g.home}`, gameTimeUTC: new Date(g.ts).toISOString(), castAt: new Date().toISOString(),
        beaconAnchor: new Date(bp.anchorMs).toISOString(), beaconPinned: bp.pinned, beaconTS: bp.pulse.timeStamp, beaconOutput: bp.pulse.outputValue,
        aborted: r.aborted, lot: r.lot, ganzhi: r.lot ? ganzhiOf(r.lot) : null, throwsLog: r.log,
        tablesFrozen: !!tables, layers, picks, boardSnapshot: snap, phase: 'pilot-2026'
      };
      console.log(`  籤 ${entry.matchup} [${mk}] → ${r.aborted ? '棄場（' + r.aborted + '＝改日再問）' : '第' + r.lot + '籤 ' + entry.ganzhi + (tables ? '' : '（判讀待凍結）')}${bp.pinned ? '' : '｜⚠未釘選'}`);
      if (!DRY) { ledger.push(entry); done.add(g.gamePk + '|' + mk); dirty = true; }
    }
  }

  if (!DRY && dirty) {
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
    if (process.argv.includes('--commit')) { execSync('git add ' + LEDGER); execSync(`git commit -m "qiuqian cast ${new Date().toISOString()}"`); console.log('已 commit（時間戳公證）'); }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
