// ============================================================================
//  Titan007 棒球賠率抓取（雲端版・跑一次就結束，節奏交給 GitHub Actions cron）
//  支援聯盟：MLB(1) / 日職 NPB(2) / 韓職 KBO(17) / 中職 CPBL(5)
//  - 三市場：獨贏(12BET/Bet365/Bwin) / 讓分(Bet365) / 大小分(Bet365)
//  - 讓分與大小分：完整保留整張變動表（每一列＝一次盤口移動）
//  - 獨贏：來源無歷史，只有初盤＋當前，故以「價有變才追加」自己縫軌跡
//  - 隊名對照「分聯盟」：同一個寫法在不同聯盟對到不同隊（如「巨人」在 NPB＝讀賣巨人、
//    在 MLB＝舊金山巨人），徹底避免跨聯盟誤對
//  - 每場標 league；輸出累積到 data/odds_log.json（讀舊檔→合併→寫回，永不刪舊場）
// ============================================================================

const axios = require('axios');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { readJsonRequired } = require('./safe_json.js');
const bet365Fallback = require('./bet365_fallback.js');

// ---- 可調參數 ---------------------------------------------------------------
// 只抓「未來這麼多小時內開打」的比賽。24＝提前一天開始記，涵蓋隔天整批賽事；
// 重複資料以價去重，不會爆量。
const ACTIVE_WINDOW_HOURS = 24;

// 已開賽的比賽仍保留這麼多分鐘繼續補抓「讓分/大小」盤口。
// 為什麼要這樣：日/韓/中職的讓分・大小盤 Bet365 常態只在【開賽前後幾分鐘】才貼出、且很稀疏，
// 而 MLB 提早數小時就有。原本一開賽(ts<=now)就永遠丟棄該場 → 亞洲場臨場才貼的盤根本補不到
// （2026-07-04 實例：爬蟲 13:07~16:50 停擺，17:00 那批亞洲場 16:50 復活只抓到獨贏、讓分還沒貼；
//   17:02 之後爬蟲正常但已開賽被丟，讓分/大小全空）。
// 加這個 grace 窗後，剛開賽的場會再多留幾輪、把臨場貼出的收盤讓分/大小補齊。
// ⚠ 只用於補 hd/ou；獨贏(ml)在開賽後不再累加，避免混入場中價（見 run()）。
const START_GRACE_MIN = 30;

const OUTPUT_FILE = path.join('data', 'odds_log.json');
const REQUEST_GAP_MS = 900;

const LEAGUES_CFG = [
  { key: 'mlb',  id: 1  },
  { key: 'npb',  id: 2  },
  { key: 'kbo',  id: 17 },
  { key: 'cpbl', id: 5  }
];

const ODDS_BASE_URL = 'https://sports.titan007.com/jsData/baseball/1x2/';
const HANDICAP_URL  = 'https://sports.titan007.com/ChangeDetail/handicap.aspx';
const OVERUNDER_URL = 'https://sports.titan007.com/ChangeDetail/overunder.aspx';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://sports.titan007.com/'
};

const ML_BOOKS = [
  { id: '12bet',  kw: '12'  },
  { id: 'bet365', kw: '36'  },
  { id: 'bwin',   kw: 'bwi' }
];

// ---- 隊名對照（分聯盟）------------------------------------------------------
// Titan007 的 MLB 用「城市＋暱稱」全名（如 三藩市巨人、巴爾的摩黃鸝），暱稱子字串就對得上（已實測）。
// 日/韓/中先放標準名＋簡體＋常見短名；因為「分聯盟比對」，短名（巨人、樂天…）可安全使用，
// 不會跨聯盟誤對。Titan007 對日/韓/中的實際用名，跑一次看 log「未對應」清單貼來即補。
const LEAGUE_TEAMS = {
  // ---------- MLB（你已實測，原樣保留） ----------
  mlb: {
    '金鶯':   ['金鶯', '金莺', '黃鸝', '黄鹂'],
    '紅襪':   ['紅襪', '红袜', '紅袜', '红襪'],
    '洋基':   ['洋基'],
    '光芒':   ['光芒', '魔鬼魚', '魔鬼鱼', '坦帕灣魔鬼', '坦帕湾魔鬼'],
    '藍鳥':   ['藍鳥', '蓝鸟'],
    '白襪':   ['白襪', '白袜'],
    '守護者': ['守護者', '守护者', '印第安人', '印地安人'],
    '老虎':   ['老虎'],
    '皇家':   ['皇家'],
    '雙城':   ['雙城', '双城'],
    '太空人': ['太空人'],
    '天使':   ['天使'],
    '運動家': ['運動家', '运动家'],
    '水手':   ['水手'],
    '遊騎兵': ['遊騎兵', '游騎兵', '游骑兵', '遊骑兵'],
    '勇士':   ['勇士'],
    '馬林魚': ['馬林魚', '马林鱼', '馬林鱼', '马林魚'],
    '大都會': ['大都會', '大都会'],
    '費城人': ['費城人', '费城人'],
    '國民':   ['國民', '国民'],
    '小熊':   ['小熊'],
    '紅人':   ['紅人', '红人'],
    '釀酒人': ['釀酒人', '酿酒人'],
    '海盜':   ['海盜', '海盗'],
    '紅雀':   ['紅雀', '红雀'],
    '響尾蛇': ['響尾蛇', '响尾蛇'],
    '落磯':   ['落磯', '落矶', '洛磯', '洛矶', '洛基'],
    '道奇':   ['道奇'],
    '教士':   ['教士'],
    '巨人':   ['巨人']     // 三藩市巨人 → 子字串含「巨人」即對上
  },
  // ---------- 日職 NPB（含你確認的：讀賣只寫「巨人」） ----------
  npb: {
    '讀賣巨人':   ['讀賣巨人', '读卖巨人', '讀賣', '读卖', '巨人軍', '巨人'],   // ← 你確認站上只寫「巨人」
    '阪神虎':     ['阪神虎', '阪神'],
    '橫濱DeNA':   ['橫濱DeNA', '横滨DeNA', 'DeNA', '橫濱灣星', '横滨湾星', '橫濱', '横滨'],
    '廣島鯉魚':   ['廣島鯉魚', '广岛鲤鱼', '廣島東洋', '广岛东洋', '廣島', '广岛', '鯉魚', '鲤鱼'],
    '養樂多燕子': ['養樂多燕子', '养乐多燕子', '東京養樂多', '东京养乐多', '養樂多', '养乐多', '亞庫爾特', '亚库尔特', '燕子'],
    '中日龍':     ['中日龍', '中日龙', '中日'],
    '軟銀鷹':     ['軟銀鷹', '软银鹰', '福岡軟銀', '福冈软银', '軟銀', '软银'],
    '日本火腿':   ['日本火腿', '北海道日本', '火腿'],
    '羅德':       ['千葉羅德', '千叶罗德', '羅德', '罗德'],
    '樂天金鷲':   ['樂天金鷲', '乐天金鹫', '東北樂天', '东北乐天', '金鷲', '金鹫', '金鷹', '金鹰', '樂天', '乐天'],
    '西武獅':     ['西武獅', '西武狮', '埼玉西武', '西武'],
    '歐力士':     ['歐力士野牛', '欧力士野牛', '歐力士', '欧力士']
  },
  // ---------- 韓職 KBO ----------
  kbo: {
    'LG雙子':     ['LG雙子', 'LG双子', 'LG'],
    'KT巫師':     ['KT巫師', 'KT巫师', 'KT'],
    'SSG登陸者':  ['SSG登陸者', 'SSG登陆者', 'SSG'],
    'NC恐龍':     ['NC恐龍', 'NC恐龙', 'NC'],
    '斗山熊':     ['斗山熊', '斗山', '鬥山熊', '鬥山'],
    '起亞虎':     ['起亞虎', '起亚虎', '起亞老虎', '起亚老虎', '起亞', '起亚'],
    '樂天巨人':   ['樂天巨人', '乐天巨人', '羅德巨人', '樂天', '乐天', '巨人'],
    '三星獅':     ['三星獅', '三星狮', '三星'],
    '韓華鷹':     ['韓華鷹', '韩华鹰', '韓華老鷹', '韩华老鹰', '韓華', '韩华'],
    '培證英雄':   ['培證英雄', '培证英雄', '起亞英雄', '友利英雄', '培育英雄', '培證', '培证', '英雄']
  },
  // ---------- 中職 CPBL ----------
  cpbl: {
    '中信兄弟':   ['中信兄弟', '中信', '兄弟象', '兄弟'],
    '統一獅':     ['統一獅', '统一狮', '統一', '统一'],
    '樂天桃猿':   ['樂天桃猿', '乐天桃猿', '桃猿', '樂天', '乐天'],
    '富邦悍將':   ['富邦悍將', '富邦悍将', '富邦', '悍將', '悍将'],
    '味全龍':     ['味全龍', '味全龙', '味全'],
    '台鋼雄鷹':   ['台鋼雄鷹', '台钢雄鹰', '台鋼', '台钢', '雄鷹', '雄鹰', 'TSG', '鷹隊', '鹰队']
  }
};

// 每聯盟各自把別名展平＋長別名優先（避免短字串誤判）；比對只在「該場聯盟」內進行
const LEAGUE_PAIRS = {};
for (const [lg, table] of Object.entries(LEAGUE_TEAMS)) {
  const pairs = [];
  for (const [canon, aliases] of Object.entries(table)) {
    for (const a of aliases) pairs.push([a, canon]);
  }
  pairs.sort((x, y) => y[0].length - x[0].length);
  LEAGUE_PAIRS[lg] = pairs;
}

function mapTeam(rawName, league) {
  if (!rawName) return null;
  const pairs = LEAGUE_PAIRS[league];
  if (!pairs) return null;
  for (const [alias, canon] of pairs) {
    if (rawName.includes(alias)) return canon;
  }
  return null; // 對不上 → 由呼叫端記錄
}

// ---- 時間工具（雲端在 UTC，全部明確處理成台灣時間）-------------------------
function nowTaiwanISO() {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())}T` +
         `${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}:${p(tw.getUTCSeconds())}+08:00`;
}

function parseTaiwan(s) {
  const [d, tRaw] = String(s).trim().split(/\s+/);
  const t = (tRaw && tRaw.split(':').length === 2) ? `${tRaw}:00` : (tRaw || '00:00:00');
  const iso = `${d}T${t}+08:00`;
  return { date: new Date(iso), iso };
}

// 抓取窗格判定（純函式，可單元測試）：
//   · 未開賽 → 只要在未來 limitMs 內就抓（started=false，獨贏/讓分/大小都累加）
//   · 已開賽 → 開賽後 graceMs 內仍抓（started=true，只補讓分/大小，不碰獨贏）
//   · 其他（太遠的未來、太久的過去）→ 不抓
function captureState(ts, now, graceMs, limitMs) {
  const future = ts > now;
  const eligible = future ? (ts < now + limitMs) : (ts > now - graceMs);
  return { eligible, started: !future };
}

function scheduleURLsForLeague(id) {
  const set = new Set();
  const add = (ms) => {
    const tw = new Date(ms + 8 * 3600 * 1000);
    const y = tw.getUTCFullYear();
    const m = tw.getUTCMonth() + 1;
    set.add(`https://sports.titan007.com/jsData/baseball/matchResult/${y}/l${id}_1_${y}_${m}.js`);
  };
  add(Date.now());
  add(Date.now() + ACTIVE_WINDOW_HOURS * 3600 * 1000);
  return [...set];
}

// ---- 解析 ChangeDetail 的 odds2 表格：全部列（rows[0]=最新, rows[末]=初盤）----
function parseHistoryTable(html) {
  const m = html.match(/id=['"]?odds2['"]?[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!m) return null;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows = [];
  let r;
  while ((r = rowRegex.exec(m[1])) !== null) {
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cols = [];
    let td;
    while ((td = tdRegex.exec(r[1])) !== null) {
      cols.push(td[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cols.length >= 3 && !isNaN(parseFloat(cols[0]))) {
      rows.push({ a: cols[0], line: cols[1], b: cols[2] });
    }
  }
  return rows.length ? rows : null;
}

function toNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

// ---- 同表格的帶時間戳版（intl_state 專用；odds_log 格式凍結不動）--------------
// 第4欄「变化时间」含「走地」字樣＝開賽後盤；盤口帶正負號（正=主讓、負=客讓）。
function parseHistoryTableTs(html) {
  const m = html.match(/id=['"]?odds2['"]?[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!m) return null;
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = rowRegex.exec(m[1])) !== null) {
    const cols = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRegex.exec(r[1])) !== null) cols.push(td[1].replace(/<[^>]+>/g, '').trim());
    if (cols.length < 4 || isNaN(parseFloat(cols[0]))) continue;
    const live = /走地/.test(cols[3]);
    const tm = /(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(cols[3]);
    rows.push({ line: toNum(cols[1]), live, hhmm: tm ? `${tm[3].padStart(2, '0')}:${tm[4]}` : null, md: tm ? `${tm[1]}-${tm[2]}` : null });
  }
  rows.reverse();                                  // 由舊到新
  return rows.length ? rows : null;
}

async function fetchMatchOdds(match) {
  const out = { ml: {}, hd: null, ou: null };
  try {
    const res = await axios.get(`${ODDS_BASE_URL}${match.id}.js`, { headers: HEADERS, timeout: 15000 });
    const sb = {}; vm.createContext(sb); vm.runInContext(res.data, sb);
    if (Array.isArray(sb.game)) {
      for (const item of sb.game) {
        const c = item.split('|');
        const name = (c[16] || '').toLowerCase();
        const book = ML_BOOKS.find(b => name.includes(b.kw));
        if (!book) continue;
        out.ml[book.id] = {
          openHome: toNum(c[3]), openAway: toNum(c[4]),
          liveHome: toNum(c[8] || c[3]), liveAway: toNum(c[9] || c[4])
        };
      }
    }
  } catch (e) {
    if (!(e.response && e.response.status === 404)) console.log(`  ❌ 獨贏: ${e.message}`);
  }
  try {
    const res = await axios.get(`${HANDICAP_URL}?id=${match.id}&companyid=8&t=2`, { headers: HEADERS, timeout: 15000 });
    const rows = parseHistoryTable(res.data);
    if (rows) out.hd = rows.map(x => ({ home: toNum(x.a), line: x.line, away: toNum(x.b) }));
    out.hdTs = parseHistoryTableTs(res.data);      // intl_state 用（帶時間戳＋走地旗標）
  } catch (e) { console.log(`  ❌ 讓分: ${e.message}`); }
  try {
    const res = await axios.get(`${OVERUNDER_URL}?id=${match.id}&companyid=8&t=2`, { headers: HEADERS, timeout: 15000 });
    const rows = parseHistoryTable(res.data);
    if (rows) out.ou = rows.map(x => ({ over: toNum(x.a), line: x.line, under: toNum(x.b) }));
  } catch (e) { console.log(`  ❌ 大小: ${e.message}`); }
  return out;
}

// ---- 賽程：逐聯盟抓 1~2 個月檔，篩窗格內未開打的場，每場標 league -----------
async function fetchUpcomingMatches() {
  const now = Date.now();
  const limitMs = ACTIVE_WINDOW_HOURS * 3600 * 1000;
  const graceMs = START_GRACE_MIN * 60 * 1000;
  const seen = new Set();
  const list = [];
  let anyOk = false;

  for (const lg of LEAGUES_CFG) {
    const teamDict = {};
    let data = [];
    for (const url of scheduleURLsForLeague(lg.id)) {
      try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const sb = {}; vm.createContext(sb); vm.runInContext(res.data, sb);
        if (Array.isArray(sb.arrTeam)) sb.arrTeam.forEach(t => { teamDict[t[0]] = t[2]; });
        if (Array.isArray(sb.arrData)) data = data.concat(sb.arrData);
        anyOk = true;
      } catch (e) {
        console.log(`  ⚠️ [${lg.key}] 賽程檔略過（可能該月未發佈或代號需調整）: ${url} (${e.message})`);
      }
    }
    let cnt = 0, graceCnt = 0;
    for (const m of data) {
      if (seen.has(m[0])) continue;
      const { date, iso } = parseTaiwan(m[2]);
      const ts = date.getTime();
      const cs = captureState(ts, now, graceMs, limitMs);
      if (!cs.eligible) continue;
      seen.add(m[0]);
      list.push({
        id: m[0], league: lg.key, time: m[2], startISO: iso, started: cs.started,
        homeRaw: teamDict[m[3]] || null, awayRaw: teamDict[m[4]] || null
      });
      cnt++;
      if (cs.started) graceCnt++;
    }
    console.log(`  [${lg.key}] 窗格內：${cnt} 場${graceCnt ? `（含剛開賽補讓分/大小 ${graceCnt} 場）` : ''}`);
  }

  if (!anyOk) return null;
  return list;
}

function loadLog() {
  return readJsonRequired(
    OUTPUT_FILE,
    (value) => value && typeof value === 'object' && value.matches && typeof value.matches === 'object',
    OUTPUT_FILE
  );
}

// ---- 同 id 開賽時間大改 = Titan007 把整列搬去別場（雙重賽）或真改期 -----------
// 2026-07-17 實例：光芒@紅襪官方雙重賽(01:35/07:10)，Titan007 只給一列 id=172742，
// 先掛在 01:35，開賽前幾小時整列搬到 07:10 → 兩場的賠率史被縫在同一條目、
// 板上跟著 oddsId 把 01:35 卡片的時間改成 07:10（一天兩張 07:10 卡）。
// 判定：時間平移 ≥ MOVE_MIN 才算「搬場」（雙重賽兩場至少差 2 小時；一般微調 <1 小時）。
const MOVE_MIN = 100;
function scheduleMove(oldISO, newISO) {
  const a = Date.parse(oldISO), b = Date.parse(newISO);
  if (isNaN(a) || isNaN(b)) return false;
  return Math.abs(b - a) >= MOVE_MIN * 60 * 1000;
}

// 玩運彩 feed：同聯盟同日同對戰的官方場次數（≥2 = 雙重賽）。讀不到就回空表（一律當改期處理）。
function loadPregamePairCount() {
  const map = {};
  try {
    const feed = JSON.parse(fs.readFileSync(path.join('data', 'pregame_data.json'), 'utf8'));
    const list = Array.isArray(feed) ? feed : Object.values(feed);
    for (const g of list) {
      const lg = String(g.league || '').toLowerCase();
      const away = feedCanon(g.awayTeam, lg), home = feedCanon(g.homeTeam, lg);
      if (!away || !home || !g.date) continue;
      const key = `${lg}|${g.date}|${[away, home].sort().join('|')}`;
      map[key] = (map[key] || 0) + 1;
    }
  } catch (_) { /* pregame feed 缺 → 保守不拆場 */ }
  return map;
}

// 處理搬場：雙重賽 → 舊場整包歸檔成獨立條目（id 加 @HHMM 後綴；板上仍能以 日期+兩隊+時間
// 對到、盤口動向與曾顛倒紀錄不失憶）、新場歸零重新累積；非雙重賽（真改期）→ 沿用同一條目。
// officialTimes（可選）：搬場本身就是消歧義事件——新時間認領一個官方時刻後，
// 若恰剩一個沒人認領的官方時刻、而舊時間又對不上任何官方時刻（Titan 一開始就標錯，
// 2026-07-18 海盜@守護者 G1 官方 01:10、Titan 標 04:10 實例）→ 歸檔標籤直接吸附過去，
// 免得歸檔掛著不存在的時段、板上對不到。
// 回傳：'split' / 'follow' / null（沒有搬場）。
function handleScheduleMove(log, e, m, dhCount, stamp, officialTimes) {
  if (!e || !e.startISO || !m.startISO || !scheduleMove(e.startISO, m.startISO)) return null;
  const oldDate = String(e.startISO).slice(0, 10);
  const newDate = String(m.startISO).slice(0, 10);
  const pairKey = `${e.league}|${oldDate}|${[e.awayTeam || '', e.homeTeam || ''].sort().join('|')}`;
  // Titan 偶爾把已完賽的 id 直接重用到隔天同組對戰。跨日期絕不能視為改期沿用，
  // 否則昨天的完整賠率歷史會污染今天；同日則維持原本的雙重賽判定。
  if (oldDate !== newDate || (dhCount[pairKey] || 0) >= 2) {
    let archISO = e.startISO;
    const O = officialTimes && officialTimes[pairKey] ? [...officialTimes[pairKey]] : [];
    if (O.length) {
      const near = (t, o) => Math.abs(minOfHHMM(hhmmOf(t)) - minOfHHMM(o)) <= SNAP_TOL;
      const free = O.filter(o => !near(m.startISO, o));           // 扣掉新時間認領的時刻
      if (free.length === 1 && !O.some(o => near(e.startISO, o))) {
        archISO = `${oldDate}T${free[0]}:00+08:00`;
        console.log(`  🧲 [${e.league}] id:${m.id} 歸檔標籤吸附 ${hhmmOf(e.startISO)} → ${free[0]}（官方時刻）`);
      }
    }
    const archId = `${m.id}@${hhmmOf(archISO).replace(':', '')}`;
    log.matches[archId] = Object.assign({}, e, {
      id: archId, startISO: archISO, time: `${oldDate} ${hhmmOf(archISO)}`,
      titanTime: e.time, movedTo: m.startISO, archivedAt: stamp
    });
    delete log.matches[archId]._hdTs;
    e.firstSeen = stamp;
    e.ml = {}; e.hd = { bet365: null }; e.ou = { bet365: null };
    e.titanIdReusedFrom = archId;
    delete e._hdTs;
    console.log(`  ↔️ [${e.league}] id:${m.id} 開賽 ${e.startISO} → ${m.startISO}（官方雙重賽）→ 舊場歸檔 ${archId}、新場歸零`);
    return 'split';
  }
  console.log(`  🕒 [${e.league}] id:${m.id} 開賽 ${e.startISO} → ${m.startISO}（改期，沿用同一條目）`);
  return 'follow';
}

// 舊版可能已先把重用 id 的 startISO 覆蓋成新賽事，導致下一版看不出曾跨日。
// 抓取窗只有 24 小時；若 firstSeen 比目前開賽早超過 25 小時，這筆不可能是
// 在現行窗格內首次發現，視為已遭覆蓋的跨場資料並保留舊盤證據後歸零。
function handleImpossibleCarryover(log, e, m, stamp) {
  if (!e || !m || e.titanIdReusedFrom || e.startISO !== m.startISO) return null;
  const first = Date.parse(e.firstSeen);
  const start = Date.parse(m.startISO);
  if (!Number.isFinite(first) || !Number.isFinite(start)) return null;
  if (start - first <= (ACTIVE_WINDOW_HOURS + 1) * 3600e3) return null;

  const suffix = String(e.firstSeen).replace(/\D/g, '').slice(0, 12) || 'unknown';
  let archId = `${m.id}@legacy-${suffix}`;
  for (let n = 2; log.matches[archId]; n++) archId = `${m.id}@legacy-${suffix}-${n}`;
  const archived = JSON.parse(JSON.stringify(e));
  archived.originalFirstSeen = e.firstSeen;
  archived.startISO = null;
  archived.time = null;
  archived.archivedReason = 'titan-id-reuse-migration';
  archived.lastUpdated = stamp;
  delete archived._hdTs;
  log.matches[archId] = archived;

  e.firstSeen = stamp;
  e.ml = {};
  e.hd = { bet365: null };
  e.ou = { bet365: null };
  e.titanIdReusedFrom = archId;
  delete e._hdTs;
  console.log(`  🧹 [${e.league}] id:${m.id} firstSeen 早於抓取窗，判定為舊版跨場污染 → 歸檔 ${archId}、新場歸零`);
  return 'split';
}

// ---- 官方時刻表與時間吸附 --------------------------------------------------
// 為什麼：Titan007 的開賽時間會錯——小錯如白襪@藍鳥給 07:07(官方 07:15)、
// 大錯如 2026-07-18 海盜@守護者雙重賽 G1 給 04:10(官方 01:10、台彩/STAKE 都是 01:10)。
// 時間是雙重賽的唯一鍵，錯的時間會讓卡片對不到台彩盤/比分/自動結算。
// 權威源：MLB=官方 statsapi(玩運彩對 MLB 出過 04:10 幽靈場，不可信)；其他聯盟=玩運彩。
const MLB_TEAM_CN = { 108: '天使', 109: '響尾蛇', 110: '金鶯', 111: '紅襪', 112: '小熊', 113: '紅人', 114: '守護者', 115: '落磯', 116: '老虎', 117: '太空人', 118: '皇家', 119: '道奇', 120: '國民', 121: '大都會', 133: '運動家', 134: '海盜', 135: '教士', 136: '水手', 137: '巨人', 138: '紅雀', 139: '光芒', 140: '遊騎兵', 141: '藍鳥', 142: '雙城', 143: '費城人', 144: '勇士', 145: '白襪', 146: '馬林魚', 147: '洋基', 158: '釀酒人' };   // 與 pregame-integration.js TEAM_CN 同步
function pairKeyOf(lg, date, a, h) { return `${lg}|${date}|${[a, h].sort().join('|')}`; }

async function loadOfficialTimes() {
  const map = {};   // pairKey -> Set('HH:MM')
  const add = (k, t) => { (map[k] = map[k] || new Set()).add(t); };
  try {   // 玩運彩：非 MLB 聯盟
    const feed = JSON.parse(fs.readFileSync(path.join('data', 'pregame_data.json'), 'utf8'));
    for (const g of (Array.isArray(feed) ? feed : Object.values(feed))) {
      const lg = String(g.league || '').toLowerCase();
      if (lg === 'mlb') continue;
      const away = feedCanon(g.awayTeam, lg), home = feedCanon(g.homeTeam, lg);
      const t = (String(g.time || '').match(/\d{1,2}:\d{2}/) || [])[0];
      if (!away || !home || !g.date || !t) continue;
      add(pairKeyOf(lg, g.date, away, home), t.padStart(5, '0'));
    }
  } catch (_) { /* 沒有 pregame feed → 非 MLB 不吸附 */ }
  try {   // MLB 官方（台灣今明兩天 = UTC 昨天~明天）
    const d0 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const d1 = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await axios.get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${d0}&endDate=${d1}`, { headers: HEADERS, timeout: 15000 });
    const p = n => String(n).padStart(2, '0');
    for (const day of (res.data.dates || [])) for (const g of (day.games || [])) {
      const a = MLB_TEAM_CN[g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.id];
      const h = MLB_TEAM_CN[g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id];
      if (!a || !h || !g.gameDate) continue;
      const tw = new Date(Date.parse(g.gameDate) + 8 * 3600e3);
      add(pairKeyOf('mlb', `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())}`, a, h),
        `${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}`);
    }
  } catch (e) { console.log('  ⚠️ MLB 官方時刻表抓取失敗（本輪 MLB 不吸附）:', e.message); }
  return map;
}

// 吸附（純函式）：對「同聯盟同日同對戰」一組 Titan 列 vs 官方時刻們——
//  pass1：時間差 ≤SNAP_TOL 分 → 吸附成該官方時刻（官方時刻被認領）
//  pass2：對不上的列，若「恰好剩一個沒被認領的官方時刻、且恰好只有這一列對不上」→ 吸附過去
//  其餘（官方沒資料/模稜兩可）→ 保留 Titan 時間。回傳吸附筆數。
const SNAP_TOL = MOVE_MIN;   // 100 分：與搬場判定同一把尺
function hhmmOf(iso) { return String(iso).slice(11, 16); }
function minOfHHMM(t) { const m = /(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function snapUpcoming(list, officialMap, now) {
  const groups = {};
  for (const m of list) {
    const away = mapTeam(m.awayRaw, m.league), home = mapTeam(m.homeRaw, m.league);
    if (!away || !home || !m.startISO) continue;
    const k = pairKeyOf(m.league, String(m.startISO).slice(0, 10), away, home);
    (groups[k] = groups[k] || []).push(m);
  }
  let snapped = 0;
  const dropped = new Set();
  for (const [k, rows] of Object.entries(groups)) {
    const O = [...(officialMap[k] || [])].sort();
    if (!O.length) continue;
    const claimed = {}, unmatched = [];
    for (const r of rows) {
      const t = minOfHHMM(hhmmOf(r.startISO));
      let best = null, bd = Infinity;
      for (const o of O) { if (claimed[o]) continue; const d = Math.abs(minOfHHMM(o) - t); if (d < bd) { bd = d; best = o; } }
      if (best != null && bd <= SNAP_TOL) {
        claimed[best] = 1;
        if (bd > 0) { retime(r, best); snapped++; }
      } else unmatched.push(r);
    }
    const free = O.filter(o => !claimed[o]);
    if (unmatched.length === 1 && free.length === 1) { retime(unmatched[0], free[0]); snapped++; }
  }
  // 吸附改了開賽時間 → 重算抓取窗（例：吸附成已開打的場要標 started、太久以前的整場剔除）
  const graceMs = START_GRACE_MIN * 60 * 1000, limitMs = ACTIVE_WINDOW_HOURS * 3600 * 1000;
  const out = list.filter(m => {
    if (!m.titanTime) return true;                         // 沒被吸附的照舊
    const cs = captureState(Date.parse(m.startISO), now, graceMs, limitMs);
    m.started = cs.started;
    if (!cs.eligible) { console.log(`  ⏭️ [${m.league}] id:${m.id} 吸附後已離開抓取窗，本輪略過`); dropped.add(m.id); }
    return cs.eligible;
  });
  return { snapped: snapped, list: out, dropped: dropped.size };
  function retime(r, o) {
    const date = String(r.startISO).slice(0, 10);
    r.titanTime = r.time;                                  // 保留原始值供查案
    r.time = `${date} ${o}`;
    r.startISO = `${date}T${o}:00+08:00`;
    console.log(`  🧲 [${r.league}] id:${r.id} 開賽時間吸附 ${r.titanTime} → ${o}（官方時刻）`);
  }
}

// 搬場過的 id：Titan007 的 ChangeDetail 變動表【永久】帶著舊場的列（2026-07-17 實測
// id=172742 搬場後表＝新場 3 列＋舊場 4 列）。把「同 id 歸檔條目」的列從表尾剝掉，
// 否則「取較長表」規則每一輪都會把舊場汙染吃回來。對「本輪抓到的表」與「已存的表」
// 都要剝 —— 後者讓中途被汙染過的存檔也能自我修復。
function stripArchivedRows(rows, log, id, key) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const prefix = String(id) + '@';
  for (const k of Object.keys(log.matches || {})) {
    if (!k.startsWith(prefix)) continue;
    const old = log.matches[k] && log.matches[k][key] && log.matches[k][key].bet365;
    if (!Array.isArray(old) || !old.length || rows.length < old.length) continue;
    if (JSON.stringify(rows.slice(rows.length - old.length)) === JSON.stringify(old)) {
      rows = rows.slice(0, rows.length - old.length);
    }
  }
  return rows;
}

// Titan 跨場重用 id 時，1x2 端點可能仍回傳上一場的舊獨贏盤。
// 完全相同就丟棄；若即時價已變但「開盤」仍是舊值，改以本場第一個觀測值作開盤。
function stripReusedMl(ml, log, entry) {
  if (!ml || !entry || !entry.titanIdReusedFrom) return ml || {};
  const archived = log.matches && log.matches[entry.titanIdReusedFrom];
  if (!archived || !archived.ml) return ml;
  const clean = {};
  for (const [book, odds] of Object.entries(ml)) {
    const old = archived.ml[book];
    if (!old || !old.open) {
      clean[book] = odds;
      continue;
    }
    const last = old.live && old.live.length ? old.live[old.live.length - 1] : old.open;
    const sameOpen = odds.openHome === old.open.home && odds.openAway === old.open.away;
    const sameLive = odds.liveHome === last.home && odds.liveAway === last.away;
    if (sameOpen && sameLive) {
      console.log(`  🧹 id:${entry.id} ${book} 獨贏仍是歸檔舊場值，暫不匯入`);
      continue;
    }
    clean[book] = sameOpen
      ? Object.assign({}, odds, {
          openHome: odds.liveHome,
          openAway: odds.liveAway
        })
      : odds;
  }
  return clean;
}

async function run() {
  const stamp = nowTaiwanISO();
  console.log(`\n==================== ${stamp} ====================`);

  let upcoming = await fetchUpcomingMatches();
  if (upcoming === null) {
    console.log('❌ 賽程抓取失敗，本次不寫檔（保留既有資料）。');
    return;
  }
  const officialTimes = await loadOfficialTimes();
  const snap = snapUpcoming(upcoming, officialTimes, Date.now());
  upcoming = snap.list;
  for (const m of upcoming) {
    m.homeTeam = mapTeam(m.homeRaw, m.league);
    m.awayTeam = mapTeam(m.awayRaw, m.league);
  }
  if (upcoming.some(m => m.league === 'mlb')) {
    try {
      const officialBet365 = await bet365Fallback.fetchBet365Hub();
      upcoming = bet365Fallback.augmentUpcoming(upcoming, officialBet365, Date.now());
      console.log(`✅ Bet365 官方後備：${officialBet365.length} 場（目前抓取窗 ${upcoming.filter(m => m.league === 'mlb').length} 場）`);
      const missing = upcoming.filter(m => m.league === 'mlb' && !m.bet365Fixture);
      if (missing.length) {
        console.log(`⚠️ Bet365 官方目前撤盤/未列：${missing.map(m => `${m.awayTeam}@${m.homeTeam} ${String(m.startISO).slice(11, 16)}`).join('、')}`);
      }
    } catch (e) {
      console.log(`⚠️ Bet365 官方後備失敗，保留 Titan007 資料：${e.message}`);
    }
  }
  if (snap.snapped) console.log(`🧲 吸附 ${snap.snapped} 場開賽時間到官方時刻${snap.dropped ? `（${snap.dropped} 場吸附後離窗剔除）` : ''}`);
  console.log(`找到 ${upcoming.length} 場窗格內（未來 ${ACTIVE_WINDOW_HOURS} 小時）未開打賽事。`);

  const log = loadLog();
  if (!log.matches) log.matches = {};
  const unmapped = [];
  const dhCount = loadPregamePairCount();   // 雙重賽判定用（同 id 搬場時拆條目）
  // MLB 的場數以官方時刻表為準（玩運彩出過幽靈場：PIT@CLE 7/19 同時掛 0110/0410/0710 三列）
  for (const k of Object.keys(officialTimes)) if (k.slice(0, 4) === 'mlb|') dhCount[k] = officialTimes[k].size;

  for (const m of upcoming) {
    const homeTeam = m.homeTeam || mapTeam(m.homeRaw, m.league);
    const awayTeam = m.awayTeam || mapTeam(m.awayRaw, m.league);
    if (m.homeRaw && !homeTeam) unmapped.push({ raw: m.homeRaw, league: m.league, vs: m.awayRaw });
    if (m.awayRaw && !awayTeam) unmapped.push({ raw: m.awayRaw, league: m.league, vs: m.homeRaw });

    console.log(`⚾ [${m.league}] ${m.awayRaw} (客) vs ${m.homeRaw} (主) | ${m.time} | id:${m.id}`);
    const odds = m.officialFallback
      ? { ml: {}, hd: null, ou: null, hdTs: null }
      : await fetchMatchOdds(m);

    const e = log.matches[m.id] || { id: m.id, firstSeen: stamp, ml: {}, hd: { bet365: null }, ou: { bet365: null } };
    if (log.matches[m.id]) {
      const moved = handleScheduleMove(log, e, m, dhCount, stamp, officialTimes);          // 同 id 換時間：雙重賽拆場/改期跟隨
      if (!moved) handleImpossibleCarryover(log, e, m, stamp);                             // 舊版已覆蓋 startISO 的跨場污染補救
    }
    odds.ml = stripReusedMl(odds.ml, log, e);
    // 搬場過的 id：先把歸檔舊場的列從抓到的表/已存的表剝掉（見 stripArchivedRows 註解）
    if (odds.hd) {
      odds.hd = stripArchivedRows(odds.hd, log, m.id, 'hd');
      if (!odds.hd.length) {
        odds.hd = null;
        odds.hdTs = null;
      }
    }
    if (odds.ou) { odds.ou = stripArchivedRows(odds.ou, log, m.id, 'ou'); if (!odds.ou.length) odds.ou = null; }
    if (e.hd && Array.isArray(e.hd.bet365)) { const s = stripArchivedRows(e.hd.bet365, log, m.id, 'hd'); e.hd.bet365 = s.length ? s : null; }
    if (e.ou && Array.isArray(e.ou.bet365)) { const s = stripArchivedRows(e.ou.bet365, log, m.id, 'ou'); e.ou.bet365 = s.length ? s : null; }
    e.league = m.league;
    e.time = m.time;
    e.startISO = m.startISO;
    e.homeTeam = homeTeam; e.awayTeam = awayTeam;
    e.homeTeamRaw = m.homeRaw; e.awayTeamRaw = m.awayRaw;
    e.lastUpdated = stamp;
    if (!e.ml) e.ml = {};
    if (!e.hd) e.hd = { bet365: null };
    if (!e.ou) e.ou = { bet365: null };

    // 獨贏：只在【未開賽】累加，避免混入場中即時價（grace 窗補抓的已開賽場不碰 ml）
    if (!m.started) {
      if (odds.ml.bet365 && e.ml.bet365 && e.ml.bet365.source === 'bet365_official') {
        const observed = e.ml.bet365.live || [];
        e.ml.bet365 = {
          open: { home: odds.ml.bet365.openHome, away: odds.ml.bet365.openAway },
          live: observed
        };
      }
      for (const [book, o] of Object.entries(odds.ml)) {
        if (!e.ml[book]) e.ml[book] = { open: { home: o.openHome, away: o.openAway }, live: [] };
        const arr = e.ml[book].live;
        const last = arr[arr.length - 1];
        if (!last || last.home !== o.liveHome || last.away !== o.liveAway) {
          arr.push({ ts: stamp, home: o.liveHome, away: o.liveAway });
        }
      }
      const direct = m.bet365Fixture && m.bet365Fixture.ml;
      if (!odds.ml.bet365 && direct) {
        if (!e.ml.bet365) {
          e.ml.bet365 = {
            open: { home: direct.home, away: direct.away },
            live: [],
            source: 'bet365_official'
          };
        }
        const arr = e.ml.bet365.live;
        const last = arr[arr.length - 1];
        if (!last || last.home !== direct.home || last.away !== direct.away) {
          arr.push({ ts: stamp, home: direct.home, away: direct.away, src: 'bet365_official' });
        }
      }
    }
    // 讓分/大小：未開賽 + grace 窗都補抓（保留最完整那份）——這正是亞洲場臨場才貼盤的救援
    const oldHdIsOfficial = Array.isArray(e.hd.bet365) && e.hd.bet365.some(row => row && row.src === 'bet365_official');
    const oldOuIsOfficial = Array.isArray(e.ou.bet365) && e.ou.bet365.some(row => row && row.src === 'bet365_official');
    if (odds.hd && (oldHdIsOfficial || !e.hd.bet365 || odds.hd.length >= e.hd.bet365.length)) e.hd.bet365 = odds.hd;
    if (odds.ou && (oldOuIsOfficial || !e.ou.bet365 || odds.ou.length >= e.ou.bet365.length)) e.ou.bet365 = odds.ou;
    if (!odds.hd && m.bet365Fixture && m.bet365Fixture.hd) {
      const direct = m.bet365Fixture.hd;
      e.hd.bet365 = bet365Fallback.mergeOfficialRows(
        e.hd.bet365,
        { home: direct.home, line: String(direct.line), away: direct.away },
        stamp
      );
    }
    if (!odds.ou && m.bet365Fixture && m.bet365Fixture.ou) {
      const direct = m.bet365Fixture.ou;
      e.ou.bet365 = bet365Fallback.mergeOfficialRows(
        e.ou.bet365,
        { over: direct.over, line: String(direct.line), under: direct.under },
        stamp
      );
    }
    if (odds.hdTs) e._hdTs = odds.hdTs;            // 只掛在記憶體給 intl_state 用（下方 delete，不進 odds_log）

    if (!odds.hdTs && Array.isArray(e.hd.bet365)) {
      e._hdTs = bet365Fallback.officialRowsToHdTs(e.hd.bet365);
    }

    log.matches[m.id] = e;
    await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
  }

  // ---- 國際軸標示器衍生檔 data/intl_state.json（bet365 vs 台彩開盤；失敗不影響主爬蟲）----
  try { buildIntlState(log, stamp); } catch (e) { console.log('⚠️ intl_state 產出失敗（不影響 odds_log）：', e.message); }
  for (const k of Object.keys(log.matches)) delete log.matches[k]._hdTs;   // 確保不寫進 odds_log

  log.lastUpdated = stamp;
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(log, null, 2));
  console.log(`✅ 已寫入 ${OUTPUT_FILE}（累積 ${Object.keys(log.matches).length} 場）`);

  if (unmapped.length) {
    const seenU = new Set();
    console.log(`\n⚠️  以下隊名對不上排盤板縮寫，請整段貼給我補進對照表：`);
    unmapped.forEach(u => {
      const k = u.league + '|' + u.raw;
      if (seenU.has(k)) return; seenU.add(k);
      console.log(`     [${u.league}] ${u.raw}   (對手: ${u.vs || '?'})`);
    });
  }
  console.log(`==================================================\n`);
}

// ============================================================================
// 國際軸標示器：把 bet365(讓分方向序列) × 台彩(玩運彩 feed 開盤方向) 濃縮成小檔給板上讀。
// 語義誠實聲明：台彩側=pregame feed 的 lotteryHandicap＝「開盤快照」(2026-07-11 實證從不更新)，
// 故 verdict 是「bet365 現況 vs 台彩開盤」的提示；嚴謹收盤對收盤版由 titan_pilot 管線離線產。
// verdict: flip=現在相反(橙) / was=曾相反現同向(靛) / swap=只換過邊(青綠) / null=無異常(板上不顯示)
// ============================================================================
const INTL_FILE = path.join('data', 'intl_state.json');

function feedCanon(name, league) {
  if (!name) return null;
  const direct = mapTeam(name, league);
  if (direct) return direct;
  const pairs = LEAGUE_PAIRS[league] || [];             // 反向包含：feed 短名(雙子)⊂別名(LG雙子)
  for (const [alias, canon] of pairs) if (name.length >= 2 && alias.includes(name)) return canon;
  return null;
}

// 還原一筆條目的「國際盤方向序列」。
// 優先 iseq（含 epoch → 可做雙序列交叉比對）；舊條目沒有 iseq，退回解析已存的 tr 字串。
// 為何反推出來的 t 一律留 null：tr 只存 HH:MM 沒有月日，而 bet365 常在賽前一天就貼線，
// 硬套比賽日期會差一天 → 寧可缺時間（交叉偵測不觸發＝保守，退回單邊比對）也不要造假時間（會誤判「曾相反」）。
function seqOf(e, awayTeam, homeTeam) {
  if (e.iseq && e.iseq.length) return e.iseq.map(s => ({ dir: s.d, t: s.t }));
  const single = () => (e.is ? [{ dir: e.is, t: null }] : []);
  if (!e.tr) return single();
  const out = [];
  for (const tok of String(e.tr).split(' → ')) {
    const m = tok.match(/^(\d{2}:\d{2})\s+(.*)$/);
    const nm = m ? m[2] : tok;
    const dir = nm === homeTeam ? 'home' : (nm === awayTeam ? 'away' : null);
    if (!dir) return single();                               // 隊名對不上（改名等）→ 不硬猜
    out.push({ dir, t: null });
  }
  return out.length ? out : single();
}

// 「兩側曾經相反過」是單向閂鎖：曾為真就永遠為真，不該因為之後用較差的資料重算而消失。
// 舊條目沒存 eo → 從當時的 verdict 反推（was＝偵測到曾相反；flip＝當下就相反，自然也曾相反）。
// 沒有這個閂鎖，補算 pass 會把 8 場裡的 7 場從 was 打成 swap（實測），修一場壞七場。
function eoOf(e) { return !!(e && (e.eo != null ? e.eo : (e.v === 'was' || e.v === 'flip'))); }

// 依「當下」的台彩序列，重算一筆 intl_state 條目的台彩側欄位（ls/ll/lsLive/lsw/ltr）與 verdict。
// 設計成純函式＋可重入：新條目建立時呼叫一次，之後每輪對所有既有條目再呼叫一次（見 buildIntlState 補算 pass）。
// e 需已有 is（國際盤最終側）；iseq/tr 擇一提供方向序列；key 提供隊名。
function applyLot(e, key, serMap, lotMap) {
  const parts = key.split('|');
  const awayTeam = parts[2], homeTeam = parts[3];
  const sideName = d => (d === 'home' ? homeTeam : awayTeam);
  const twHM = t => { const d = new Date((t + 8 * 3600) * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
  const seq = seqOf(e, awayTeam, homeTeam);
  const intlSide = e.is;
  // 台彩：序列優先（現況＋軌跡＋換邊數），feed 後備（單點）
  const pts = serMap[key] || null;
  const lotSeq = [];
  if (pts) for (const p of pts) {
    const last = lotSeq[lotSeq.length - 1];
    if (!last || last.dir !== p.side) lotSeq.push({ dir: p.side, t: Date.parse(p.t) / 1000 || null, line: p.line });
  }
  const lot = lotSeq.length ? { side: lotSeq[lotSeq.length - 1].dir, line: pts[pts.length - 1].line, live: true }
            : (lotMap[key] ? { side: lotMap[key].side, line: lotMap[key].line, live: false } : null);
  let verdict = null, everOpp = eoOf(e);                       // 閂鎖：帶著既有事實進來，只會加不會減
  if (lot && intlSide) {
    if (!everOpp) {                                            // 已latch住就不必再偵測
      if (lotSeq.length) {
        // 雙序列交叉：合併事件時間軸，任一區間兩側同時有值且相反 → 曾相反
        const evts = [...seq.map(s => s.t), ...lotSeq.map(s => s.t)].filter(t => t != null).sort((a, b) => a - b);
        const at = (sq, t) => { let c = null; for (const s of sq) { if (s.t != null && s.t <= t) c = s.dir; else if (s.t != null) break; } return c; };
        for (const t of evts) { const a = at(seq, t), b2 = at(lotSeq, t); if (a && b2 && a !== b2) { everOpp = true; break; } }
        if (!everOpp) everOpp = seq.some(s => s.dir !== lot.side) && lotSeq.length === 1;   // 台彩無變動時退回單邊比對
      } else {
        everOpp = seq.some(s => s.dir !== lot.side);            // feed 後備：只能對台彩單點比
      }
    }
    if (intlSide !== lot.side) { verdict = 'flip'; everOpp = true; }   // 現在就相反 → 當然「曾」相反
    else if (everOpp) verdict = 'was';
    else if (seq.length > 1 || lotSeq.length > 1) verdict = 'swap';
  } else if (seq.length > 1) verdict = 'swap';
  e.eo = everOpp;
  e.ls = lot ? lot.side : null;
  e.ll = lot ? lot.line : null;
  e.lsLive = !!(lot && lot.live);
  e.lsw = Math.max(0, lotSeq.length - 1);
  e.ltr = lotSeq.length > 1 ? lotSeq.map(s => (s.t ? twHM(s.t) + ' ' : '') + sideName(s.dir)).join(' → ') : null;
  e.v = verdict;
}

const LOT_TIME_TOL_MIN = 15;
function clockMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function alignTimedSources(map, base, starts, toleranceMin = LOT_TIME_TOL_MIN) {
  const prefix = base + '|';
  const targets = [...starts];
  const sources = Object.keys(map)
    .filter(k => k.startsWith(prefix) && /^\d{2}:\d{2}$/.test(k.slice(prefix.length)))
    .map(k => ({ key: k, time: k.slice(prefix.length), mins: clockMinutes(k.slice(prefix.length)) }));
  const pairs = [];
  for (const target of targets) {
    const targetMins = clockMinutes(target);
    if (targetMins == null) continue;
    for (const source of sources) {
      if (source.mins == null) continue;
      const raw = Math.abs(targetMins - source.mins);
      const distance = Math.min(raw, 1440 - raw);
      if (distance <= toleranceMin) pairs.push({ target, source, distance });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || a.target.localeCompare(b.target));
  const usedTargets = new Set(), usedSources = new Set();
  for (const pair of pairs) {
    if (usedTargets.has(pair.target) || usedSources.has(pair.source.key)) continue;
    map[`${base}|${pair.target}`] = map[pair.source.key];
    usedTargets.add(pair.target);
    usedSources.add(pair.source.key);
  }
}

function buildIntlState(log, stamp) {
  // 台彩側來源鏈：①lottery_series.json（盤中序列，2026-07-12 根治後的權威）②pregame feed 最新值（後備）
  let lotMap = {};
  const feed = readJsonRequired(
    path.join('data', 'pregame_data.json'),
    Array.isArray,
    'data/pregame_data.json'
  );
  for (const g of feed) {
    const lh = g.lotteryHandicap;
    if (!lh || lh.src !== '運彩' || !lh.favSide) continue;
    const lg = String(g.league || '').toLowerCase();
    const away = feedCanon(g.awayTeam, lg), home = feedCanon(g.homeTeam, lg);
    if (!away || !home) continue;
    const base = `${lg}|${g.date}|${away}|${home}`;
    const value = { side: lh.favSide, line: lh.line != null ? lh.line : null };
    lotMap[base] = value;
    const time = (String(g.time || '').match(/\d{1,2}:\d{2}/) || [])[0];
    if (time) lotMap[`${base}|${time.padStart(5, '0')}`] = value;
  }
  let serMap = {};
  const seriesPath = fs.existsSync(path.join('data', 'lottery_series.json')) ? path.join('data', 'lottery_series.json') : 'lottery_series.json';
  const ser = readJsonRequired(
    seriesPath,
    (value) => value && typeof value === 'object' && value.games && typeof value.games === 'object',
    'lottery_series.json'
  );
  for (const oid of Object.keys(ser.games)) {
    const g = ser.games[oid];
    const lg = String(g.league || '').toLowerCase();
    const away = feedCanon(g.awayTeam, lg), home = feedCanon(g.homeTeam, lg);
    if (!away || !home || !g.pts || !g.pts.length) continue;
    const base = `${lg}|${g.date}|${away}|${home}`;
    serMap[base] = g.pts;
    const directTime = (String(g.time || '').match(/\d{1,2}:\d{2}/) || [])[0];
    const idTime = String(oid).match(/_(\d{2})(\d{2})$/);
    const time = directTime ? directTime.padStart(5, '0') : (idTime ? `${idTime[1]}:${idTime[2]}` : null);
    if (time) serMap[`${base}|${time}`] = g.pts;
  }

  // intl_state 含 eo 閂鎖、方向序列與已離開抓取窗的歷史，無法從單輪資料完整重建。
  // 壞檔必須 fail-closed：保留磁碟上的原檔並讓工作流失敗，禁止用空表覆寫。
  const prev = readJsonRequired(
    INTL_FILE,
    (value) => value && typeof value === 'object' && value.games && typeof value.games === 'object',
    INTL_FILE
  );
  const games = prev.games || {};
  const startsByBase = {};
  for (const e of Object.values(log.matches)) {
    if (!e || !e.awayTeam || !e.homeTeam || !e.startISO) continue;
    const base = `${e.league}|${e.startISO.slice(0, 10)}|${e.awayTeam}|${e.homeTeam}`;
    (startsByBase[base] = startsByBase[base] || new Set()).add(e.startISO.slice(11, 16));
  }
  // 雙重賽來源常因官方改時或四捨五入差幾分鐘。以一對一最近時間吸附，
  // 同一台彩場次不可同時餵給兩場；超過 15 分鐘則寧可不配對，避免串場。
  for (const [base, starts] of Object.entries(startsByBase)) {
    if (starts.size < 2) continue;
    alignTimedSources(lotMap, base, starts);
    alignTimedSources(serMap, base, starts);
  }
  const legacyByBase = {};
  for (const [base, starts] of Object.entries(startsByBase)) {
    if (starts.size < 2) continue;
    legacyByBase[base] = games[base] || null;
    delete games[base];
  }
  // Titan 會跨日期重用賽事 ID。若該新賽事目前沒有任何讓分證據，
  // 不可保留先前用同一 ID 寫入的時間鍵，否則板面會顯示成仍有 Bet365 方向。
  for (const e of Object.values(log.matches)) {
    const hasCurrentHd = Array.isArray(e && e.hd && e.hd.bet365) && e.hd.bet365.length;
    if (!e || !e.titanIdReusedFrom || hasCurrentHd) continue;
    if (!e.awayTeam || !e.homeTeam || !e.startISO) continue;
    const base = `${e.league}|${e.startISO.slice(0, 10)}|${e.awayTeam}|${e.homeTeam}`;
    const key = startsByBase[base] && startsByBase[base].size >= 2
      ? `${base}|${e.startISO.slice(11, 16)}`
      : base;
    delete games[key];
    delete e._hdTs;
  }

  for (const id of Object.keys(log.matches)) {
    const e = log.matches[id];
    if (!e._hdTs || !e.awayTeam || !e.homeTeam || !e.startISO) continue;
    const date = e.startISO.slice(0, 10);
    const year = date.slice(0, 4);
    const baseKey = `${e.league}|${date}|${e.awayTeam}|${e.homeTeam}`;
    const key = startsByBase[baseKey] && startsByBase[baseKey].size >= 2
      ? `${baseKey}|${e.startISO.slice(11, 16)}`
      : baseKey;
    const pre = e._hdTs.filter(r => !r.live && r.line != null && r.line !== 0);
    if (!pre.length) continue;
    const sideName = d => d === 'home' ? e.homeTeam : e.awayTeam;
    // bet365 方向序列（正=主讓/負=客讓）＋epoch（md+hhmm → +08:00）
    const seq = [];
    for (const r of pre) {
      const dir = r.line > 0 ? 'home' : 'away';
      let t = null;
      if (r.md && r.hhmm) { const [mo, dy] = r.md.split('-'); t = Date.parse(`${year}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}T${r.hhmm}:00+08:00`) / 1000 || null; }
      const last = seq[seq.length - 1];
      if (!last || last.dir !== dir) seq.push({ dir, hhmm: r.hhmm, t });
    }
    const cur = pre[pre.length - 1];
    const intlSide = cur.line > 0 ? 'home' : 'away';
    // 獨贏（bet365 decimal）判國際盤內背離
    let mlFav = null, dv = null;
    const b = e.ml && e.ml.bet365;
    const lastMl = b && b.live && b.live.length ? b.live[b.live.length - 1] : (b && b.open ? b.open : null);
    if (lastMl && lastMl.home != null && lastMl.away != null && Math.abs(lastMl.home - lastMl.away) >= 0.10) {
      mlFav = lastMl.home < lastMl.away ? 'home' : 'away';
      dv = mlFav !== intlSide;
    }
    const prevEo = eoOf(games[key] || legacyByBase[baseKey]); // 舊版無時間鍵只作遷移後備
    games[key] = {
      is: intlSide, il: Math.abs(cur.line), sw: Math.max(0, seq.length - 1),
      tr: seq.map(s => (s.hhmm ? s.hhmm + ' ' : '') + sideName(s.dir)).join(' → '),
      iseq: seq.map(s => ({ d: s.dir, t: s.t })),          // 機器可讀的國際盤方向序列 → 供離開抓取窗後補算台彩側
      ls: null, ll: null, lsLive: false, lsw: 0, ltr: null,
      mf: mlFav, dv, eo: prevEo, v: null, u: stamp
    };
    applyLot(games[key], key, serMap, lotMap);              // 台彩側 + verdict
  }

  // ── 台彩先行條目（2026-07-29 韓中職提示條消失案）：Bet365 亞洲盤常晚貼（7/4 已知行為），
  // 原本「無 bet365 讓分＝不建條目」把台彩顯示一起綁死 → 台彩明明 12:xx 就開盤、板上整條看不到。
  // 台彩有側就先建 is=null 條目（帶子顯示「bet365 未開盤＋台彩 X讓N」）；
  // Bet365 開盤後主迴圈用同 key 覆寫成完整條目。is=null 條目每輪在此重算台彩側（補算 pass 只管有 is 的）。
  for (const e of Object.values(log.matches)) {
    if (!e || !e.awayTeam || !e.homeTeam || !e.startISO) continue;
    const baseKey = `${e.league}|${e.startISO.slice(0, 10)}|${e.awayTeam}|${e.homeTeam}`;
    const key = startsByBase[baseKey] && startsByBase[baseKey].size >= 2
      ? `${baseKey}|${e.startISO.slice(11, 16)}`
      : baseKey;
    const cur0 = games[key];
    if (cur0 && cur0.is) continue;
    if (!serMap[key] && !lotMap[key]) {
      // 兩個來源檔都已成功解析，但本輪都沒有這場＝台彩已撤盤/移除。
      // 連續兩輪才清 Taiwan-only stub，避免單輪局部抓漏讓提示條閃退；
      // 有 Bet365 歷史的完整條目交給下方補算 pass 清台彩欄位。
      if (cur0 && !cur0.is) {
        cur0.lmiss = (Number(cur0.lmiss) || 0) + 1;
        if (cur0.lmiss >= 2) delete games[key];
      }
      continue;
    }
    const stub = cur0 || { is: null, il: null, sw: 0, tr: null, iseq: [],
      ls: null, ll: null, lsLive: false, lsw: 0, ltr: null,
      mf: null, dv: null, eo: null, v: null, u: stamp };
    applyLot(stub, key, serMap, lotMap);
    if (stub.ls) { delete stub.lmiss; stub.u = stamp; games[key] = stub; }
  }

  // ── 補算 pass：對「所有」既有條目重算台彩側。
  // 為什麼必要：台彩序列由另一支爬蟲寫入，常在本爬蟲的抓取窗關閉後才補上晚段換邊
  // （實例 2026-07-14 富邦@台鋼：本檔 16:25 凍結時序列只有 1 點，16:33/16:52 兩次換邊
  //  永遠沒被寫進去 → 板上顯示「無變動」＝紀錄看似消失）。序列是持久的，故每輪重算。
  // 不能用「有沒有 iseq」當守門：已凍結的舊條目永遠不會再進窗補上 iseq，而它們正是要救的對象
  // → seqOf() 會從 tr 反推方向序列，只要有 is 就能重算。
  for (const key of Object.keys(games)) {
    const e = games[key];
    if (!e || !e.is) continue;
    const before = e.lsw + '|' + e.v + '|' + e.ls;
    applyLot(e, key, serMap, lotMap);
    if (before !== e.lsw + '|' + e.v + '|' + e.ls) e.u = stamp;
  }
  // 修剪：只留最近 3 天（板上只看今天；留兩天緩衝跨日結算）
  const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  // 2026-08-05 使用者拍板：滾動窗剪掉前先歸檔月檔（data/intl_archive/YYYY-MM.json）——
  // 歷史卡片的 bet365/台彩警示條不再隨窗滾動消失；剪下的=該場最終狀態，同鍵直接覆蓋。
  const pruned = {};
  for (const k of Object.keys(games)) { const d = k.split('|')[1]; if (d && d < cutoff) { pruned[k] = games[k]; delete games[k]; } }
  try {
    const byMonth = {};
    for (const [k, v] of Object.entries(pruned)) {
      const d = k.split('|')[1] || '';
      if (!/^\d{4}-\d{2}/.test(d)) continue;
      (byMonth[d.slice(0, 7)] = byMonth[d.slice(0, 7)] || {})[k] = v;
    }
    for (const [month, adds] of Object.entries(byMonth)) {
      const dir = path.join('data', 'intl_archive');
      const file = path.join(dir, month + '.json');
      let arch = { version: 1, games: {} };
      try { arch = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      if (!arch.games) arch.games = {};
      Object.assign(arch.games, adds);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(arch, null, 2));
      console.log(`🗄️ intl 歸檔 ${month}：+${Object.keys(adds).length} 場`);
    }
  } catch (e) { console.log('⚠️ intl 歸檔失敗（不影響主檔）：', e.message); }
  fs.writeFileSync(INTL_FILE, JSON.stringify({ updated: stamp, games }));
  console.log(`🌐 intl_state：${Object.keys(games).length} 場（台彩側對上 ${Object.values(games).filter(g => g.ls).length}）`);
}

if (require.main === module) {
  run()
    .catch(e => { console.error('未預期錯誤：', e); process.exitCode = 1; })
    .finally(() => bet365Fallback.shutdown());
}

module.exports = { mapTeam, feedCanon, applyLot, buildIntlState, parseHistoryTable, parseTaiwan, captureState, scheduleURLsForLeague, nowTaiwanISO, LEAGUES_CFG, LEAGUE_TEAMS, START_GRACE_MIN, ACTIVE_WINDOW_HOURS, scheduleMove, handleScheduleMove, handleImpossibleCarryover, loadLog, loadPregamePairCount, MOVE_MIN, stripArchivedRows, stripReusedMl, snapUpcoming, loadOfficialTimes, pairKeyOf, SNAP_TOL, MLB_TEAM_CN };
