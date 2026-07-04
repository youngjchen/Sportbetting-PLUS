/* 雙重賽(同日同對戰兩場)唯一鍵修法測試
   情境：2026-06-25 大都會(主) vs 小熊(客) 兩場 01:10 / 07:10
   驗證：findGame(玩運彩) 與 pickByTime/gamesToAdd(賠率) 都用 開球時間 把兩場分開。 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://x.test/' });
global.window = dom.window; global.document = dom.window.document; global.Event = dom.window.Event;
global.fetch = () => Promise.reject(new Error('no-net')); window.fetch = global.fetch;

const pg = require('./pregame-integration.js');
const odds = require('./odds-integration.js');

let pass = 0, total = 0;
function chk(name, cond) { total++; if (cond) pass++; console.log((cond ? '✅' : '❌') + ' ' + name); }

// ---------- 玩運彩 findGame：同日同對戰兩場用 gameTime 分流 ----------
const DATA = [
  { date: '2026-06-25', time: '01:10', officialId: 'CHC@NYM_0110', awayTeam: '小熊', homeTeam: '大都會', status: 'finished', awayScore: 5, homeScore: 3 },
  { date: '2026-06-25', time: '07:10', officialId: 'CHC@NYM_0710', awayTeam: '小熊', homeTeam: '大都會', status: 'finished', awayScore: 2, homeScore: 8 },
  { date: '2026-06-25', time: '02:10', officialId: 'CIN@NYY_0210', awayTeam: '紅人', homeTeam: '洋基', status: 'finished', awayScore: 1, homeScore: 0 }, // 單場對照
];
const card01 = { type: 'match', away: '小熊', home: '大都會', gameTime: '01:10' };
const card07 = { type: 'match', away: '小熊', home: '大都會', gameTime: '07:10' };
const cardNo = { type: 'match', away: '小熊', home: '大都會' };                 // 沒記時間＋同日多場 → 模糊，交人工（2026-07-04 修訂）
const cardSingle = { type: 'match', away: '紅人', home: '洋基' };               // 單場 → 行為不變

console.log('=== 玩運彩 findGame（雙重賽分流）===');
const f01 = pg.findGame(DATA, card01, '2026-06-25');
const f07 = pg.findGame(DATA, card07, '2026-06-25');
chk('01:10 卡 → 配到第一場(5:3)', f01 && f01.officialId === 'CHC@NYM_0110' && f01.homeScore === 3);
chk('07:10 卡 → 配到第二場(8 主分)', f07 && f07.officialId === 'CHC@NYM_0710' && f07.homeScore === 8);
chk('兩場互不相同(沒被壓成一場)', f01 && f07 && f01.officialId !== f07.officialId);
chk('無 gameTime 卡＋同日多場 → null（模糊交人工，防錯配；2026-07-04 修訂）', pg.findGame(DATA, cardNo, '2026-06-25') === null);
chk('單場對照 → 正常命中(行為不變)', pg.findGame(DATA, cardSingle, '2026-06-25').officialId === 'CIN@NYY_0210');
chk('別日不誤配(精確同日)', pg.findGame(DATA, card01, '2026-06-24') === null);

// ---------- 2026-07-04 實戰回歸：美國連兩天賽程映射到同一台灣日期 ----------
// 07:05(美7/3晚場,已完賽 5:9) 與 23:05(美7/4日場,未開打) 同為台灣 7/4 海盜@國民；
// 舊版「單一候選直接回傳」讓 23:05 卡被 07:05 場錯誤結算 → 新版必須驗時間(±120分)。
console.log('\n=== 2026-07-04 跨日錯配回歸 ===');
const DATA2 = [
  { date: '2026-07-04', time: '07:05', officialId: 'PIT@WSH_0705', awayTeam: '海盜', homeTeam: '國民', status: 'finished', awayScore: 5, homeScore: 9 },
];
chk('23:05 卡 vs 只有 07:05 完賽場 → null（不錯配）', pg.findGame(DATA2, { type: 'match', away: '海盜', home: '國民', gameTime: '23:05' }, '2026-07-04') === null);
chk('07:05 卡 → 正常配對（時間吻合）', pg.findGame(DATA2, { type: 'match', away: '海盜', home: '國民', gameTime: '07:05' }, '2026-07-04').officialId === 'PIT@WSH_0705');
chk('23:05 卡＋兩場都在 → 配到 23:05 場', (function(){ const D = DATA2.concat([{ date: '2026-07-04', time: '23:05', officialId: 'PIT@WSH_2305', awayTeam: '海盜', homeTeam: '國民', status: 'scheduled', awayScore: null, homeScore: null }]); const g = pg.findGame(D, { type: 'match', away: '海盜', home: '國民', gameTime: '23:05' }, '2026-07-04'); return g && g.officialId === 'PIT@WSH_2305'; })());

// ---------- 賠率 pickByTime：候選多場時用開球時間挑 ----------
console.log('\n=== 賠率 pickByTime（雙重賽分流）===');
const G = [
  { id: 172455, startISO: '2026-06-25T01:10:00+08:00', homeTeam: '大都會', awayTeam: '小熊' },
  { id: 172456, startISO: '2026-06-25T07:10:00+08:00', homeTeam: '大都會', awayTeam: '小熊' },
];
chk('it.gameTime=07:10 → 挑到 id 172456', odds.pickByTime(G, { gameTime: '07:10' }).id === 172456);
chk('it.gameTime=01:10 → 挑到 id 172455', odds.pickByTime(G, { gameTime: '01:10' }).id === 172455);
chk('單一候選 → 直接回傳(舊行為)', odds.pickByTime([G[0]], { gameTime: '07:10' }).id === 172455);
chk('無 gameTime → 退回第一場', odds.pickByTime(G, {}).id === 172455);
chk('gStartHHMM 解析 startISO', odds.gStartHHMM(G[1]) === '07:10');

// ---------- 賠率 gamesToAdd：自動排盤補足缺的場(含雙重賽第二場) ----------
console.log('\n=== 賠率 gamesToAdd（自動排盤去重）===');
const feedDay = [
  G[0], G[1],
  { id: 172460, startISO: '2026-06-25T02:10:00+08:00', homeTeam: '洋基', awayTeam: '紅人' },
];
const addEmpty = odds.gamesToAdd([], feedDay);
chk('空盤面 → 排入全部 3 場(雙重賽兩張)', addEmpty.length === 3);
chk('空盤面 → 含 01:10 與 07:10 兩場', addEmpty.some(g => g.id === 172455) && addEmpty.some(g => g.id === 172456));

const existing1 = [{ type: 'match', away: '小熊', home: '大都會', gameTime: '01:10' }];
const add1 = odds.gamesToAdd(existing1, feedDay);
chk('已有 01:10 卡 → 只補 07:10 + 洋基場(2 場)', add1.length === 2 && add1.some(g => g.id === 172456) && !add1.some(g => g.id === 172455));

const existingNoTime = [{ type: 'match', away: '小熊', home: '大都會' }];          // 舊卡沒記時間
const addNo = odds.gamesToAdd(existingNoTime, feedDay);
chk('已有無時間舊卡 → 視為涵蓋一場、補另一場 Mets/Cubs', addNo.filter(g => g.homeTeam === '大都會').length === 1);

const addBoth = odds.gamesToAdd([existing1[0], { type: 'match', away: '小熊', home: '大都會', gameTime: '07:10' }], feedDay);
chk('兩場都在盤面 → Mets/Cubs 不重排', !addBoth.some(g => g.homeTeam === '大都會'));

console.log('\n總計 ' + pass + '/' + total + ' 通過');
process.exit(pass === total ? 0 : 1);
