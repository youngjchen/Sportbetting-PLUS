/* ============================================================
   實驗 S 信標回補（S-rand 臂）：每場取排定開賽 −240 分的 NIST 歷史脈衝
   → HMAC 報數三數 → 宮位 → ledger（零結果欄；脈衝先於比賽結果=零洩漏）
   - 端點：/pulse/time/previous/{ms}（L v1.2 釘選同款；strictly previous）
   - 棄場規則（凍結）：脈衝時戳距錨點 >90 分 → missedPulse 留痕（如 2026-06 斷檔窗）
   - 節流 0.9s；JSONL 快取斷點續跑（divination_lab/beacon_cache.jsonl）
   - 抽測憑據：2026-07-12 20 點抽測 19 OK（delta 全 1.0 分）＋1 FAR（2026-06-11 起斷檔）
   執行：node xiaoliuren_beacon_backfill.js   （全程約 4 小時，背景跑）
   產出：divination_lab/xiaoliuren_casts_rand.json
   ============================================================ */
'use strict';
const fs = require('fs');
const { castRandFromPulse } = require('./xiaoliuren_engine');

const CACHE = 'divination_lab/beacon_cache.jsonl';
const OUT = 'divination_lab/xiaoliuren_casts_rand.json';
const THROTTLE = 900, MAX_DELTA_MIN = 90, RETRIES = 3;

const J = require('./data/divination_joined.json');
// M §7 合格過濾（與 S-time 認證同句）
const rows = J.filter(o => o.gamePk && o.gameType === 'R' && !o.flags.notFinal && !o.flags.sevenInning && !o.flags.noLine && !o.flags.push && !o.flags.ambiguous && o.totalRuns != null);

const seen = new Map();
if (fs.existsSync(CACHE)) for (const line of fs.readFileSync(CACHE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { const e = JSON.parse(line); seen.set(e.gamePk, e); } catch {}
}
console.log(`合格 ${rows.length} 場；快取已有 ${seen.size}`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  let done = 0, fetched = 0, missed = 0, failed = 0;
  for (const r of rows) {
    done++;
    if (seen.has(r.gamePk)) continue;
    const anchorMs = Date.parse(r.gameDateUTC) - 240 * 60000;
    let entry = null;
    for (let att = 1; att <= RETRIES && !entry; att++) {
      try {
        const res = await fetch(`https://beacon.nist.gov/beacon/2.0/pulse/time/previous/${anchorMs}`);
        if (res.status === 404) { entry = { gamePk: r.gamePk, officialDate: r.officialDate, anchorUtc: new Date(anchorMs).toISOString(), status: 'missedPulse', reason: 'HTTP 404' }; break; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const pt = Date.parse(j.pulse.timeStamp);
        const deltaMin = (anchorMs - pt) / 60000;
        if (deltaMin > MAX_DELTA_MIN) {
          entry = { gamePk: r.gamePk, officialDate: r.officialDate, anchorUtc: new Date(anchorMs).toISOString(), status: 'missedPulse', reason: `delta ${deltaMin.toFixed(0)}min > ${MAX_DELTA_MIN}`, pulseTimeStamp: j.pulse.timeStamp, pulseIndex: j.pulse.pulseIndex };
          missed++;
        } else {
          const c = castRandFromPulse(j.pulse.outputValue, r.gamePk);
          entry = {
            gamePk: r.gamePk, officialDate: r.officialDate, anchorUtc: new Date(anchorMs).toISOString(),
            status: 'cast', pulseTimeStamp: j.pulse.timeStamp, pulseIndex: j.pulse.pulseIndex,
            outputValue: j.pulse.outputValue, deltaMin: +deltaMin.toFixed(1),
            n1: c.n1, n2: c.n2, n3: c.n3, palace: c.palace, verdict: c.verdict, pick: c.pick,
          };
          fetched++;
        }
      } catch (e) {
        if (att === RETRIES) { entry = { gamePk: r.gamePk, officialDate: r.officialDate, anchorUtc: new Date(anchorMs).toISOString(), status: 'fetchFail', reason: e.message }; failed++; }
        else await sleep(2000 * att);
      }
    }
    fs.appendFileSync(CACHE, JSON.stringify(entry) + '\n');
    seen.set(r.gamePk, entry);
    if (done % 200 === 0) console.log(`${done}/${rows.length}  cast=${fetched} missed=${missed} fail=${failed}  ${new Date().toISOString()}`);
    await sleep(THROTTLE);
  }
  // 彙整輸出（依合格場序；零結果欄斷言）
  const ledger = rows.map(r => seen.get(r.gamePk)).filter(Boolean);
  const blob = JSON.stringify(ledger);
  for (const k of ['totalRuns', 'awayScore', 'homeScore', 'totLine', 'hdAwayLine'])
    if (blob.includes(`"${k}"`)) throw new Error(`偷看防護失敗：ledger 含 ${k}`);
  fs.writeFileSync(OUT, blob);
  const casts = ledger.filter(e => e.status === 'cast');
  const nBig = casts.filter(e => e.pick === '大').length, nSmall = casts.filter(e => e.pick === '小').length, nAb = casts.filter(e => e.pick === null).length;
  console.log(`\n完成：${ledger.length} 條（cast ${casts.length} / missedPulse ${ledger.filter(e => e.status === 'missedPulse').length} / fetchFail ${ledger.filter(e => e.status === 'fetchFail').length}）`);
  console.log(`押大 ${nBig} 押小 ${nSmall} 空亡棄 ${nAb}（理論：有表態中 60/40、空亡 1/6）`);
  console.log(`已寫 ${OUT}`);
})();
