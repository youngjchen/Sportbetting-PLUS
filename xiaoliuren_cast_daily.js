/* ============================================================
   小六壬前瞻起卦守護程序（divination-lab 實驗 S・凍結後 out-of-sample 累積）
   凍結：tag divination-freeze-S-v1（引擎/映射/ledger 見 FREEZE_MANIFEST_S.md）。
   設計：S-time 與 S-rand 皆為「排定開賽 −240 分」的純函數（同 L v1.2 熵源釘選）
   → 起卦內容與 cron 觸發時機無關；兩天回補窗根絕漏卦（遲跑不影響、只需補記）。
   每場一次、雙臂同錨：
     - S-time：castFromAnchorUtcMs(排定時刻) → 農曆月/日/時支 → 宮（確定性，永不失敗）
     - S-rand：−240 分歷史脈衝（previous/{ms}，NIST 簽章證明先於結果）→ HMAC 報數 → 宮
   三市場同宮投影：totals=confirmatory（吉大凶小）、ml/hd=exploratory（吉主/讓、凶客/受、空亡棄）。
   守門：只讀排程（gamePk/排定時刻/gameType），絕不碰結果；ledger 無比分欄（寫檔前斷言）。
   遮蔽：機器卦不結算、分析日前不顯示命中率（凍結協議 §9，UI 端負責）。
   鐵則：一場永不重卜；beacon 網路失敗＝跳過下輪重試（絕不偽隨機頂替，--dry 除外）；
         真斷檔（delta>90 分）＝S-rand 記 missedPulse 但 S-time 照記。
   用法：node xiaoliuren_cast_daily.js [--dry] [--commit]
   排程：.github/workflows/xiaoliuren-cast.yml（勿用 PowerShell 編輯——BOM 會讓 Actions 拒收）
   ============================================================ */
'use strict';
const fs = require('fs');
const axios = require('axios');
const { execSync } = require('child_process');
const eng = require('./xiaoliuren_engine.js');

const LEDGER = 'data/xiaoliuren_casts.json';
const DRY = process.argv.includes('--dry');
const CATCHUP_MS = 2 * 86400000;   // 回補窗：往回兩天（遲跑補記，根絕漏卦）
const FUTURE_MS = 1 * 86400000;    // 往前一天（抓即將開打）
const MAX_DELTA_MIN = 90;          // 與回測同門檻：脈衝距錨點 >90 分 = 真斷檔
const PHASE = 'prospective-2026';

// 三市場同宮投影（confirmatory=totals；ml/hd=exploratory，附錄 §3 Q3）
function picksFor(verdict) {
  if (verdict === '吉') return { totals: '大', ml: '主', hd: '讓' };
  if (verdict === '凶') return { totals: '小', ml: '客', hd: '受' };
  return { totals: null, ml: null, hd: null }; // 空亡＝棄場
}

async function fetchSchedule() {
  const day = (offset) => { const t = new Date(Date.now() + offset); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`; };
  const start = day(-CATCHUP_MS), end = day(FUTURE_MS);
  const r = await axios.get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}`, { timeout: 30000 });
  const games = [];
  for (const dd of r.data.dates || []) for (const g of dd.games || [])
    games.push({ gamePk: g.gamePk, ts: Date.parse(g.gameDate), gameType: g.gameType, away: g.teams.away.team.name, home: g.teams.home.team.name });
  return games;
}

async function beaconAt(anchorMs) {
  // 脈衝釘選：−240 分整分對齊（strictly previous）。網路失敗→throw（下輪重試）；回傳含 delta 供斷檔判定
  const ms = Math.floor(anchorMs / 60000) * 60000;
  const r = await axios.get('https://beacon.nist.gov/beacon/2.0/pulse/time/previous/' + ms, { timeout: 20000 });
  const pt = Date.parse(r.data.pulse.timeStamp);
  return { pulse: r.data.pulse, deltaMin: (anchorMs - pt) / 60000 };
}

(async function main() {
  const now = Date.now();
  const games = await fetchSchedule();
  const ledger = (() => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { return []; } })();
  const done = new Set(ledger.filter(e => e.gamePk).map(e => String(e.gamePk)));
  // 嚴格 out-of-sample：凍結回測已含的 gamePk 一律跳過（避免與 divination-freeze-S-v1 雙計）
  try { for (const e of JSON.parse(fs.readFileSync('divination_lab/xiaoliuren_casts_time.json', 'utf8'))) done.add(String(e.gamePk)); } catch (e) {}

  // 合格：例行賽(R)、−240 錨點已過（脈衝存在）、在回補窗內、未卜
  const todo = games.filter(g => {
    if (g.gameType !== 'R' || !isFinite(g.ts)) return false;          // W3：壞排定時刻一律跳過
    const anchor = g.ts - 240 * 60000;
    return anchor <= now && g.ts >= now - CATCHUP_MS && !done.has(String(g.gamePk));
  });
  console.log(`賽程 ${games.length}｜待卜 ${todo.length}${DRY ? '｜dry' : ''}`);
  let dirty = false;

  for (const g of todo) {
    const anchorMs = g.ts - 240 * 60000;
    if (!isFinite(anchorMs)) continue;                                // W3
    const t = eng.castFromAnchorUtcMs(g.ts);                          // S-time：確定性，永不失敗
    let randStatus, beaconTS = null, beaconOutput = null, beaconDelta = null, r = null;
    if (DRY) { randStatus = 'cast'; r = { palace: t.palace, verdict: t.verdict, pick: t.pick, n1: 0, n2: 0, n3: 0 }; beaconTS = 'DRY'; }
    else {
      let bp;
      try { bp = await beaconAt(anchorMs); }
      catch (e) { console.error(`  beacon 失敗（${g.away}@${g.home}），下輪重試：${e.message}`); continue; } // N2：跳過重試
      beaconTS = bp.pulse.timeStamp; beaconDelta = +bp.deltaMin.toFixed(1);
      if (bp.deltaMin > MAX_DELTA_MIN) { randStatus = 'missedPulse'; }  // 真斷檔：S-rand 缺、S-time 仍記
      else { randStatus = 'cast'; beaconOutput = bp.pulse.outputValue; r = eng.castRandFromPulse(bp.pulse.outputValue, g.gamePk); }
    }
    const entry = {
      gamePk: g.gamePk, matchup: `${g.away}@${g.home}`, gameType: g.gameType,
      gameTimeUTC: new Date(g.ts).toISOString(), anchorUtc: new Date(anchorMs).toISOString(),
      phase: PHASE, castAt: new Date().toISOString(),
      timePalace: t.palace, timeVerdict: t.verdict, lunarText: t.lunarText,
      nMonth: t.nMonth, nDay: t.nDay, nHour: t.nHour, timePicks: picksFor(t.verdict),
      randStatus, beaconTS, beaconOutput, beaconDelta,
      randPalace: r ? r.palace : null, randVerdict: r ? r.verdict : null,
      n1: r ? r.n1 : null, n2: r ? r.n2 : null, n3: r ? r.n3 : null,
      randPicks: r && randStatus === 'cast' ? picksFor(r.verdict) : null,
    };
    console.log(`  卜 ${entry.matchup}｜S-time=${t.palace}(${t.verdict})｜S-rand=${randStatus === 'cast' ? r.palace + '(' + r.verdict + ')' : randStatus}`);
    if (!DRY) { ledger.push(entry); done.add(String(g.gamePk)); dirty = true; }
  }

  if (!DRY && dirty) {
    const blob = JSON.stringify(ledger, null, 1);
    for (const k of ['totalRuns', 'awayScore', 'homeScore', 'totLine', 'hdAwayLine']) // 守門：ledger 無比分欄
      if (blob.includes(`"${k}"`)) throw new Error(`偷看防護失敗：ledger 含 ${k}`);
    fs.writeFileSync(LEDGER, blob);
    if (process.argv.includes('--commit')) { execSync('git add ' + LEDGER); execSync(`git commit -m "xiaoliuren cast ${new Date().toISOString()}"`); console.log('已 commit（時間戳公證）'); }
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
