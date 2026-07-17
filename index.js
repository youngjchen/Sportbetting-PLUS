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
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch (_) {
    return { lastUpdated: null, matches: {} };
  }
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
// 回傳：'split' / 'follow' / null（沒有搬場）。
function handleScheduleMove(log, e, m, dhCount, stamp) {
  if (!e || !e.startISO || !m.startISO || !scheduleMove(e.startISO, m.startISO)) return null;
  const oldDate = String(e.startISO).slice(0, 10);
  const pairKey = `${e.league}|${oldDate}|${[e.awayTeam || '', e.homeTeam || ''].sort().join('|')}`;
  if ((dhCount[pairKey] || 0) >= 2) {
    const hhmm = String(e.startISO).slice(11, 16).replace(':', '');
    const archId = `${m.id}@${hhmm}`;
    log.matches[archId] = Object.assign({}, e, { id: archId, movedTo: m.startISO, archivedAt: stamp });
    delete log.matches[archId]._hdTs;
    e.firstSeen = stamp;
    e.ml = {}; e.hd = { bet365: null }; e.ou = { bet365: null };
    delete e._hdTs;
    console.log(`  ↔️ [${e.league}] id:${m.id} 開賽 ${e.startISO} → ${m.startISO}（官方雙重賽）→ 舊場歸檔 ${archId}、新場歸零`);
    return 'split';
  }
  console.log(`  🕒 [${e.league}] id:${m.id} 開賽 ${e.startISO} → ${m.startISO}（改期，沿用同一條目）`);
  return 'follow';
}

async function run() {
  const stamp = nowTaiwanISO();
  console.log(`\n==================== ${stamp} ====================`);

  const upcoming = await fetchUpcomingMatches();
  if (upcoming === null) {
    console.log('❌ 賽程抓取失敗，本次不寫檔（保留既有資料）。');
    return;
  }
  console.log(`找到 ${upcoming.length} 場窗格內（未來 ${ACTIVE_WINDOW_HOURS} 小時）未開打賽事。`);

  const log = loadLog();
  if (!log.matches) log.matches = {};
  const unmapped = [];
  const dhCount = loadPregamePairCount();   // 雙重賽判定用（同 id 搬場時拆條目）

  for (const m of upcoming) {
    const homeTeam = mapTeam(m.homeRaw, m.league);
    const awayTeam = mapTeam(m.awayRaw, m.league);
    if (m.homeRaw && !homeTeam) unmapped.push({ raw: m.homeRaw, league: m.league, vs: m.awayRaw });
    if (m.awayRaw && !awayTeam) unmapped.push({ raw: m.awayRaw, league: m.league, vs: m.homeRaw });

    console.log(`⚾ [${m.league}] ${m.awayRaw} (客) vs ${m.homeRaw} (主) | ${m.time} | id:${m.id}`);
    const odds = await fetchMatchOdds(m);

    const e = log.matches[m.id] || { id: m.id, firstSeen: stamp, ml: {}, hd: { bet365: null }, ou: { bet365: null } };
    if (log.matches[m.id]) handleScheduleMove(log, e, m, dhCount, stamp);   // 同 id 換時間：雙重賽拆場/改期跟隨
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
      for (const [book, o] of Object.entries(odds.ml)) {
        if (!e.ml[book]) e.ml[book] = { open: { home: o.openHome, away: o.openAway }, live: [] };
        const arr = e.ml[book].live;
        const last = arr[arr.length - 1];
        if (!last || last.home !== o.liveHome || last.away !== o.liveAway) {
          arr.push({ ts: stamp, home: o.liveHome, away: o.liveAway });
        }
      }
    }
    // 讓分/大小：未開賽 + grace 窗都補抓（保留最完整那份）——這正是亞洲場臨場才貼盤的救援
    if (odds.hd && (!e.hd.bet365 || odds.hd.length >= e.hd.bet365.length)) e.hd.bet365 = odds.hd;
    if (odds.ou && (!e.ou.bet365 || odds.ou.length >= e.ou.bet365.length)) e.ou.bet365 = odds.ou;
    if (odds.hdTs) e._hdTs = odds.hdTs;            // 只掛在記憶體給 intl_state 用（下方 delete，不進 odds_log）

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

function buildIntlState(log, stamp) {
  // 台彩側來源鏈：①lottery_series.json（盤中序列，2026-07-12 根治後的權威）②pregame feed 最新值（後備）
  let lotMap = {};
  try {
    const feed = JSON.parse(fs.readFileSync(path.join('data', 'pregame_data.json'), 'utf8'));
    const list = Array.isArray(feed) ? feed : Object.values(feed);
    for (const g of list) {
      const lh = g.lotteryHandicap;
      if (!lh || lh.src !== '運彩' || !lh.favSide) continue;
      const lg = String(g.league || '').toLowerCase();
      const away = feedCanon(g.awayTeam, lg), home = feedCanon(g.homeTeam, lg);
      if (!away || !home) continue;
      lotMap[`${lg}|${g.date}|${away}|${home}`] = { side: lh.favSide, line: lh.line != null ? lh.line : null };
    }
  } catch (e) { console.log('  ⚠️ intl_state：讀不到 pregame feed（' + e.message + '）'); }
  let serMap = {};
  try {
    const ser = JSON.parse(fs.readFileSync(fs.existsSync(path.join('data', 'lottery_series.json')) ? path.join('data', 'lottery_series.json') : 'lottery_series.json', 'utf8'));
    for (const oid of Object.keys(ser.games || {})) {
      const g = ser.games[oid];
      const lg = String(g.league || '').toLowerCase();
      const away = feedCanon(g.awayTeam, lg), home = feedCanon(g.homeTeam, lg);
      if (!away || !home || !g.pts || !g.pts.length) continue;
      serMap[`${lg}|${g.date}|${away}|${home}`] = g.pts;
    }
  } catch (e) { /* 序列檔尚未存在（部署初期）→ 全走 feed 後備 */ }

  let prev = { games: {} };
  try { prev = JSON.parse(fs.readFileSync(INTL_FILE, 'utf8')); } catch (e) {}
  const games = prev.games || {};

  for (const id of Object.keys(log.matches)) {
    const e = log.matches[id];
    if (!e._hdTs || !e.awayTeam || !e.homeTeam || !e.startISO) continue;
    const date = e.startISO.slice(0, 10);
    const year = date.slice(0, 4);
    const key = `${e.league}|${date}|${e.awayTeam}|${e.homeTeam}`;
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
    const prevEo = eoOf(games[key]);                        // 覆蓋前先接住閂鎖（台彩序列會被修剪，證據可能已不在）
    games[key] = {
      is: intlSide, il: Math.abs(cur.line), sw: Math.max(0, seq.length - 1),
      tr: seq.map(s => (s.hhmm ? s.hhmm + ' ' : '') + sideName(s.dir)).join(' → '),
      iseq: seq.map(s => ({ d: s.dir, t: s.t })),          // 機器可讀的國際盤方向序列 → 供離開抓取窗後補算台彩側
      ls: null, ll: null, lsLive: false, lsw: 0, ltr: null,
      mf: mlFav, dv, eo: prevEo, v: null, u: stamp
    };
    applyLot(games[key], key, serMap, lotMap);              // 台彩側 + verdict
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
  for (const k of Object.keys(games)) { const d = k.split('|')[1]; if (d && d < cutoff) delete games[k]; }
  fs.writeFileSync(INTL_FILE, JSON.stringify({ updated: stamp, games }));
  console.log(`🌐 intl_state：${Object.keys(games).length} 場（台彩側對上 ${Object.values(games).filter(g => g.ls).length}）`);
}

if (require.main === module) {
  run().catch(e => { console.error('未預期錯誤：', e); process.exit(1); });
}

module.exports = { mapTeam, feedCanon, applyLot, parseHistoryTable, parseTaiwan, captureState, scheduleURLsForLeague, nowTaiwanISO, LEAGUES_CFG, LEAGUE_TEAMS, START_GRACE_MIN, ACTIVE_WINDOW_HOURS, scheduleMove, handleScheduleMove, loadPregamePairCount, MOVE_MIN };
