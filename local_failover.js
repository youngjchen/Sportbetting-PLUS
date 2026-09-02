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
// 手動單發：node local_failover_workspace.js（會建立/更新專用 clone 後跑一輪）
// ============================================================
'use strict';
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expertRescueReason, selectExpertRescueSlot } = require('./failover_health.js');
const { computeOddsPortalGates, dueOddsPortalGate, pruneOddsPortalGateState, runOddsPortal, dueHarvestGate, runOddsPortalHarvest, dueSwapGate, runBetExplorer, isBet365ProbeDue } = require('./oddsportal_local.js');
const { mirrorPregameOutputs } = require('./local_failover_workspace.js');

const REPO_DIR = __dirname;
const STATE_FILE = path.join(os.homedir(), 'bb_failover_state.json');
const LOCK_FILE = path.join(os.tmpdir(), 'bb_failover.lock');
const LEAGUES = ['mlb', 'npb', 'cpbl', 'kbo'];
// 顆粒度 5 分（使用者命令）由雲端原生提供：playsport 迴圈每 5 分一輪。備援只在雲端「連漏兩輪」
// 才接手 → 門檻 12 分；排程仍每 5 分醒一次，所以雲端一死最慢 5 分鐘就補上，顆粒度不掉。
// 門檻若設 4 分會與健康的雲端重疊觸發＝同資料抓兩次、對站方不禮貌、git 噪音。
// ‼️ 一定要綁 pregame 路徑判齡：雲端空轉時仍會每 6 分提交「只動 lottery_series 時戳」的殭屍提交
//   （2026-07-28 00:08 實測 pregame 內容 138 場逐字相同），看整體提交節奏會被騙。
// 已知縫隙：明牌全量波（8~25 分）持鎖期間 pregame 輪會被跳過，序列出現同長度空檔——鎖=git 操作安全前提。
const PREGAME_STALE_MIN = 12;
const RESCUE_GAP_MIN = 85;     // 每聯盟救援最小間隔
const DEEP_WIN = [4, 7];       // 深掃補位窗（台灣時）

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sh = (cmd, opt) => execSync(cmd, Object.assign({ cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opt || {}));

// 台灣時 HH:MM（給 log 用）
function hhmm(ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(11, 16); }
// 從 expert_alarm 的完整時刻表（targetsFor＝保底＋深掃＋開賽簇 T-120/T-35，含無賽日規則）
// 選救援波次：WAF 明確指紋選最近已過波；一般鏈死只選已等滿 40 分鐘的最近波。
// 這樣既不會在準點跟健康雲端搶跑，也不會被 30 分鐘密集波次不斷重置等待期。
// 只用 BASELINES 會漏簇波：
// MLB 04:00 深掃後到 22:00 之間沒有保底，早場(06:40~09:45)的賽前波全靠簇波。
// 跨午夜：用 now 與 now-12h 各算一份合併（targetsFor 以當日為錨）。
function rescueSlot(lg, blocked) {
  let A;
  try { A = require('./expert_alarm.js'); } catch (_) { return null; }
  const now = Date.now();
  const cands = [];
  for (const anchor of [now, now - 12 * 3600e3]) {
    let games = [];
    try { games = A.loadGames(lg, anchor) || []; } catch (_) {}
    let ts = [];
    try { ts = A.targetsFor(lg, games, anchor) || []; } catch (_) {}
    for (const t of ts) cands.push({ at: t.atMs, deep: t.deep ? true : false });
  }
  return selectExpertRescueSlot(cands, now, blocked);
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }
function twNow() { return new Date(Date.now() + 8 * 3600e3); }

function main() {
  if (process.env.BB_FAILOVER_ISOLATED !== '1') {
    throw new Error('本機備援拒絕在互動工作目錄執行；請改跑 local_failover_workspace.js');
  }
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
  // 1) 專用 clone 必須乾淨；不再使用 autostash，從架構上切斷互動工作區衝突。
  try {
    // launcher 已拒絕未知 untracked；這裡只檢查 tracked 修改，node_modules 是專用 clone 的正常 runtime。
    const dirty = sh('git status --porcelain --untracked-files=no').trim();
    if (dirty) { log('專用備援 clone 不乾淨，本輪 fail-closed：\n' + dirty); return; }
  } catch (e) { log('工作樹檢查失敗，本輪放棄：' + e.message.split('\n')[0]); return; }
  try { sh('git pull --rebase origin main'); }
  catch (e) { try { sh('git rebase --abort'); } catch (_) {} log('pull 失敗，本輪放棄：' + e.message.split('\n')[0]); return; }

  // autostash 回貼可能把衝突標記寫進「別的工作」留在樹上的資料檔（2026-07-29 14:40 污染案：
  // 標記被互動 session 的 git add 帶上雲 → odds 管線讀壞檔全停 40 分）——發現即還原 origin 乾淨版。
  try {
    const dirtyData = sh('git diff --name-only -- data').split('\n').filter(Boolean);
    for (const f of dirtyData) {
      try {
        if (fs.readFileSync(path.join(REPO_DIR, f), 'utf8').includes('<<<<<<<')) {
          sh('git checkout -- "' + f + '"');
          log('⚠️ ' + f + ' 含衝突標記（autostash 撞擊），已還原乾淨版');
        }
      } catch (_) {}
    }
  } catch (_) {}

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
      mirrorPregameOutputs(REPO_DIR, staged);
    } catch (e) { log('pregame 本機抓取失敗：' + e.message.split('\n')[0]); }
  }

  // 2b) OddsPortal 的 Stake 賠率在 GitHub 美國 runner 只回空 bookmaker rows → 只能本機抓。
  // 2026-08-04 使用者拍板：廢 15 分鐘盯哨，改「賽程驅動閘」一天 5-6 次
  // （初盤×2＋對調 T-2.5h×2＋收盤×2；細節見 oddsportal_local.js 檔頭）。
  // 每閘缺口驅動：scraper 端只抓「初盤/收盤還沒填」的比賽（含 3.5 天回補），上限 40 場。
  try {
    const games = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'data', 'pregame_data.json'), 'utf8'));
    // WNBA 賽程是獨立檔（2026-08-05 使用者要求 WNBA 也抓初盤/收盤）；缺席不影響棒球閘。
    try {
      const w = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'data', 'wnba_pregame.json'), 'utf8'));
      for (const g of (w.games || [])) {
        games.push({ league: 'wnba', date: g.date, gameTime: g.time || g.gameTime,
          awayTeam: g.away || g.awayTeam, homeTeam: g.home || g.homeTeam });
      }
    } catch (_) {}
    const gate = dueOddsPortalGate(computeOddsPortalGates(games, Date.now()), state, Date.now())
      || dueSwapGate(state, Date.now());
    if (gate) {
      state['opg_' + gate.id] = Date.now();      // 先記「試過」：失敗也不重跑，等下一閘順手回補
      pruneOddsPortalGateState(state, Date.now());
      state.oddsportal_last_attempt = Date.now();
      saveState(state);
      log(`閘 ${gate.id} 到點（${gate.mode}／${gate.leagues.join('+')}）→ 抓取`);
      // 2026-08-07 使用者拍板：BetExplorer 當主來源（OddsPortal 上架列表當日場次大量缺漏）。
      // 兩道防線：BetExplorer 先跑，丟例外才退回 OddsPortal，避免單一來源故障就整輪空手。
      let outputs;
      try {
        outputs = runBetExplorer({ repoDir: REPO_DIR, leagues: gate.leagues });
        log('BetExplorer 主來源完成');
      } catch (error) {
        log(`BetExplorer 失敗（${String(error.message).split(/\r?\n/)[0]}）→ 退回 OddsPortal`);
        outputs = runOddsPortal({ repoDir: REPO_DIR, gate });
      }
      staged.push(...outputs);
      state.oddsportal_last_success = Date.now();
      state.bet365_probe_last_success = Date.now();
      saveState(state);
      log('OddsPortal 本閘完成');
    } else {
      // 2c) 歷史收割閘（RESULTS 4/1 至今；讓位給日常閘＝同一喚醒只跑一種）
      let harvestState = {};
      try { harvestState = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'data', 'oddsportal_harvest_state.json'), 'utf8')); } catch (_) {}
      const hg = dueHarvestGate(harvestState, state, Date.now());
      if (hg) {
        state['opg_' + hg.id] = Date.now();
        saveState(state);
        log(`OddsPortal 收割閘 ${hg.id} 到點 → 歷史批次（每批≤350 場）`);
        const outputs = runOddsPortalHarvest({ repoDir: REPO_DIR });
        staged.push(...outputs);
        log('OddsPortal 收割批完成');
      }
    }
  } catch (e) {
    log('OddsPortal 閘處理失敗：' + e.message.split('\n')[0]);
  }

  // 2d) Bet365 對調可能發生在原本每天一次的 T-2.5h 閘之前。每 30 分鐘只讀
  // 讓分頁（每場 1 個請求，不抓 Stake 三市場／逐格歷史），讓警示與明細不再等數小時。
  if (isBet365ProbeDue(state.bet365_probe_last_success, Date.now())) {
    try {
      state.bet365_probe_last_attempt = Date.now();
      saveState(state);
      staged.push(...runBetExplorer({ repoDir: REPO_DIR, leagues: LEAGUES, bet365Only: true }));
      state.bet365_probe_last_success = Date.now();
      saveState(state);
      log('Bet365 30 分鐘輕量對調巡檢完成');
    } catch (e) {
      log('Bet365 輕量對調巡檢失敗：' + e.message.split('\n')[0]);
    }
  }

  // 3) 明牌各聯盟：被擋指紋 qualified===0 且 updated 新鮮
  for (const lg of LEAGUES) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'data', `expert_picks_${lg}.json`), 'utf8')); }
    catch (_) { continue; }
    const cov = (d.coverage || {})[lg] || {};
    const now = Date.now();
    const updatedMs = d.updated ? +new Date(d.updated) : NaN;
    const updAge = d.updated ? (now - updatedMs) / 3600e3 : 99;
    // 波次對齊：直接吃 expert_alarm 的時刻表（使用者改保底/深掃時點，備援自動跟著改）。
    // WAF 指紋可立即補；只有「資料沒更新」時才等雲端 40 分鐘完成寬限。
    const preReason = expertRescueReason({
      qualified: cov.qualified,
      updatedMs,
      slotAtMs: null,
      nowMs: now,
    });
    const slot = rescueSlot(lg, preReason.blocked);
    // 兩種觸發：①被擋指紋（雲端波有跑但整波 403，會蓋 qualified:0）
    //          ②鏈死偵測（2026-07-28 名冊崩跌案：波直接中止、什麼都不蓋 → 檔案更新時間
    //            落後「最近該跑的波」40 分以上＝該波沒完成；40 分 > 35 分補償窗，不誤搶雲端遲到波）
    const reason = expertRescueReason({
      qualified: cov.qualified,
      updatedMs,
      slotAtMs: slot && slot.at,
      nowMs: now,
    });
    const { blocked, overdue } = reason;
    if (!reason.rescue) continue;
    const last = state['ep_' + lg] || 0;
    if (!slot) { log(`${lg} 尚無已過波次，略過`); continue; }
    if (last >= slot.at) { log(`${lg} ${blocked ? '被擋' : '鏈死'}，但 ${slot.deep ? '深掃' : '保底'}波 ${hhmm(slot.at)} 已救過，略過`); continue; }
    log(`${lg} 觸發原因：${blocked ? '被擋指紋(qualified=0)' : ''}${blocked && overdue ? '＋' : ''}${overdue ? '鏈死(檔案落後 ' + hhmm(slot.at) + ' 波)' : ''}`);
    const tw = twNow();
    const deepKey = 'deep_' + lg, today = tw.toISOString().slice(0, 10);
    const useDeep = slot.deep && state[deepKey] !== today;
    log(`${lg} ${blocked ? '雲端 WAF 指紋' : '雲端波逾期未落地'}（qualified=${cov.qualified ?? '未知'}, updated ${updAge.toFixed(1)}h 前）→ 補 ${hhmm(slot.at)} ${slot.deep ? '深掃' : '保底'}波，本機 ${useDeep ? '深掃' : '全量'}`);
    try {
      execFileSync('node', ['expert_picks.js'], {
        cwd: REPO_DIR, stdio: ['ignore', 'inherit', 'inherit'], timeout: 35 * 60e3,
        env: Object.assign({}, process.env, { EP_LEAGUE: lg, EP_MODE: 'full', EP_DEEP: useDeep ? '1' : '' }),
      });
      staged.push(`data/expert_picks_${lg}.json`);
      staged.push('data/expert_archive');   // 深掃/跨日修剪會寫歸檔檔，不推上雲=板上歷史缺洞（legacy 只 add 主檔的舊坑）
      state['ep_' + lg] = slot.at;          // 記「補了哪個波」而非執行時刻：下一波到點才會再跑
      if (useDeep) state[deepKey] = today;
      saveState(state);
    } catch (e) { log(`${lg} 本機抓取失敗：` + e.message.split('\n')[0]); }
  }

  // 4) 推送（只 stage 本腳本產出的檔，不碰使用者工作區其他東西）
  if (!staged.length) { log('本輪無事可做（雲端健康或無變化）'); return; }
  try {
    sh('git add -- ' + staged.map(s => `"${s}"`).join(' '));
    // 提交前最後一道閘：暫存內容絕不可含衝突標記（見上方 2026-07-29 污染案）
    if (sh('git diff --cached').includes('<<<<<<<')) {
      log('⚠️ 暫存內容含衝突標記，本輪放棄推送並還原');
      sh('git reset -q');
      for (const f of staged) { try { sh('git checkout -- "' + f + '"'); } catch (_) {} }
      return;
    }
    const diff = sh('git diff --cached --stat').trim();
    if (!diff) { log('產出與雲端無差異，不推'); sh('git reset -q'); return; }
    sh('git commit -q -m "data: local failover rescue（WAF 或雲端波逾期，本機接手）"');
    for (let i = 0; i < 3; i++) {
      // -X theirs（rebase 語義＝保留「被重放的我方提交」內容）：雲端殭屍提交每 6 分動一次
      // lottery_series（單行 JSON）必衝突；我方是剛抓的新資料、永遠比殭屍時戳新，取我方安全。
      try { sh('git pull --rebase -X theirs origin main'); } catch (_) { try { sh('git rebase --abort'); } catch (_) {} continue; }
      try { sh('git push origin main'); log('✅ 已推送：' + staged.join(', ')); return; }
      catch (_) { /* 撞到別的提交，重試 */ }
    }
    log('⚠️ 推送三次失敗，資料留在本機提交，下輪再試');
  } catch (e) { log('推送流程失敗：' + e.message.split('\n')[0]); }
}

main();
