// ============================================================
// local_failover.js — 本機備援：雲端爬蟲被擋時自動接手抓取＋推送
// 背景（2026-07-27）：玩運彩 WAF 以 TLS 指紋＋資料中心 IP 雙層封鎖，
// GitHub Actions 全滅但住宅 IP 的 curl 放行 → 本機成唯一可用出口。
// 觸發指紋（零誤報設計，雲端健康時本腳本零動作）：
//   · pregame：origin/main 上 data/pregame_data.json 最後真變動 > 40 分
//     （殭屍提交只動 lottery_series 時戳，不會騙過此檢查）
//   · 明牌(各聯盟)：expert_picks_{lg}.json 的 coverage.qualified === 0
//     且 updated 在 3h 內（=雲端波有在跑但整波被 403；無賽日波全 skip
//     → updated 老化 → 不觸發，天然避開空轉）
// 節流：每聯盟救援間隔 ≥85 分（貼齊 1.5h 保底節奏）；lockfile 防重入。
// 深掃補位：台灣 04:00~07:00 窗內若該聯盟仍被擋，當日一次改 EP_DEEP=1
//   （補 yesterday 頁 result 回補，保住跟單回測生命週期）。
// 排程：failover_task.cmd + Windows 工作排程器每 30 分（見 cmd 檔頭註解）。
// 手動單發：node local_failover.js --once（同邏輯跑一輪）
// ============================================================
'use strict';
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_DIR = __dirname;
const STATE_FILE = path.join(os.homedir(), 'bb_failover_state.json');
const LOCK_FILE = path.join(os.tmpdir(), 'bb_failover.lock');
const LEAGUES = ['mlb', 'npb', 'cpbl', 'kbo'];
// 12 分：排程每 15 分跑一次 → 雲端死亡期間台彩序列維持 ~15 分顆粒度（雲端原生為 5 分）。
// 雲端復活時它自己每 ~6 分提交 → 年齡永遠 <12 → 備援自動休眠，不會雙頭抓。
// ‼️ 一定要綁 pregame 路徑判齡：雲端空轉時仍會每 6 分提交「只動 lottery_series 時戳」的殭屍提交
//   （2026-07-28 00:08 實測 pregame 內容 138 場逐字相同），看整體提交節奏會被騙。
const PREGAME_STALE_MIN = 12;
const EP_FRESH_H = 3;          // qualified=0 且 updated 在此小時數內才視為「被擋」
const RESCUE_GAP_MIN = 85;     // 每聯盟救援最小間隔
const DEEP_WIN = [4, 7];       // 深掃補位窗（台灣時）

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sh = (cmd, opt) => execSync(cmd, Object.assign({ cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opt || {}));

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }
function twNow() { return new Date(Date.now() + 8 * 3600e3); }

function main() {
  // 防重入（前一輪全量可能 10~25 分）
  if (fs.existsSync(LOCK_FILE)) {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (age < 40 * 60e3) { log('前一輪尚在執行（lock），跳過'); return; }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  try { run(); } finally { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }
}

function run() {
  const state = loadState();
  // 1) 同步到遠端最新（autostash 容忍本機未提交修改）
  try { sh('git pull --rebase --autostash origin main'); }
  catch (e) { try { sh('git rebase --abort'); } catch (_) {} log('pull 失敗，本輪放棄：' + e.message.split('\n')[0]); return; }

  const staged = [];

  // 2) pregame 生命徵象：origin/main 上主檔最後真變動年齡
  let pregameDead = false;
  try {
    const ts = +sh('git log -1 --format=%ct origin/main -- data/pregame_data.json').trim() * 1000;
    const ageMin = (Date.now() - ts) / 60e3;
    pregameDead = ageMin > PREGAME_STALE_MIN;
    log(`pregame 主檔年齡 ${ageMin.toFixed(0)} 分 → ${pregameDead ? '死亡，本機接手' : '正常'}`);
  } catch (e) { log('pregame 檢查失敗：' + e.message.split('\n')[0]); }
  if (pregameDead) {
    try {
      execFileSync('node', ['playsport_scraper.js'], { cwd: REPO_DIR, stdio: ['ignore', 'inherit', 'inherit'], timeout: 240e3 });
      // 鏡射 workflow 的搬檔步驟
      for (const f of ['pregame_data.json', 'lottery_series.json']) {
        const src = path.join(REPO_DIR, f), dst = path.join(REPO_DIR, 'data', f);
        if (fs.existsSync(src)) { fs.copyFileSync(src, dst); staged.push('data/' + f); }
      }
    } catch (e) { log('pregame 本機抓取失敗：' + e.message.split('\n')[0]); }
  }

  // 3) 明牌各聯盟：被擋指紋 qualified===0 且 updated 新鮮
  for (const lg of LEAGUES) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'data', `expert_picks_${lg}.json`), 'utf8')); }
    catch (_) { continue; }
    const cov = (d.coverage || {})[lg] || {};
    const updAge = d.updated ? (Date.now() - +new Date(d.updated)) / 3600e3 : 99;
    const blocked = cov.qualified === 0 && updAge < EP_FRESH_H;
    if (!blocked) continue;
    const last = state['ep_' + lg] || 0;
    if (Date.now() - last < RESCUE_GAP_MIN * 60e3) { log(`${lg} 被擋但距上次救援 <${RESCUE_GAP_MIN} 分，略過`); continue; }
    // 深掃補位：窗內每日一次帶 EP_DEEP
    const tw = twNow();
    const deepKey = 'deep_' + lg, today = tw.toISOString().slice(0, 10);
    const useDeep = tw.getUTCHours() >= DEEP_WIN[0] && tw.getUTCHours() < DEEP_WIN[1] && state[deepKey] !== today;
    log(`${lg} 雲端被擋（qualified=0, updated ${updAge.toFixed(1)}h 前）→ 本機 ${useDeep ? '深掃' : '全量'}`);
    try {
      execFileSync('node', ['expert_picks.js'], {
        cwd: REPO_DIR, stdio: ['ignore', 'inherit', 'inherit'], timeout: 35 * 60e3,
        env: Object.assign({}, process.env, { EP_LEAGUE: lg, EP_MODE: 'full', EP_DEEP: useDeep ? '1' : '' }),
      });
      staged.push(`data/expert_picks_${lg}.json`);
      state['ep_' + lg] = Date.now();
      if (useDeep) state[deepKey] = today;
      saveState(state);
    } catch (e) { log(`${lg} 本機抓取失敗：` + e.message.split('\n')[0]); }
  }

  // 4) 推送（只 stage 本腳本產出的檔，不碰使用者工作區其他東西）
  if (!staged.length) { log('本輪無事可做（雲端健康或無變化）'); return; }
  try {
    sh('git add -- ' + staged.map(s => `"${s}"`).join(' '));
    const diff = sh('git diff --cached --stat').trim();
    if (!diff) { log('產出與雲端無差異，不推'); sh('git reset -q'); return; }
    sh('git commit -q -m "data: local failover rescue（雲端被 WAF 擋，本機接手）"');
    for (let i = 0; i < 3; i++) {
      try { sh('git pull --rebase origin main'); } catch (_) { try { sh('git rebase --abort'); } catch (_) {} continue; }
      try { sh('git push origin main'); log('✅ 已推送：' + staged.join(', ')); return; }
      catch (_) { /* 撞到別的提交，重試 */ }
    }
    log('⚠️ 推送三次失敗，資料留在本機提交，下輪再試');
  } catch (e) { log('推送流程失敗：' + e.message.split('\n')[0]); }
}

main();
