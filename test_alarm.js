// test_alarm.js
const assert = require('assert');
const { computeNextWave, clusterGames, targetsFor, BASELINES } = require('./expert_alarm.js');
const T = (h, m) => { const d = new Date('2026-07-26T00:00:00+08:00'); d.setUTCHours(h - 8, m, 0, 0); return d.getTime(); };
const games = [ // 週日日職實查賽程：12:00×2、12:30、16:00、17:00×2（台灣時間）
  ...[[12,0],[12,0],[12,30],[16,0],[17,0],[17,0]].map(([h,m]) => ({ startMs: T(h,m) })) ];
// 1) 簇聚類：±60 分鏈式 → 兩簇（12:00~12:30、16:00~17:00）
assert.strictEqual(clusterGames(games).length, 2);
// 2) 09:00 時，下一波＝第一簇 T-120（10:00 full）但距離 3600s > MAX_SLEEP=900 → 回 skip 睡 900 再重估
let w = computeNextWave('npb', games, T(9,0), 0);
assert.strictEqual(w.mode, 'skip'); assert.strictEqual(w.sleepSec, 900);
// 3) 11:20 時，下一波＝第一簇 T-35（11:25 final）
w = computeNextWave('npb', games, T(11,20), 0);
assert.strictEqual(w.mode, 'full'); assert.strictEqual(w.sleepSec, 300);   // 亞洲T-35已升級全量(2026-07-24稽核修正)
// 4) 錯過補償：11:40 才醒（T-35=11:25 已過 15 分、未超過開賽 12:00+10 分、上一波在 10:05）→ 立刻補
w = computeNextWave('npb', games, T(11,40), T(10,5));
assert.strictEqual(w.sleepSec, 0); assert.strictEqual(w.mode, 'full');   // 亞洲T-35=full
// 6) 無賽日：mlb 中午 12:00、無任何比賽 → skip 且 sleep ≤900（僅剩明晨深掃這種遠目標）
w = computeNextWave('mlb', [], T(12,0), 0);
assert.strictEqual(w.mode, 'skip'); assert.ok(w.sleepSec <= 900);
// 7) mlb 深掃：03:50 → 04:00 deep full（600s ≤ 900 直接回目標；2026-07-27 拍板深掃 06:00→04:00）
w = computeNextWave('mlb', [], T(3,50), 0);
assert.strictEqual(w.mode, 'full'); assert.strictEqual(w.deep, 1); assert.strictEqual(w.sleepSec, 600);
// 8) 無賽日：npb 全日無賽 → targets 只剩深掃、無保底
const ts0 = targetsFor('npb', [], T(11,0));
assert.ok(ts0.every(x => x.label !== '保底'), '無賽日不得有保底');
assert.ok(ts0.some(x => x.deep === 1), '無賽日深掃仍在');
// 9) final 不被鄰近 full 吸收：MLB 明晨 00:30 場（game=T(24,30)，now=T(23,0)）
//    T-35=23:55 與 23:30 保底 full 相近，final 仍須獨立存在（T-20 上板紅線）
const ts9 = targetsFor('mlb', [{ startMs: T(24,30) }], T(23,0));
const final9 = ts9.find(x => x.mode === 'final' && x.label.includes('簇T-35'));
assert.ok(final9, 'final 波不得被鄰近保底 full 吸收');
const full9 = ts9.find(x => x.atMs === T(23,30));
assert.ok(full9 && full9.mode === 'full', 'atMs===T(23,30) 的保底 full 應仍存在');
// 10) 同刻 full 合併標籤：npb 14:00 開賽 → 簇 T-120(12:00) 撞上 12:00 保底，兩個 full 合併成一筆
const ts10 = targetsFor('npb', [{ startMs: T(14,0) }], T(9,0));
const at12 = ts10.filter(x => x.atMs === T(12,0));
assert.strictEqual(at12.length, 1, '12:00 應合併成恰一筆');
assert.strictEqual(at12[0].mode, 'full');
assert.ok(at12[0].label.includes('保底') && at12[0].label.includes('簇T-120'), '標籤應同時含保底與簇T-120（合併形式）');
// 11) 寬簇交錯開賽：每 20 分子群各有自己的 T-35，全量仍只一個
const gS = [[2,20],[3,7],[3,10],[4,5],[4,10]].map(([h,m])=>({startMs:T(h,m)}));
const tsS = targetsFor('mlb', gS, T(0,0));
assert.deepStrictEqual(tsS.filter(x=>x.mode==='final').map(x=>x.atMs), [T(1,45),T(2,32),T(3,30)], '子群 finals=01:45/02:32/03:30');
assert.strictEqual(tsS.filter(x=>x.label.includes('簇T-120')).length, 1, '寬簇仍只一個 T-120 full');
// 12) 準點觸發不帶補償尾綴（遲到>60s 才帶；第4條的 15 分遲到案例仍須帶）
w = computeNextWave('npb', games, T(11,25), T(10,0));
assert.strictEqual(w.sleepSec, 0); assert.ok(!w.label.includes('補償'), '準點不標補償');
console.log('OK test_alarm');

