/* ============================================================
   六爻前瞻起卦守護程序（divination-lab 實驗 L・pilot/confirmatory 共用）
   每次執行：抓 MLB 今明賽程 → 對「開打前 40–180 分鐘、未起卦」的比賽，
   取 NIST Randomness Beacon 當下 pulse（公開可驗時間戳）→
   SHA256(outputValue|gamePk) 前 18 bit → 三錢六擲 → 六爻引擎斷卦 → 追加 ledger。
   窗口 v1.1（協議附錄修訂）：原 55–120 分在 GitHub cron 常態遲到 10–40 分下容錯不足
   （2026-07-04 漏卦事故：cron 空窗＋BOM startup_failure 吃掉唯一 tick）→ 加寬為 40–180。
   漏卦留痕（全報不藏）：窗口已過而無卦的比賽，補記 missedWindow 條目＝棄場，不得無聲消失。
   鐵則：一場一卦永不重抽（ledger 以 gamePk 查重）；beacon 失敗＝記錄失敗、下輪重試，
        絕不以偽隨機頂替（--dry 測試模式除外，dry 不寫 ledger）。
   用法：node liuyao_cast_daily.js [--dry] [--commit]
   排程：.github/workflows/liuyao-cast.yml（勿用 PowerShell Set-Content 編輯——BOM 會讓 Actions 拒收）
   ============================================================ */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { execSync } = require('child_process');
const eng = require('./liuyao_engine.js');

const LEDGER = 'data/liuyao_casts.json';
const DRY = process.argv.includes('--dry');
const WIN_MIN = 40, WIN_MAX = 180;          // 分鐘（附錄 v1.1）
const MISS_LOOKBACK = -240;                  // 開打後 4 小時內仍可補記漏卦

const twNow = () => new Date(Date.now() + 8 * 3600e3);   // 台北=UTC+8（無DST）
const pad = (x) => String(x).padStart(2, '0');

async function fetchSchedule() {
  const t = twNow();
  const d0 = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  const y = new Date(t.getTime() - 86400000), d1 = `${y.getUTCFullYear()}-${pad(y.getUTCMonth() + 1)}-${pad(y.getUTCDate())}`;
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${d1}&endDate=${d0}`;
  const r = await axios.get(url, { timeout: 30000 });
  const games = [];
  for (const dd of r.data.dates || []) for (const g of dd.games || []) games.push({ gamePk: g.gamePk, ts: Date.parse(g.gameDate), gameType: g.gameType, away: g.teams.away.team.name, home: g.teams.home.team.name });
  return games;
}
async function beaconPulseFor(gameTs) {
  // v1.2 熵源釘選：取「開賽前 240 分」那一刻的信標脈衝（/pulse/time/previous/{ms} 回傳 ≤ms 的最新脈衝，無 404 風險）。
  // 卦象因此成為 (gamePk, 排定開賽時間) 的純函數——排程遲到、手動觸發、重跑，內容完全相同 → 人為時機因素歸零。
  const anchorMs = Math.floor((gameTs - 240 * 60000) / 60000) * 60000;
  try {
    const r = await axios.get('https://beacon.nist.gov/beacon/2.0/pulse/time/previous/' + anchorMs, { timeout: 20000 });
    return { pulse: r.data.pulse, anchorMs, pinned: true };
  } catch (e) {
    const r2 = await axios.get('https://beacon.nist.gov/beacon/2.0/pulse/last', { timeout: 20000 });   // 罕見缺脈衝才退回，標記未釘選
    return { pulse: r2.data.pulse, anchorMs, pinned: false };
  }
}
function bitsFrom(outputValue, gamePk) {
  const h = crypto.createHash('sha256').update(outputValue + '|' + gamePk).digest();
  const bits = []; for (let i = 0; i < 18; i++) bits.push((h[i >> 3] >> (7 - (i & 7))) & 1);
  return bits;
}
/* ── v1.3（附錄修訂 divination_lab/L_v1.3_amendment.md）：獨贏/讓分 exploratory 卦 ──
   新市場推導 = SHA256(outputValue|gamePk|market) 前 18 bit——輸入含市場後綴，
   與 legacy bitsFrom（無後綴）不相交；confirmatory 大小分推導逐位元不變。
   極性映射（凍結）：卦極性正（押大側）→ ml押主 / hd押熱門過盤；負→ 客/受讓；平手棄場同構。 */
const X_MARKETS = ['ml', 'hd'];
function bitsFromMkt(outputValue, gamePk, market) {
  const h = crypto.createHash('sha256').update(outputValue + '|' + gamePk + '|' + market).digest();
  const bits = []; for (let i = 0; i < 18; i++) bits.push((h[i >> 3] >> (7 - (i & 7))) & 1);
  return bits;
}
const dirFor = (mk, pick) => pick == null ? null : (mk === 'ml' ? (pick === '大' ? '主' : '客') : (pick === '大' ? '熱門過盤' : '受讓'));

(async function main() {
  const now = Date.now();
  const games = await fetchSchedule();
  const ledger = (() => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { return []; } })();
  const done = new Set(ledger.map(e => e.gamePk));
  const inWindow = games.filter(g => { const m = (g.ts - now) / 60000; return m >= WIN_MIN && m <= WIN_MAX; });
  const todo = inWindow.filter(g => !done.has(g.gamePk));
  const missed = games.filter(g => { const m = (g.ts - now) / 60000; return m < WIN_MIN && m > MISS_LOOKBACK && !done.has(g.gamePk); });
  console.log(`賽程 ${games.length} 場｜視窗內 ${inWindow.length}｜待起卦 ${todo.length}｜漏卦補記 ${missed.length}${DRY ? '（dry）' : ''}`);
  let dirty = false;

  if (!DRY) for (const g of missed) {
    ledger.push({ gamePk: g.gamePk, gameType: g.gameType, matchup: `${g.away}@${g.home}`, gameTimeUTC: new Date(g.ts).toISOString(), missedWindow: true, notedAt: new Date().toISOString(), phase: 'pilot-2026' });
    done.add(g.gamePk); dirty = true;
    console.log(`  漏卦留痕（棄場） ${g.away}@${g.home}`);
  }

  if (todo.length) {
    // 曆法脈絡以「錨定脈衝時刻」計（=卦的定義時刻），與觸發時刻無關 → 完全可重算驗證
    for (const g of todo) {
      let bp;
      if (DRY) bp = { pulse: { outputValue: crypto.randomBytes(64).toString('hex'), timeStamp: 'DRY' }, anchorMs: g.ts - 240 * 60000, pinned: false };
      else {
        try { bp = await beaconPulseFor(g.ts); }
        catch (e) { ledger.push({ failedAt: new Date().toISOString(), reason: 'beacon:' + e.message, gamePks: [g.gamePk] }); dirty = true; console.error(`beacon 失敗（${g.away}@${g.home}），已留痕，下輪重試`); continue; }
      }
      const at = new Date(bp.anchorMs + 8 * 3600e3);   // 錨定時刻的台北時間
      const ctx = eng.zhiContext(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes());
      const backs = eng.bitsToBacks(bitsFrom(bp.pulse.outputValue, String(g.gamePk)));
      const c = eng.castFromBacks(backs, ctx.monthZhi, ctx.dayZhi);
      const entry = { gamePk: g.gamePk, gameType: g.gameType, matchup: `${g.away}@${g.home}`, gameTimeUTC: new Date(g.ts).toISOString(), castAt: new Date().toISOString(), beaconAnchor: new Date(bp.anchorMs).toISOString(), beaconPinned: bp.pinned, monthZhi: ctx.monthZhi, dayZhi: ctx.dayZhi, beaconTS: bp.pulse.timeStamp, beaconOutput: bp.pulse.outputValue, backs, shi: c.shi, ying: c.ying, shiZhi: c.shiZhi, yingZhi: c.yingZhi, sShi: c.sShi, sYing: c.sYing, tiebreak: c.tiebreak, pick: c.pick, phase: 'pilot-2026' };
      console.log(`  卦 ${entry.matchup} → ${c.pick ? '押' + c.pick : '棄場（卦無表態，仍入帳）'}（世${c.shi}${c.shiZhi} ${c.sShi} vs 應${c.ying}${c.yingZhi} ${c.sYing}${c.tiebreak ? '/' + c.tiebreak : ''}｜錨定${bp.pinned ? '' : '⚠未'}釘選）`);
      if (!DRY) { ledger.push(entry); dirty = true; }
    }
  }

  /* ── v1.3 exploratory 區塊（獨立於 legacy 路徑之後執行；legacy 完全未動） ── */
  const doneX = new Set(ledger.filter(e => e.market).map(e => e.gamePk + '|' + e.market));
  if (!DRY) for (const g of games.filter(g => { const m = (g.ts - now) / 60000; return m < WIN_MIN && m > MISS_LOOKBACK; })) for (const mk of X_MARKETS) {
    if (doneX.has(g.gamePk + '|' + mk)) continue;
    ledger.push({ gamePk: g.gamePk, market: mk, exploratory: true, gameType: g.gameType, matchup: `${g.away}@${g.home}`, gameTimeUTC: new Date(g.ts).toISOString(), missedWindow: true, notedAt: new Date().toISOString(), annex: 'v1.3', phase: 'pilot-2026' });
    doneX.add(g.gamePk + '|' + mk); dirty = true;
    console.log(`  漏卦留痕（棄場） ${g.away}@${g.home} [${mk}]`);
  }
  {
    const pulseCache = new Map();
    for (const g of inWindow) for (const mk of X_MARKETS) {
      if (doneX.has(g.gamePk + '|' + mk)) continue;
      let bp = pulseCache.get(g.gamePk);
      if (!bp) {
        if (DRY) bp = { pulse: { outputValue: crypto.randomBytes(64).toString('hex'), timeStamp: 'DRY' }, anchorMs: g.ts - 240 * 60000, pinned: false };
        else {
          try { bp = await beaconPulseFor(g.ts); }
          catch (e) { ledger.push({ failedAt: new Date().toISOString(), reason: 'beacon:' + e.message, gamePks: [g.gamePk], market: mk, annex: 'v1.3' }); dirty = true; console.error(`beacon 失敗（${g.away}@${g.home} [${mk}]），留痕下輪重試`); continue; }
        }
        pulseCache.set(g.gamePk, bp);
      }
      const at = new Date(bp.anchorMs + 8 * 3600e3);
      const ctx = eng.zhiContext(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes());
      const backs = eng.bitsToBacks(bitsFromMkt(bp.pulse.outputValue, String(g.gamePk), mk));
      const c = eng.castFromBacks(backs, ctx.monthZhi, ctx.dayZhi);
      const entry = { gamePk: g.gamePk, market: mk, exploratory: true, gameType: g.gameType, matchup: `${g.away}@${g.home}`, gameTimeUTC: new Date(g.ts).toISOString(), castAt: new Date().toISOString(), beaconAnchor: new Date(bp.anchorMs).toISOString(), beaconPinned: bp.pinned, monthZhi: ctx.monthZhi, dayZhi: ctx.dayZhi, beaconTS: bp.pulse.timeStamp, beaconOutput: bp.pulse.outputValue, backs, shi: c.shi, ying: c.ying, shiZhi: c.shiZhi, yingZhi: c.yingZhi, sShi: c.sShi, sYing: c.sYing, tiebreak: c.tiebreak, pick: c.pick, dir: dirFor(mk, c.pick), annex: 'v1.3', phase: 'pilot-2026' };
      console.log(`  卦 ${entry.matchup} [${mk}] → ${entry.dir ? '押' + entry.dir : '棄場（卦無表態，仍入帳）'}`);
      if (!DRY) { ledger.push(entry); doneX.add(g.gamePk + '|' + mk); dirty = true; }
    }
  }

  if (!DRY && dirty) {
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
    if (process.argv.includes('--commit')) { execSync('git add ' + LEDGER); execSync(`git commit -m "liuyao cast ${new Date().toISOString()}"`); console.log('已 commit（時間戳公證）'); }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
