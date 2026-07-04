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
async function beaconPulse() {
  // v2 API：/pulse/time/{ms} 需恰好對齊脈衝分鐘（任意毫秒回 404）→ 用 /pulse/last 取最新脈衝
  const r = await axios.get('https://beacon.nist.gov/beacon/2.0/pulse/last', { timeout: 20000 });
  return r.data.pulse;   // { timeStamp, outputValue(128 hex), pulseIndex, uri... }
}
function bitsFrom(outputValue, gamePk) {
  const h = crypto.createHash('sha256').update(outputValue + '|' + gamePk).digest();
  const bits = []; for (let i = 0; i < 18; i++) bits.push((h[i >> 3] >> (7 - (i & 7))) & 1);
  return bits;
}

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
    let pulse = null;
    if (DRY) { pulse = { outputValue: crypto.randomBytes(64).toString('hex'), timeStamp: 'DRY', uri: 'DRY' }; }
    else {
      try { pulse = await beaconPulse(); }
      catch (e) { ledger.push({ failedAt: new Date().toISOString(), reason: 'beacon:' + e.message, gamePks: todo.map(g => g.gamePk) }); fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1)); console.error('beacon 失敗，已留痕，下輪重試'); pulse = null; }
    }
    if (pulse) {
      const t = twNow();
      const ctx = eng.zhiContext(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes());
      for (const g of todo) {
        const backs = eng.bitsToBacks(bitsFrom(pulse.outputValue, String(g.gamePk)));
        const c = eng.castFromBacks(backs, ctx.monthZhi, ctx.dayZhi);
        const entry = { gamePk: g.gamePk, gameType: g.gameType, matchup: `${g.away}@${g.home}`, gameTimeUTC: new Date(g.ts).toISOString(), castAt: new Date().toISOString(), monthZhi: ctx.monthZhi, dayZhi: ctx.dayZhi, beaconTS: pulse.timeStamp, beaconOutput: pulse.outputValue, backs, shi: c.shi, ying: c.ying, shiZhi: c.shiZhi, yingZhi: c.yingZhi, sShi: c.sShi, sYing: c.sYing, tiebreak: c.tiebreak, pick: c.pick, phase: 'pilot-2026' };
        console.log(`  卦 ${entry.matchup} → ${c.pick ? '押' + c.pick : '棄場（卦無表態，仍入帳）'}（世${c.shi}${c.shiZhi} ${c.sShi} vs 應${c.ying}${c.yingZhi} ${c.sYing}${c.tiebreak ? '/' + c.tiebreak : ''}）`);
        if (!DRY) { ledger.push(entry); dirty = true; }
      }
    }
  }

  if (!DRY && dirty) {
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
    if (process.argv.includes('--commit')) { execSync('git add ' + LEDGER); execSync(`git commit -m "liuyao cast ${new Date().toISOString()}"`); console.log('已 commit（時間戳公證）'); }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
