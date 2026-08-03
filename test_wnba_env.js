// test_wnba_env.js — WNBA 聯盟接線守門（階段3）
// ① D11 歸燈映射：wnba 國際盤讓分→hd,棒球維持→ml ② 鬧鐘 wnba 設定存在且深掃=04:40
// ③ loadGames 能讀 {games:[...]} 形狀的 wnba_pregame ④ 無 EP_LEAGUE 不含 wnba（緊急備援=四棒球,行為零變）
'use strict';
const assert = require('assert');
const { execSync } = require('child_process');

const out = execSync('node -e "const ep=require(\'./expert_picks.js\');console.log(JSON.stringify({m_w:ep.boardMarket(2,\'hd\',\'wnba\'),m_b:ep.boardMarket(2,\'hd\',\'mlb\'),m1:ep.boardMarket(1,\'hd\',\'wnba\'),ou:ep.boardMarket(2,\'ou\',\'wnba\'),n:ep.ACTIVE_ALLIANCES.length,has_w:ep.ACTIVE_ALLIANCES.some(a=>a.lg===\'wnba\')}))"', { cwd: __dirname, encoding: 'utf8' });
const r = JSON.parse(out.trim().split('\n').pop());
assert.strictEqual(r.m_w, 'hd', 'D11: wnba 國際盤讓分應歸 hd');
assert.strictEqual(r.m_b, 'ml', '棒球國際盤讓分應維持 ml');
assert.strictEqual(r.m1, 'hd', 'wnba 運彩盤讓分應為 hd');
assert.strictEqual(r.ou, 'ou', '大小應為 ou');
assert.strictEqual(r.n, 4, '無 EP_LEAGUE 應維持四棒球聯盟');
assert.strictEqual(r.has_w, false, '無 EP_LEAGUE 不得包含 wnba');

const alarmSrc = require('fs').readFileSync(require('path').join(__dirname, 'expert_alarm.js'), 'utf8');
assert.ok(/wnba:\s*\{\s*hot:/.test(alarmSrc), '鬧鐘應有 wnba 保底表');
assert.ok(/deep:\s*\[4,\s*40\]/.test(alarmSrc), 'wnba 深掃應為 04:40');
assert.ok(/wnba_pregame\.json/.test(alarmSrc), '鬧鐘應讀 wnba 專屬賽程檔');

// loadGames 對 {games:[...]} 形狀（wnba_pregame）能抽出場次
const fs = require('fs');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wnbaenv-'));
fs.mkdirSync(path.join(tmpDir, 'data'));
const fixture = { updated: 'x', count: 1, games: [{ officialId: 'WNBA_20991231_客_主_0700', date: '2099-12-31', time: '07:00' }] };
fs.writeFileSync(path.join(tmpDir, 'data', 'wnba_pregame.json'), JSON.stringify(fixture));
for (const f of ['expert_alarm.js']) fs.copyFileSync(path.join(__dirname, f), path.join(tmpDir, f));
const w = execSync('node expert_alarm.js --league=wnba', { cwd: tmpDir, encoding: 'utf8' });
const alarm = JSON.parse(w.trim());
assert.ok(alarm && typeof alarm.sleepSec === 'number', '鬧鐘應回有效 JSON');
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('OK test_wnba_env');
