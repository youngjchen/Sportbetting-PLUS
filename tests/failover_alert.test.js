'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const alert = require('../failover-alert.js');
const watch = require('../failover_watch.js');

const at = (iso) => Date.parse(iso);
// 10/12 停擺事故的真實時間點：BetExplorer 最後一次 10:00、OddsPortal 09:38，之後卡死到 10/13 23:05
const INCIDENT = {
  summary: { updatedAt: '2026-10-12T10:00:55+08:00' },
  opBet365: { updatedAt: '2026-10-12T09:38:40+08:00' },
};
const pregame = [
  { league: 'MLB', date: '2026-10-12', time: '08:00', awayTeam: '守護者', homeTeam: '白襪', status: 'finished' },
  { league: 'NPB', date: '2026-10-12', time: '17:00', awayTeam: '火腿', homeTeam: '西武', status: 'upcoming' },
  { league: 'MLB', date: '2026-10-13', time: '08:08', awayTeam: '道奇', homeTeam: '費城人', status: 'upcoming' },
];

test('備援有在更新（90 分內）＝正常，不警示', () => {
  const status = alert.failoverStatus({ ...INCIDENT, pregame, now: at('2026-10-12T11:00:00+08:00') });
  assert.equal(status.state, 'ok');
  assert.equal(status.stalled, false);
  assert.equal(status.ageMin, 59);
});

test('兩道備援都超過 90 分沒更新、36h 內有未開賽棒球＝停擺（10/12 事故重播）', () => {
  const status = alert.failoverStatus({ ...INCIDENT, pregame, now: at('2026-10-12T12:00:00+08:00') });
  assert.equal(status.state, 'stalled');
  assert.equal(status.stalled, true);
  assert.equal(status.lastAt, at('2026-10-12T10:00:55+08:00'));
  assert.equal(status.upcomingCount, 2);
  assert.deepEqual(status.nextGame, { league: 'NPB', away: '火腿', home: '西武', at: at('2026-10-12T17:00:00+08:00') });
  const text = alert.describe(status);
  assert.equal(text.title, '本機備援已停 1 小時 59 分');
  assert.match(text.lines[0], /BetExplorer 10\/12 10:00／OddsPortal 10\/12 09:38/);
  assert.match(text.lines[1], /最近一場 NPB 火腿@西武 10\/12 17:00/);
});

test('門檻是「超過」90 分：剛好 90 分不算、多 1 分才算', () => {
  const base = { summary: { updatedAt: '2026-10-12T10:00:00+08:00' }, opBet365: null, pregame };
  assert.equal(alert.failoverStatus({ ...base, now: at('2026-10-12T11:30:00+08:00') }).state, 'ok');
  assert.equal(alert.failoverStatus({ ...base, now: at('2026-10-12T11:31:00+08:00') }).state, 'stalled');
});

test('只停一道不算整條停擺：取兩道裡較新的更新時間', () => {
  const status = alert.failoverStatus({
    summary: { updatedAt: '2026-10-12T06:00:00+08:00' },
    opBet365: { updatedAt: '2026-10-12T11:40:00+08:00' },
    pregame, now: at('2026-10-12T12:00:00+08:00'),
  });
  assert.equal(status.state, 'ok');
  assert.equal(status.lastAt, at('2026-10-12T11:40:00+08:00'));
});

test('恢復後（10/13 23:40 有新資料）警示解除', () => {
  const status = alert.failoverStatus({
    summary: { updatedAt: '2026-10-13T23:40:15+08:00' },
    opBet365: { updatedAt: '2026-10-13T23:40:35+08:00' },
    pregame, now: at('2026-10-13T23:45:00+08:00'),
  });
  assert.equal(status.state, 'ok');
  assert.equal(status.stalled, false);
});

test('36h 內沒有未開賽棒球＝idle 不警示（已完賽、延賽、取消、進行中、36h 外、非棒球都不算）', () => {
  const quiet = [
    { league: 'MLB', date: '2026-10-12', time: '08:00', status: 'finished' },
    { league: 'KBO', date: '2026-10-12', time: '17:00', status: 'postponed' },
    { league: 'CPBL', date: '2026-10-12', time: '18:35', status: 'canceled' },
    { league: 'NPB', date: '2026-10-12', time: '11:00', status: 'inprogress' },
    { league: 'MLB', date: '2026-10-14', time: '08:00', status: 'upcoming' },   // 12:00 起算 44h 後
    { league: 'NBA', date: '2026-10-12', time: '19:00', status: 'upcoming' },
  ];
  const status = alert.failoverStatus({ ...INCIDENT, pregame: quiet, now: at('2026-10-12T12:00:00+08:00') });
  assert.equal(status.state, 'idle');
  assert.equal(status.stalled, false);
  assert.equal(status.upcomingCount, 0);
});

test('時間已過但狀態還沒翻成進行中的場次不算未開賽', () => {
  const late = [{ league: 'MLB', date: '2026-10-12', time: '10:00', status: 'upcoming' }];
  assert.equal(alert.failoverStatus({ ...INCIDENT, pregame: late, now: at('2026-10-12T12:00:00+08:00') }).state, 'idle');
});

test('讀不到備援檔或賽程＝unknown，不警示（斷網不誤報）', () => {
  const now = at('2026-10-12T12:00:00+08:00');
  assert.equal(alert.failoverStatus({ summary: null, opBet365: null, pregame, now }).state, 'unknown');
  assert.equal(alert.failoverStatus({ summary: { updatedAt: 'garbage' }, opBet365: {}, pregame, now }).state, 'unknown');
  const noSchedule = alert.failoverStatus({ ...INCIDENT, pregame: null, now });
  assert.equal(noSchedule.state, 'unknown');
  assert.equal(noSchedule.stalled, false);
});

test('時間一律顯示台灣時間', () => {
  assert.equal(alert.formatTw(at('2026-10-12T02:05:00Z')), '10/12 10:05');
  assert.equal(alert.formatTw(at('2026-12-31T16:30:00Z')), '1/1 00:30');
  assert.equal(alert.formatAge(45), '45 分');
  assert.equal(alert.formatAge(120), '2 小時');
  assert.equal(alert.formatAge(2235), '37 小時 15 分');
});

// 模擬排程每 5 分跑一輪，回傳每輪的通知標題（沒通知＝null）
function runDesktop(fromIso, toIso, statusAt, state) {
  const out = [];
  let current = state || {};
  for (let t = at(fromIso); t <= at(toIso); t += 5 * 60e3) {
    const plan = watch.planDesktop(statusAt(t), current, t);
    current = plan.state;
    if (plan.notify) out.push({ t, title: plan.notify.title, lines: plan.notify.lines, sticky: plan.notify.sticky });
  }
  return { notes: out, state: current };
}

test('桌面通知（10/12 事故重播，電腦一直開著）：滿 90 分跳一次、之後每 3 小時提醒、恢復跳一次', () => {
  const recoveredAt = at('2026-10-13T23:06:00+08:00');
  const statusAt = (now) => (now < recoveredAt
    ? alert.failoverStatus({ ...INCIDENT, pregame, now })
    : alert.failoverStatus({ summary: { updatedAt: '2026-10-13T23:06:00+08:00' }, pregame, now }));
  const { notes, state } = runDesktop('2026-10-12T09:00:00+08:00', '2026-10-13T23:30:00+08:00', statusAt);
  // 有比賽的時段一直有（pregame 固定），所以第一則在 10:00 後滿 90 分的那一輪（11:35）
  assert.equal(alert.formatTw(notes[0].t), '10/12 11:35');
  assert.equal(notes[0].title, '🛑 本機備援已停 1 小時 34 分');
  assert.equal(notes[0].sticky, true);
  assert.equal(alert.formatTw(notes[1].t), '10/12 14:35', '3 小時後再提醒一次');
  const last = notes[notes.length - 1];
  assert.equal(last.title, '✅ 本機備援已恢復');
  assert.equal(alert.formatTw(last.t), '10/13 23:10');
  assert.match(last.lines[0], /停了約 37 小時 5 分，最新更新 10\/13 23:06/);
  assert.equal(notes.filter((n) => n.title.startsWith('✅')).length, 1);
  assert.equal(state.alertedAt, undefined, '恢復後清掉停擺狀態');
});

test('桌面通知：斷網／睡眠剛恢復的 30 分鐘內不報停擺（備援會在這段補推），補推成功就完全不吵', () => {
  const pushedAt = at('2026-10-07T22:50:00+08:00');   // 恢復連線後第 2 輪，備援補推上 GitHub
  const statusAt = (now) => {
    if (now < at('2026-10-07T22:40:00+08:00')) return alert.failoverStatus({ pregame, now });  // 斷網：讀不到＝unknown
    const summary = { updatedAt: now >= pushedAt ? '2026-10-07T22:50:00+08:00' : '2026-10-07T13:40:00+08:00' };
    return alert.failoverStatus({ summary, pregame: [{ league: 'MLB', date: '2026-10-08', time: '08:00', status: 'upcoming' }], now });
  };
  const online = { lastRunAt: at('2026-10-07T13:40:00+08:00'), onlineSince: at('2026-10-07T09:00:00+08:00') };
  const { notes } = runDesktop('2026-10-07T13:45:00+08:00', '2026-10-08T00:00:00+08:00', statusAt, online);
  assert.deepEqual(notes, []);
});

test('桌面通知：剛恢復連線但備援真的卡住 → 等滿 30 分才報；電腦睡眠醒來同理', () => {
  const stuck = (now) => alert.failoverStatus({ ...INCIDENT, pregame, now });
  // 電腦 11:00 睡著、14:00 醒來（兩輪間隔 3 小時）：14:00～14:25 不報，14:30 才報
  const asleep = { lastRunAt: at('2026-10-12T11:00:00+08:00'), onlineSince: at('2026-10-12T08:00:00+08:00') };
  const { notes } = runDesktop('2026-10-12T14:00:00+08:00', '2026-10-12T15:00:00+08:00', stuck, asleep);
  assert.equal(notes.length, 1);
  assert.equal(alert.formatTw(notes[0].t), '10/12 14:30');
});

test('桌面通知：沒發過停擺通知就恢復＝什麼都不做；空窗（沒比賽）不通知也不清狀態', () => {
  const now = at('2026-10-12T16:00:00+08:00');
  const ok = alert.failoverStatus({ summary: { updatedAt: '2026-10-12T15:50:00+08:00' }, pregame, now });
  assert.equal(watch.planDesktop(ok, { lastRunAt: now - 5 * 60e3, onlineSince: now - 3600e3 }, now).notify, null);
  const idle = alert.failoverStatus({ ...INCIDENT, pregame: [], now });
  const alerted = { lastRunAt: now - 5 * 60e3, onlineSince: now - 6 * 3600e3, alertedAt: now - 3600e3, lastNotifyAt: now - 3600e3 };
  const plan = watch.planDesktop(idle, alerted, now);
  assert.equal(plan.notify, null);
  assert.equal(plan.state.alertedAt, alerted.alertedAt);
});

test('桌面通知 XML：特殊字元跳脫、停擺版會停在螢幕上直到按「知道了」', () => {
  const xml = watch.toastXml('🛑 a<b', ['x & y', '"z"'], true);
  assert.match(xml, /scenario="reminder"/);
  assert.match(xml, /<text>🛑 a&lt;b<\/text><text>x &amp; y<\/text><text>&quot;z&quot;<\/text>/);
  assert.match(xml, /activationType="system"/);
  assert.doesNotMatch(watch.toastXml('✅', ['ok'], false), /scenario|actions/);
});

test('GitHub issue：停擺且沒開單→開；停擺已開單→不重開；恢復→關；空窗／不知道→不動', () => {
  const now = at('2026-10-12T12:00:00+08:00');
  const stalled = alert.failoverStatus({ ...INCIDENT, pregame, now });
  const ok = alert.failoverStatus({ summary: { updatedAt: '2026-10-12T11:50:00+08:00' }, pregame, now });
  const idle = alert.failoverStatus({ ...INCIDENT, pregame: [], now });
  const unknown = alert.failoverStatus({ pregame, now });
  const open = [{ number: 7, title: 'x' }];
  assert.deepEqual(watch.planGithub(stalled, []), { action: 'open' });
  assert.deepEqual(watch.planGithub(stalled, open), { action: 'none' });
  assert.deepEqual(watch.planGithub(ok, open), { action: 'close', numbers: [7] });
  assert.deepEqual(watch.planGithub(ok, []), { action: 'none' });
  assert.deepEqual(watch.planGithub(idle, open), { action: 'none' });
  assert.deepEqual(watch.planGithub(unknown, open), { action: 'none' });

  assert.equal(watch.issueTitle(stalled), '🛑 本機備援停擺：BET365 備援 1 小時 59 分沒更新');
  const body = watch.issueBody(stalled, 'youngjchen');
  assert.match(body, /^@youngjchen /);
  assert.match(body, /bb_failover\.log/);
  assert.match(body, /最近一場 NPB 火腿@西武/);
  assert.match(watch.closeComment(ok), /^✅ 已恢復：BET365 備援最新更新 10\/12 11:50/);
});

test('排盤板紅條：停擺時插在 header 下方、恢復時移除', async () => {
  const header = { id: 'header' };
  const body = { children: [header] };
  header.parentNode = body;
  body.insertBefore = (node, ref) => {
    node.parentNode = body;
    node.remove = () => { body.children.splice(body.children.indexOf(node), 1); };
    const index = ref ? body.children.indexOf(ref) : body.children.length;
    body.children.splice(index < 0 ? body.children.length : index, 0, node);
  };
  header.nextSibling = null;
  const document = {
    readyState: 'complete', visibilityState: 'visible', body,
    getElementById: (id) => body.children.find((node) => node.id === id) || null,
    querySelector: (selector) => (selector === 'header' ? header : null),
    createElement: () => ({ style: {}, setAttribute() {}, innerHTML: '' }),
    addEventListener() {},
  };
  const responses = {
    'oddsportal_bet365.json': INCIDENT.opBet365,
    'pregame_data.json': pregame,
  };
  const global = {
    document,
    console,
    setInterval() {},
    __oddsPortalIntegration: { _getFeed: () => INCIDENT.summary },
    fetch: async (url) => {
      const name = Object.keys(responses).find((key) => url.includes(key));
      return { ok: true, json: async () => responses[name] };
    },
  };
  const api = alert.install(global);
  api._setClock(() => at('2026-10-12T12:00:00+08:00'));
  const stalled = await api.refresh();
  assert.equal(stalled.state, 'stalled');
  const bar = document.getElementById('failoverAlert');
  assert.ok(bar, '停擺時要出現紅條');
  assert.equal(body.children.indexOf(bar), 1, '紅條要在 header 正下方');
  assert.match(bar.innerHTML, /🛑 本機備援已停 1 小時 59 分/);
  assert.match(bar.title, /bb_failover\.log/);

  api._setClock(() => at('2026-10-12T10:30:00+08:00'));
  assert.equal(document.getElementById('failoverAlert'), null, '恢復後紅條要消失');
});

test('index.html 載入紅條 add-on（排在 oddsportal-integration 之後，帶版本號）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /oddsportal-integration\.js\?v=[^"]+"><\/script><script src="\.\/failover-alert\.js\?v=\w+"><\/script>/);
});

test('failover-watchdog 工作流：無 BOM、能寫 issue、不碰爬蟲 run、排程與通道測試都在', () => {
  const file = path.join(ROOT, '.github/workflows/failover-watchdog.yml');
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual(Array.from(bytes.subarray(0, 3)), [0xEF, 0xBB, 0xBF]);
  const text = bytes.toString('utf8');
  assert.match(text, /issues:\s*write/);
  assert.match(text, /cancel-in-progress:\s*false/);
  assert.match(text, /cron:\s*'21,51 \* \* \* \*'/);
  assert.match(text, /node failover_watch\.js --github/);
  assert.match(text, /\/data\/oddsportal_bet365\.json/);
  assert.match(text, /\/data\/pregame_data\.json/);
  assert.doesNotMatch(text, /gh run cancel|gh workflow run|actions:\s*write/);
});

test('本機排程先跑桌面警示、再跑備援本體（本體卡死也照樣通知）', () => {
  const cmd = fs.readFileSync(path.join(ROOT, 'failover_task.cmd'), 'utf8');
  const watchAt = cmd.indexOf('node failover_watch.js --desktop');
  const mainAt = cmd.indexOf('node local_failover_workspace.js');
  assert.ok(watchAt > 0 && mainAt > watchAt);
  assert.equal((cmd.match(/\r\n/g) || []).length, (cmd.match(/\n/g) || []).length, 'cmd 檔必須全 CRLF');
});
