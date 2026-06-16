// ============================================================================
//  Titan007 MLB 賠率抓取（雲端版・跑一次就結束，節奏交給 GitHub Actions cron）
//  - 三市場：獨贏(12BET/Bet365/Bwin) / 讓分(Bet365) / 大小分(Bet365)
//  - 讓分與大小分：完整保留整張變動表（每一列＝一次盤口移動）
//  - 獨贏：來源無歷史，只有初盤＋當前，故以「價有變才追加」自己縫軌跡
//  - 輸出累積到 data/odds_log.json（讀進舊檔→合併→寫回，永不刪舊場次）
// ============================================================================

const axios = require('axios');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// ---- 可調參數 ---------------------------------------------------------------
// 只抓「未來這麼多小時內開打」的比賽。離開賽還很遠的盤幾乎不動，抓了也是雜訊、
// 又增加對 Titan007 的請求量。8 小時足以涵蓋 MLB 整批賽事＋賽前真正會動的時段。
// 想連更早的盤都記就調大（例如 24），代價是請求量與檔案成長變多。
const ACTIVE_WINDOW_HOURS = 24;

const OUTPUT_FILE = path.join('data', 'odds_log.json');
const REQUEST_GAP_MS = 900;   // 每場之間稍微間隔，對來源客氣一點

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

// ---- 隊名對照：Titan007（簡繁混用，部分用舊隊名）→ 排盤板繁中縮寫 ----------
// 用「別名子字串」比對，不依賴完整字串完全相同。
// 下列 30 隊的別名涵蓋簡體、繁體、以及 Titan007 慣用的不同寫法/舊名。
// 若某天出現對不上的名字，腳本會在結尾印出「未對應」清單，把它貼給我就能補。
const TEAM_ALIASES = {
  '金鶯':   ['金鶯', '金莺'],
  '紅襪':   ['紅襪', '红袜', '紅袜', '红襪'],
  '洋基':   ['洋基'],
  '光芒':   ['光芒', '魔鬼魚', '魔鬼鱼', '坦帕灣魔鬼', '坦帕湾魔鬼'],   // Rays / 舊名 Devil Rays
  '藍鳥':   ['藍鳥', '蓝鸟'],
  '白襪':   ['白襪', '白袜'],
  '守護者': ['守護者', '守护者', '印第安人', '印地安人'],               // Guardians / 舊名 Indians
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
  '落磯':   ['落磯', '落矶', '洛磯', '洛矶', '洛基'],                    // Titan007 慣用「洛基」
  '道奇':   ['道奇'],
  '教士':   ['教士'],
  '巨人':   ['巨人']
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

// 依「現在 ~ 現在+窗格」可能跨到的月份，組出 1~2 個賽程檔網址（處理月底/年底跨界）
function scheduleURLs() {
  const set = new Set();
  const add = (ms) => {
    const tw = new Date(ms + 8 * 3600 * 1000);
    const y = tw.getUTCFullYear();
    const m = tw.getUTCMonth() + 1;
    set.add(`https://sports.titan007.com/jsData/baseball/matchResult/${y}/l1_1_${y}_${m}.js`);
  };
  add(Date.now());
  add(Date.now() + ACTIVE_WINDOW_HOURS * 3600 * 1000);
  return [...set];
}

// ---- 解析 ChangeDetail 的 odds2 表格：回傳「全部列」（之前只取頭尾，現在全留）--
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
  return rows.length ? rows : null;  // rows[0]=最新, rows[末]=初盤, 中間=完整過程
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

// ---- 賽程：抓 1~2 個月檔，合併球隊字典與賽事，篩出窗格內未開打的場次 ----------
async function fetchUpcomingMatches() {
  const teamDict = {};
  let allData = [];
  for (const url of scheduleURLs()) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const sb = {}; vm.createContext(sb); vm.runInContext(res.data, sb);
      if (Array.isArray(sb.arrTeam)) sb.arrTeam.forEach(t => { teamDict[t[0]] = t[2]; });
      if (Array.isArray(sb.arrData)) allData = allData.concat(sb.arrData);
    } catch (e) {
      console.log(`  ⚠️ 賽程檔抓取略過（可能該月尚未發佈）: ${url} (${e.message})`);
    }
  }
  if (allData.length === 0) return null; // null = 賽程整個抓失敗 → 呼叫端不要覆寫舊檔

  const now = Date.now();
  const limit = now + ACTIVE_WINDOW_HOURS * 3600 * 1000;
  const seen = new Set();
  const list = [];
  for (const m of allData) {
    if (seen.has(m[0])) continue;
    const { date, iso } = parseTaiwan(m[2]);
    const ts = date.getTime();
    if (!(ts > now && ts < limit)) continue; // 未開打 且 在窗格內（開打的自然落榜＝斷開走地）
    seen.add(m[0]);
    list.push({
      id: m[0], time: m[2], startISO: iso,
      homeRaw: teamDict[m[3]] || null, awayRaw: teamDict[m[4]] || null
    });
  }
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
  const unmapped = new Set();

  for (const m of upcoming) {
    const homeTeam = mapTeam(m.homeRaw);
    const awayTeam = mapTeam(m.awayRaw);
    if (m.homeRaw && !homeTeam) unmapped.add(m.homeRaw);
    if (m.awayRaw && !awayTeam) unmapped.add(m.awayRaw);

    console.log(`⚾ ${m.awayRaw} (客) vs ${m.homeRaw} (主) | ${m.time} | id:${m.id}`);
    const odds = await fetchMatchOdds(m);

    const e = log.matches[m.id] || { id: m.id, firstSeen: stamp, ml: {}, hd: { bet365: null }, ou: { bet365: null } };
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

  if (unmapped.size) {
    console.log(`\n⚠️  以下隊名對不上排盤板縮寫，請貼給我補進對照表：`);
    [...unmapped].forEach(n => console.log(`     ${n}`));
  }
  console.log(`==================================================\n`);
}

if (require.main === module) {
  run().catch(e => { console.error('未預期錯誤：', e); process.exit(1); });
}

module.exports = { mapTeam, parseHistoryTable, parseTaiwan, scheduleURLs, nowTaiwanISO };
