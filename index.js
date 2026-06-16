// ============================================================================
//  Titan007 棒球賠率抓取（雲端版・跑一次就結束，節奏交給 GitHub Actions cron）
//  支援聯盟：MLB(1) / 日職 NPB(2) / 韓職 KBO(17) / 中職 CPBL(5)
//  - 三市場：獨贏(12BET/Bet365/Bwin) / 讓分(Bet365) / 大小分(Bet365)
//  - 讓分與大小分：完整保留整張變動表（每一列＝一次盤口移動）
//  - 獨贏：來源無歷史，只有初盤＋當前，故以「價有變才追加」自己縫軌跡
//  - 每場標上 league，排盤板可直接判聯盟（隊名沒對上時也認得出是哪一聯盟）
//  - 輸出累積到 data/odds_log.json（讀進舊檔→合併→寫回，永不刪舊場次）
// ============================================================================

const axios = require('axios');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// ---- 可調參數 ---------------------------------------------------------------
// 只抓「未來這麼多小時內開打」的比賽。離開賽還很遠的盤幾乎不動，抓了也是雜訊。
// 24＝提前一天開始記，涵蓋隔天整批賽事；重複資料會自動以價去重，不會爆量。
const ACTIVE_WINDOW_HOURS = 24;

const OUTPUT_FILE = path.join('data', 'odds_log.json');
const REQUEST_GAP_MS = 900;   // 每場之間稍微間隔，對來源客氣一點

// 各聯盟在 Titan007 賽程檔的代號（matchResult/<年>/l<id>_1_<年>_<月>.js）
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

// 獨贏盤：1x2 feed 裡 cols[16] 公司名，用子字串認三家
const ML_BOOKS = [
  { id: '12bet',  kw: '12'  },
  { id: 'bet365', kw: '36'  },
  { id: 'bwin',   kw: 'bwi' }
];

// ---- 隊名對照：Titan007（簡繁混用、部分舊名）→ 排盤板繁中縮寫 ----------------
// 用「別名子字串」比對。MLB 已實測穩定；日/韓/中先放標準名＋常見簡體全名，
// 跨聯盟易撞的短名（巨人、樂天…）刻意不放，避免誤判。Titan007 實際用什麼名，
// 第一次跑完看 log 的「未對應」清單（已附聯盟＋對手），整段貼給我就鎖定。
const TEAM_ALIASES = {
  // ---------- MLB（你已實測，原樣保留） ----------
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
  '巨人':   ['巨人'],     // MLB 舊金山巨人；NPB/KBO 的「巨人」用全名比對，不撞這個

  // ---------- 日職 NPB（標準名＋常見簡體全名；撞名短名不放） ----------
  '讀賣巨人':   ['讀賣巨人', '读卖巨人', '讀賣', '读卖'],
  '阪神虎':     ['阪神虎', '阪神'],
  '橫濱DeNA':   ['橫濱DeNA', '横滨DeNA', 'DeNA', '橫濱', '横滨'],
  '廣島鯉魚':   ['廣島鯉魚', '广岛鲤鱼', '廣島', '广岛'],
  '養樂多燕子': ['養樂多燕子', '养乐多燕子', '養樂多', '养乐多', '燕子'],
  '中日龍':     ['中日龍', '中日龙', '中日'],
  '軟銀鷹':     ['軟銀鷹', '软银鹰', '軟銀', '软银'],
  '日本火腿':   ['日本火腿', '火腿'],
  '羅德':       ['羅德', '罗德'],
  '樂天金鷲':   ['樂天金鷲', '乐天金鹫', '金鷲', '金鹫'],
  '西武獅':     ['西武獅', '西武狮', '西武'],
  '歐力士':     ['歐力士', '欧力士'],

  // ---------- 韓職 KBO ----------
  'LG雙子':     ['LG雙子', 'LG双子'],
  'KT巫師':     ['KT巫師', 'KT巫师'],
  'SSG登陸者':  ['SSG登陸者', 'SSG登陆者', 'SSG'],
  'NC恐龍':     ['NC恐龍', 'NC恐龙'],
  '斗山熊':     ['斗山熊', '斗山'],
  '起亞虎':     ['起亞虎', '起亚虎', '起亞', '起亚'],
  '樂天巨人':   ['樂天巨人', '乐天巨人'],
  '三星獅':     ['三星獅', '三星狮', '三星'],
  '韓華鷹':     ['韓華鷹', '韩华鹰', '韓華', '韩华'],
  '培證英雄':   ['培證英雄', '培证英雄', '英雄'],

  // ---------- 中職 CPBL ----------
  '中信兄弟':   ['中信兄弟', '兄弟'],
  '統一獅':     ['統一獅', '统一狮', '統一', '统一'],
  '樂天桃猿':   ['樂天桃猿', '乐天桃猿', '桃猿'],
  '富邦悍將':   ['富邦悍將', '富邦悍将', '富邦', '悍將', '悍将'],
  '味全龍':     ['味全龍', '味全龙', '味全'],
  '台鋼雄鷹':   ['台鋼雄鷹', '台钢雄鹰', '台鋼', '台钢']
};
// 把別名展平成 [別名, 標準名]，長別名優先比對，避免短字串誤判
const ALIAS_PAIRS = [];
for (const [canon, aliases] of Object.entries(TEAM_ALIASES)) {
  for (const a of aliases) ALIAS_PAIRS.push([a, canon]);
}
ALIAS_PAIRS.sort((x, y) => y[0].length - x[0].length);

function mapTeam(rawName) {
  if (!rawName) return null;
  for (const [alias, canon] of ALIAS_PAIRS) {
    if (rawName.includes(alias)) return canon;
  }
  return null; // 對不上 → 由呼叫端記錄
}

// ---- 時間工具（雲端在 UTC，這裡全部明確處理成台灣時間）---------------------
function nowTaiwanISO() {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())}T` +
         `${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}:${p(tw.getUTCSeconds())}+08:00`;
}

// Titan007 時間字串（台灣時間、無時區標記，如 "2026-06-16 06:40"）→ Date / ISO
function parseTaiwan(s) {
  const [d, tRaw] = String(s).trim().split(/\s+/);
  const t = (tRaw && tRaw.split(':').length === 2) ? `${tRaw}:00` : (tRaw || '00:00:00');
  const iso = `${d}T${t}+08:00`;
  return { date: new Date(iso), iso };
}

// 某聯盟、依「現在 ~ 現在+窗格」可能跨到的月份，組出 1~2 個賽程檔網址（處理月底/年底跨界）
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

// ---- 解析 ChangeDetail 的 odds2 表格：回傳「全部列」（rows[0]=最新, rows[末]=初盤）--
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

// ---- 抓單場三市場 -----------------------------------------------------------
async function fetchMatchOdds(match) {
  const out = { ml: {}, hd: null, ou: null };

  // 1) 獨贏（無歷史，取初盤＋當前）
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

  // 2) 讓分（Bet365, companyid=8）— 完整變動表
  try {
    const res = await axios.get(`${HANDICAP_URL}?id=${match.id}&companyid=8&t=2`, { headers: HEADERS, timeout: 15000 });
    const rows = parseHistoryTable(res.data);
    if (rows) out.hd = rows.map(x => ({ home: toNum(x.a), line: x.line, away: toNum(x.b) }));
  } catch (e) { console.log(`  ❌ 讓分: ${e.message}`); }

  // 3) 大小分（Bet365, companyid=8）— 完整變動表
  try {
    const res = await axios.get(`${OVERUNDER_URL}?id=${match.id}&companyid=8&t=2`, { headers: HEADERS, timeout: 15000 });
    const rows = parseHistoryTable(res.data);
    if (rows) out.ou = rows.map(x => ({ over: toNum(x.a), line: x.line, under: toNum(x.b) }));
  } catch (e) { console.log(`  ❌ 大小: ${e.message}`); }

  return out;
}

// ---- 賽程：逐聯盟抓 1~2 個月檔，篩出窗格內未開打的場次，每場標上 league ----------
async function fetchUpcomingMatches() {
  const now = Date.now();
  const limit = now + ACTIVE_WINDOW_HOURS * 3600 * 1000;
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
    let cnt = 0;
    for (const m of data) {
      if (seen.has(m[0])) continue;
      const { date, iso } = parseTaiwan(m[2]);
      const ts = date.getTime();
      if (!(ts > now && ts < limit)) continue;   // 未開打 且 在窗格內
      seen.add(m[0]);
      list.push({
        id: m[0], league: lg.key, time: m[2], startISO: iso,
        homeRaw: teamDict[m[3]] || null, awayRaw: teamDict[m[4]] || null
      });
      cnt++;
    }
    console.log(`  [${lg.key}] 窗格內未開打：${cnt} 場`);
  }

  if (!anyOk) return null; // 全部聯盟賽程都抓失敗 → 呼叫端不要覆寫舊檔
  return list;
}

// ---- 合併進累積檔 -----------------------------------------------------------
function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch (_) {
    return { lastUpdated: null, matches: {} };
  }
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
  const unmapped = [];   // {raw, league, vs}

  for (const m of upcoming) {
    const homeTeam = mapTeam(m.homeRaw);
    const awayTeam = mapTeam(m.awayRaw);
    if (m.homeRaw && !homeTeam) unmapped.push({ raw: m.homeRaw, league: m.league, vs: m.awayRaw });
    if (m.awayRaw && !awayTeam) unmapped.push({ raw: m.awayRaw, league: m.league, vs: m.homeRaw });

    console.log(`⚾ [${m.league}] ${m.awayRaw} (客) vs ${m.homeRaw} (主) | ${m.time} | id:${m.id}`);
    const odds = await fetchMatchOdds(m);

    const e = log.matches[m.id] || { id: m.id, firstSeen: stamp, ml: {}, hd: { bet365: null }, ou: { bet365: null } };
    e.league = m.league;
    e.time = m.time;
    e.startISO = m.startISO;
    e.homeTeam = homeTeam; e.awayTeam = awayTeam;
    e.homeTeamRaw = m.homeRaw; e.awayTeamRaw = m.awayRaw;
    e.lastUpdated = stamp;
    if (!e.ml) e.ml = {};
    if (!e.hd) e.hd = { bet365: null };
    if (!e.ou) e.ou = { bet365: null };

    // 獨贏：open 只在首次建立時記；live 只有「值有變」才追加（price 去重）
    for (const [book, o] of Object.entries(odds.ml)) {
      if (!e.ml[book]) e.ml[book] = { open: { home: o.openHome, away: o.openAway }, live: [] };
      const arr = e.ml[book].live;
      const last = arr[arr.length - 1];
      if (!last || last.home !== o.liveHome || last.away !== o.liveAway) {
        arr.push({ ts: stamp, home: o.liveHome, away: o.liveAway });
      }
    }

    // 讓分 / 大小分：整張歷史表，留「比較長的那張」（變動表只會越來越長）
    if (odds.hd && (!e.hd.bet365 || odds.hd.length >= e.hd.bet365.length)) e.hd.bet365 = odds.hd;
    if (odds.ou && (!e.ou.bet365 || odds.ou.length >= e.ou.bet365.length)) e.ou.bet365 = odds.ou;

    log.matches[m.id] = e;
    await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
  }

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

if (require.main === module) {
  run().catch(e => { console.error('未預期錯誤：', e); process.exit(1); });
}

module.exports = { mapTeam, parseHistoryTable, parseTaiwan, scheduleURLsForLeague, nowTaiwanISO, LEAGUES_CFG };
