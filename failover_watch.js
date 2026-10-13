'use strict';
// ============================================================
// failover_watch.js — 本機備援停擺的「主動」通知（判定邏輯在 failover-alert.js，與排盤板紅條同一套）
//   node failover_watch.js --github      GitHub Actions（failover-watchdog.yml，每 30 分）：讀 checkout 的 data/*.json；
//                                         停擺就開 issue（@ 使用者 → GitHub 寄信），恢復就留言並關閉。
//   node failover_watch.js --desktop     使用者電腦（failover_task.cmd，每 5 分、排在備援本體之前）：讀 GitHub 上的最新檔；
//                                         停擺跳 Windows 桌面通知（停擺期間每 3 小時再提醒），恢復再跳一次。
//   node failover_watch.js --test-toast  手動測桌面通知能不能跳出來
//   node failover_watch.js               只印判定結果（除錯用，讀 GitHub 最新檔）
// 桌面通知為什麼排在備援本體「之前」、而且看 GitHub 上的檔：10/12 那次是備援工作區卡死（每輪印 not clean 就結束），
//   接在本體後面或看本機檔都會一起瞎掉；看 GitHub 上實際推上去的檔，連「抓到了但推不上去」也抓得到。
// 電腦關機／睡眠時桌面通知本身也停 → 由 GitHub issue 補位。
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { failoverStatus, describe, formatAge, formatTw, LOG_HINT } = require('./failover-alert.js');

const RAW_DIR = 'https://raw.githubusercontent.com/youngjchen/Sportbetting-PLUS/main/data/';
const ISSUE_LABEL = 'failover-stall';
const TEST_LABEL = 'failover-stall-test';
const REMIND_MS = 3 * 3600e3;
// 電腦剛醒／斷網剛恢復時 GitHub 上的檔一定是舊的，但備援本體這一輪就會補推：先給它 30 分鐘，
// 否則每次一恢復就先跳「停擺」、5 分鐘後又跳「恢復」。（10/5～10/11 實際有 7 段 1～9 小時的斷網空窗）
const ONLINE_GRACE_MS = 30 * 60e3;
const RUN_GAP_MS = 15 * 60e3;   // 兩輪間隔超過 15 分＝中間這台電腦沒在跑（睡眠／關機）
const FETCH_TIMEOUT_MS = 20000;
const RUNTIME_DIR = process.env.SBP_RUNTIME || path.join(__dirname, '.runtime');
const STATE_FILE = path.join(RUNTIME_DIR, 'failover_watch_state.json');
// Windows 內建 PowerShell 的 AppUserModelID：不用另外註冊 App 就能發通知
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function statusLine(status) {
  return `state=${status.state} 最後更新 ${formatTw(status.lastAt)}（${formatAge(status.ageMin) || '—'}前；` +
    `BetExplorer ${formatTw(status.betExplorerAt)}／OddsPortal ${formatTw(status.oddsPortalAt)}）` +
    (status.state === 'ok' ? '' : ` 36h 內未開賽 ${status.upcomingCount} 場`);
}

// ---------- 桌面通知 ----------

// 停擺第一次就通知；還沒恢復就每 3 小時再提醒（半夜那則可能被收進通知中心沒看到）；恢復時通知一次。
// 連得上 GitHub 未滿 30 分（剛開機／剛醒／剛恢復網路）先不報停擺，見 ONLINE_GRACE_MS。
// idle／unknown 不清停擺狀態：停擺中遇到沒比賽的空窗或斷網，恢復時仍會報「已恢復」。
function planDesktop(status, state, now) {
  const next = Object.assign({}, state || {});
  const prevRunAt = Number(next.lastRunAt || 0);
  next.lastRunAt = now;
  if (status.state === 'unknown') {
    delete next.onlineSince;
    return { notify: null, state: next };
  }
  if (!next.onlineSince || now - prevRunAt > RUN_GAP_MS) next.onlineSince = now;
  if (status.stalled) {
    if (now - next.onlineSince < ONLINE_GRACE_MS) return { notify: null, state: next };
    if (next.alertedAt && now - Number(next.lastNotifyAt || 0) < REMIND_MS) return { notify: null, state: next };
    const text = describe(status);
    if (!next.alertedAt) next.alertedAt = now;
    next.lastNotifyAt = now;
    next.lastAt = status.lastAt;
    return { notify: { title: '🛑 ' + text.title, lines: [text.short, '查 .runtime\\bb_failover.log 或工作排程 BB-ScrapeFailover'], sticky: true }, state: next };
  }
  if (status.state === 'ok' && next.alertedAt) {
    const gapMin = next.lastAt ? Math.round((status.lastAt - next.lastAt) / 60000) : null;
    delete next.alertedAt;
    delete next.lastNotifyAt;
    delete next.lastAt;
    return {
      notify: { title: '✅ 本機備援已恢復', lines: [(gapMin ? '停了約 ' + formatAge(gapMin) + '，' : '') + '最新更新 ' + formatTw(status.lastAt)], sticky: false },
      state: next,
    };
  }
  return { notify: null, state: next };
}

function xmlEscape(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// sticky＝reminder 情境：通知停在螢幕上直到按「知道了」，不會幾秒後自己縮進通知中心
function toastXml(title, lines, sticky) {
  return `<toast${sticky ? ' scenario="reminder"' : ''}><visual><binding template="ToastGeneric">` +
    [title].concat(lines || []).slice(0, 3).map((t) => `<text>${xmlEscape(t)}</text>`).join('') +
    '</binding></visual>' +
    (sticky ? '<actions><action content="知道了" arguments="dismiss" activationType="system"/></actions>' : '') +
    '</toast>';
}

function showToast(title, lines, sticky) {
  const xml = Buffer.from(toastXml(title, lines, sticky), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xml}')))`,
    '$t = New-Object Windows.UI.Notifications.ToastNotification $x',
    // 同一個 Tag：提醒／恢復會取代前一則，通知中心不會堆一串
    "$t.Tag = 'bb-failover'; $t.Group = 'sportbetting'",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($t)`,
  ].join('\n');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true });
}

async function fetchRaw(name, headers) {
  const response = await fetch(RAW_DIR + name + '?t=' + Date.now(), { headers: headers || {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
  return response.text();
}

// BetExplorer 摘要 4.8MB，每 5 分整檔下載太浪費 → 只抓開頭 2KB（updatedAt 是第 4 個欄位）；
// 抓不到就當「不知道」，改靠 OddsPortal 那一道判定。
async function fetchSummaryHead() {
  const text = await fetchRaw('oddsportal_summary.json', { Range: 'bytes=0-2047' });
  const match = text.match(/"updatedAt"\s*:\s*"([^"]+)"/);
  return match ? { updatedAt: match[1] } : null;
}

async function remoteStatus() {
  const [summary, opBet365, pregame] = await Promise.all([
    fetchSummaryHead().catch(() => null),
    fetchRaw('oddsportal_bet365.json').then(JSON.parse).catch(() => null),
    fetchRaw('pregame_data.json').then(JSON.parse).catch(() => null),
  ]);
  return failoverStatus({ summary, opBet365, pregame, now: Date.now() });
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function saveState(state) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function desktop() {
  const status = await remoteStatus();
  const plan = planDesktop(status, loadState(), Date.now());
  if (plan.notify) {
    try { showToast(plan.notify.title, plan.notify.lines, plan.notify.sticky); }
    catch (error) { log('桌面通知失敗：' + String(error.message).split('\n')[0]); }
  }
  saveState(plan.state);
  // 正常時不寫 log（每 5 分一行會無限長大）；只記異常與有發通知的輪次
  if (status.state !== 'ok' || plan.notify) log(statusLine(status) + (plan.notify ? ` → 通知「${plan.notify.title}」` : ''));
}

// ---------- GitHub issue ----------

function planGithub(status, openIssues) {
  if (status.stalled && !openIssues.length) return { action: 'open' };
  if (status.state === 'ok' && openIssues.length) return { action: 'close', numbers: openIssues.map((i) => i.number) };
  return { action: 'none' };
}

function issueTitle(status) {
  return `🛑 本機備援停擺：BET365 備援 ${formatAge(status.ageMin)}沒更新`;
}

function issueBody(status, owner) {
  const text = describe(status);
  return [
    `${owner ? '@' + owner + ' ' : ''}本機備援（你電腦上的排程 BB-ScrapeFailover）已經 **${formatAge(status.ageMin)}** 沒把 BET365 備援資料推上 GitHub。`,
    '',
    ...text.lines.map((line) => '- ' + line),
    '',
    '這段期間 BET365 官網若失效，棒球讓分方沒有備援可用。',
    '',
    `**怎麼查**：${LOG_HINT}（卡住時常見每輪都印「failover workspace not clean」）。`,
    '',
    '_恢復後這張 issue 會自動留言並關閉（failover-watchdog.yml 每 30 分檢查一次）。排盤板頂部紅條、電腦桌面通知用的是同一套判定。_',
  ].join('\n');
}

function closeComment(status) {
  return `✅ 已恢復：BET365 備援最新更新 ${formatTw(status.lastAt)}（${formatAge(status.ageMin)}前），自動關閉。`;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureLabel(name, description) {
  gh(['label', 'create', name, '--color', 'B60205', '--description', description, '--force']);
}

function readLocal(file) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8')); } catch (_) { return null; }
}

// 通道測試：開一張測試 issue 立刻關掉，證明 GITHUB_TOKEN 開／關 issue 的權限是通的（push 改到看門狗時自動跑）
function selfTest(owner) {
  ensureLabel(TEST_LABEL, '本機備援停擺警示的通道測試（自動開關）');
  const url = gh(['issue', 'create', '--label', TEST_LABEL,
    '--title', '[通道測試] 本機備援停擺警示',
    '--body', `${owner ? '@' + owner + ' ' : ''}這是 failover-watchdog 的通道測試：真的停擺時你會收到像這樣的通知。這張會自動關閉，不用處理。`]).trim();
  const number = (url.match(/\/issues\/(\d+)/) || [])[1];
  if (!number) throw new Error('建立測試 issue 後讀不到編號：' + url);
  gh(['issue', 'close', number, '--comment', '通道測試完成：開／關 issue 權限正常，自動關閉。']);
  log('通道測試 OK：' + url);
}

function github() {
  const owner = process.env.GITHUB_REPOSITORY_OWNER || '';
  if (process.env.SELF_TEST === 'true') selfTest(owner);
  const status = failoverStatus({
    summary: readLocal('oddsportal_summary.json'),
    opBet365: readLocal('oddsportal_bet365.json'),
    pregame: readLocal('pregame_data.json'),
    now: Date.now(),
  });
  log(statusLine(status));
  if (status.state === 'unknown') { log('讀不到備援檔或賽程，不動作'); return; }
  ensureLabel(ISSUE_LABEL, '本機備援停擺警示（failover-watchdog 自動開關）');
  const open = JSON.parse(gh(['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,title', '--limit', '20']) || '[]');
  const plan = planGithub(status, open);
  if (plan.action === 'open') {
    log('停擺 → 開 issue：' + gh(['issue', 'create', '--label', ISSUE_LABEL, '--title', issueTitle(status), '--body', issueBody(status, owner)]).trim());
  } else if (plan.action === 'close') {
    for (const number of plan.numbers) {
      gh(['issue', 'close', String(number), '--comment', closeComment(status)]);
      log(`已恢復 → 關閉 issue #${number}`);
    }
  } else {
    log(open.length ? `仍停擺中，issue #${open.map((i) => i.number).join(',')} 保持開啟` : '正常，不動作');
  }
}

async function main(argv) {
  if (argv.includes('--github')) return github();
  if (argv.includes('--desktop')) return desktop();
  if (argv.includes('--test-toast')) {
    showToast('🛑 本機備援停擺警示（測試）', ['真的停擺時會跳這則', '按「知道了」關閉'], true);
    return log('測試通知已送出');
  }
  log(statusLine(await remoteStatus()));
}

if (require.main === module) {
  // 排程每 5 分一輪、排在備援本體前面：無論如何 90 秒內收工，不能拖住備援
  setTimeout(() => { log('逾時 90 秒，強制結束'); process.exit(2); }, 90000).unref();
  main(process.argv.slice(2)).catch((error) => { log('失敗：' + String(error.message).split('\n')[0]); process.exitCode = 1; });
}

module.exports = { planDesktop, planGithub, issueTitle, issueBody, closeComment, toastXml, statusLine, REMIND_MS, ONLINE_GRACE_MS };
