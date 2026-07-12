/* ============================================================
   小六壬起課引擎（divination-lab 實驗 S：S-time 時間臂 / S-rand 報數臂）
   規則憑據（考據 2026-07-12，引文存協議附錄 protocol_S_annex）：
   - 六宮序＋吉凶：zh.wikipedia〈小六壬〉逐字引文：「大安、留連、速喜、赤口、小吉、空亡」
     「得大安、速喜、小吉為吉，其餘為凶」；計法「以『月、日、時』輪指數出」。
   - 起數細節（正月起大安；月宮上起初一；日宮上起子時；子=1..亥=12）＝通行慣例，
     維基無明文 → 自定決策點聲明（baike 403 不可達；閉式與掌訣逐步版雙實作互證）。
   - 五行/方位：各派記載不一且映射不使用 → 不入凍結範圍（宮位已記錄＝資訊等價涵蓋）。
   - 三宮法：時宮=結果（月宮=起因、日宮=經過僅記錄為探索欄位，不進主檢）。
   凍結決策（2026-07-12 使用者拍板）：
   - Q1: 獨立實驗臂 S（S-time confirmatory ＋ S-rand confirmatory，α 各 2.5% Bonferroni）
   - Q2: 錨點＝排定開賽 −240 分（語意=問卦之時、對齊 L/Q；註：與叢集/隨機性無關）
   - Q3: 大小分主檢；同宮探索讓分/獨贏（吉=押讓分方/主隊，凶=反向，空亡=棄）
   - Q4: 時宮吉凶二元映射：吉→押大、凶→押小（問句定式「本注（押大）會成嗎」）
   - Q5: 空亡＝無表態→棄場
   - Q6: S-rand＝NIST 信標歷史脈衝釘選報數（三數鏡像月日時三步；脈衝先於比賽結果=零洩漏）
   - 曆法：全部沿用 meihua_engine 凍結層（台北時間、初一制、閏月取本月數、23:00–23:59 屬當日）
   自測：node xiaoliuren_engine.js --selftest
   ============================================================ */
'use strict';
const crypto = require('crypto');
const { numbersFromTaipei, hourIndex } = require('./meihua_engine'); // 唯一曆法層（凍結）

const PALACES = ['大安', '留連', '速喜', '赤口', '小吉', '空亡'];
const JI = { 大安: '吉', 留連: '凶', 速喜: '吉', 赤口: '凶', 小吉: '吉', 空亡: '空亡' }; // 空亡=無表態

// ── 閉式：三步各「以前一結果為 1 起算」＝各加 n−1 ⇒ (n1+n2+n3−3) mod 6
const palaceClosed = (n1, n2, n3) => (((n1 + n2 + n3 - 3) % 6) + 6) % 6;

// ── 掌訣逐步版（口訣的字面翻譯，獨立實作供交叉核對）：
//    從大安起正月順數至本月；從月宮起初一順數至本日；從日宮起子時順數至本時
function palaceStepwise(n1, n2, n3) {
  let pos = 0;                                  // 大安
  for (let i = 2; i <= n1; i++) pos = (pos + 1) % 6;  // 月上起（正月=大安）
  for (let i = 2; i <= n2; i++) pos = (pos + 1) % 6;  // 日上起（初一=月宮）
  for (let i = 2; i <= n3; i++) pos = (pos + 1) % 6;  // 時上起（子時=日宮）
  return pos;
}

function verdictOf(palaceIdx) {
  const palace = PALACES[palaceIdx];
  const v = JI[palace];
  return { palaceIdx, palace, verdict: v, pick: v === '吉' ? '大' : v === '凶' ? '小' : null }; // null=棄場
}

// ── S-time：台北時刻（呼叫端負責 −240 分錨定）→ 農曆月/日/時支 → 宮
function castFromTaipei(y, m, d, hh, mi) {
  const n = numbersFromTaipei(y, m, d, hh, mi);
  const idx = palaceClosed(n.nMonth, n.nDay, n.nHour);
  const step = palaceStepwise(n.nMonth, n.nDay, n.nHour);
  if (idx !== step) throw new Error(`閉式(${idx})≠逐步(${step})：${JSON.stringify(n)}`); // 運行時恆真斷言
  return Object.assign(verdictOf(idx), {
    nMonth: n.nMonth, nDay: n.nDay, nHour: n.nHour, lunarText: n.lunarText,
    monthPalace: PALACES[palaceClosed(n.nMonth, 1, 1)],            // 探索欄位：月宮（起因）
    dayPalace: PALACES[palaceClosed(n.nMonth, n.nDay, 1)],         // 探索欄位：日宮（經過）
  });
}

// ── 錨定輔助：UTC ms → −240 分 → 台北牆鐘（UTC+8 無夏令）→ 起課
function castFromAnchorUtcMs(utcMs, offsetMin = -240) {
  const t = new Date(utcMs + offsetMin * 60000 + 8 * 3600000); // 台北牆鐘（以 UTC getters 讀）
  return Object.assign(
    castFromTaipei(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()),
    { anchorUtc: new Date(utcMs + offsetMin * 60000).toISOString() }
  );
}

// ── S-rand：脈衝 → HMAC 位元組流 → 拒絕采樣三個均勻數(1..60) → 同一條閉式
//    60=6 的倍數 ⇒ 各數 mod 6 精確均勻 ⇒ 三數和 mod 6 精確均勻 ⇒ 六宮精確各 1/6（免模擬即證，模擬僅複核）
function randNumbersFromPulse(pulseHex, gamePk) {
  const key = Buffer.from(pulseHex, 'hex');
  const nums = [];
  for (let ctr = 0; nums.length < 3 && ctr < 64; ctr++) {
    const block = crypto.createHmac('sha256', key).update(`xiaoliuren|${gamePk}|${ctr}`).digest();
    for (const byte of block) {
      if (nums.length >= 3) break;
      if (byte < 240) nums.push((byte % 60) + 1); // 拒絕采樣去模數偏差（240=4×60）
    }
  }
  if (nums.length < 3) throw new Error('拒絕采樣耗盡（機率上不可能）');
  return nums;
}
function castRandFromPulse(pulseHex, gamePk) {
  const [n1, n2, n3] = randNumbersFromPulse(pulseHex, gamePk);
  const idx = palaceClosed(n1, n2, n3);
  const step = palaceStepwise(n1, n2, n3);
  if (idx !== step) throw new Error(`S-rand 閉式(${idx})≠逐步(${step})：${n1},${n2},${n3}`);
  return Object.assign(verdictOf(idx), { n1, n2, n3 });
}

const __api = { PALACES, JI, palaceClosed, palaceStepwise, verdictOf, castFromTaipei, castFromAnchorUtcMs, randNumbersFromPulse, castRandFromPulse };
module.exports = __api;

// ─────────────── 自測 ───────────────
if (require.main === module && process.argv.includes('--selftest')) {
  let fail = 0;
  const ok = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ← ' + detail}`); if (!cond) fail++; };

  // 1) 閉式 vs 掌訣逐步：全輸入空間逐一相等（月1..12×日1..30×時1..12=4320）
  let mismatch = 0;
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= 30; d++) for (let h = 1; h <= 12; h++)
    if (palaceClosed(m, d, h) !== palaceStepwise(m, d, h)) mismatch++;
  ok('閉式=逐步（4320 組全輸入）', mismatch === 0, `${mismatch} 組不等`);

  // 2) 手算錨點（逐步掌訣人工推演，凍結於 2026-07-12 討論輪）
  const anchors = [
    [1, 1, 1, '大安'],   // 正月初一子時
    [2, 1, 1, '留連'],   // 二月初一子時
    [3, 5, 6, '空亡'],   // 三月初五巳時（審查輪手算）
    [5, 10, 8, '速喜'],  // 五月初十未時（審查輪手算）
    [12, 30, 12, '赤口'],// 十二月三十亥時（mod 繞回）
  ];
  for (const [m, d, h, exp] of anchors)
    ok(`錨點 月${m}日${d}時${h} = ${exp}`, PALACES[palaceClosed(m, d, h)] === exp, PALACES[palaceClosed(m, d, h)]);

  // 3) 吉凶映射與空亡棄場
  ok('大安→押大', verdictOf(0).pick === '大', JSON.stringify(verdictOf(0)));
  ok('赤口→押小', verdictOf(3).pick === '小', JSON.stringify(verdictOf(3)));
  ok('空亡→棄場(null)', verdictOf(5).pick === null && verdictOf(5).verdict === '空亡', JSON.stringify(verdictOf(5)));

  // 4) 曆法整合（CNY 錨點；農曆層本身已由 meihua 自測凍結，此處驗接線）
  const c1 = castFromTaipei(2026, 2, 17, 23, 30); // 丙午正月初一、23:30 屬當日子時 → (1+1+1-3)%6=0 大安
  ok('2026-02-17 23:30 = 正月初一子時 → 大安', c1.palace === '大安' && c1.nMonth === 1 && c1.nDay === 1 && c1.nHour === 1, JSON.stringify(c1));
  const c2 = castFromTaipei(2024, 2, 10, 12, 0);  // 正月初一午時(7) → 6%6=0 大安
  ok('2024-02-10 12:00 = 正月初一午時 → 大安', c2.palace === '大安' && c2.nHour === 7, JSON.stringify(c2));
  const c3 = castFromTaipei(2025, 1, 29, 15, 0);  // 正月初一申時(9) → 8%6=2 速喜
  ok('2025-01-29 15:00 = 正月初一申時 → 速喜', c3.palace === '速喜' && c3.nHour === 9, JSON.stringify(c3));

  // 5) −240 錨定輔助：2026-07-04T23:05Z −240分 → 19:05Z → 台北 7/5 03:05 寅時(3)
  const a1 = castFromAnchorUtcMs(Date.parse('2026-07-04T23:05:00Z'));
  ok('−240 錨定：23:05Z → 台北次日 03:05 寅時', a1.nHour === 3 && a1.anchorUtc === '2026-07-04T19:05:00.000Z', JSON.stringify(a1));

  // 6) S-rand：確定性＋界＋分布（精確均勻之數學已證，模擬複核 6×10⁵）
  const PULSE = 'a'.repeat(128); // 假脈衝（512-bit hex）
  const r1 = castRandFromPulse(PULSE, 777001), r2 = castRandFromPulse(PULSE, 777001), r3 = castRandFromPulse(PULSE, 777002);
  ok('S-rand 確定性（同脈衝同 gamePk 恆同）', JSON.stringify(r1) === JSON.stringify(r2), '');
  ok('S-rand 靈敏性（不同 gamePk 不同數）', JSON.stringify(r1.n1 + ',' + r1.n2 + ',' + r1.n3) !== JSON.stringify(r3.n1 + ',' + r3.n2 + ',' + r3.n3), '');
  ok('S-rand 數界 1..60', [r1, r3].every(r => [r.n1, r.n2, r.n3].every(n => n >= 1 && n <= 60)), '');
  const cnt = [0, 0, 0, 0, 0, 0]; const N = 600000;
  for (let i = 0; i < N; i++) cnt[castRandFromPulse(PULSE, i).palaceIdx]++;
  const maxDev = Math.max(...cnt.map(c => Math.abs(c / N - 1 / 6)));
  ok(`S-rand 六宮均勻（6×10⁵ 最大偏差 ${(maxDev * 100).toFixed(3)}pp < 0.3pp）`, maxDev < 0.003, cnt.join(','));
  // 精確理論值（凍結給 p₀ 用）：P(空亡棄場)=1/6≈16.667%；有表態中 押大=3/5=60%、押小=2/5=40%

  console.log(fail === 0 ? '\n全部通過 ✅' : `\n${fail} 項失敗 ❌`);
  process.exit(fail === 0 ? 0 : 1);
}
