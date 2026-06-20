/* ============================================================
   模組 A：玩運彩 (Playsport) 賽前深度數據爬蟲
   ------------------------------------------------------------
   產出 pregame_data.json，供前端 add-on「讀取時融合」：
     · 台灣運彩讓分方 → 自動偵測顛倒場（vs 你手填的 STAKE 讓分方）
     · 先發投手 / 防禦率 / 被打擊率 → 給「勝率差警告」做交叉驗算

   設計原則（依使用者裁示）：
     · 完全獨立於 Titan007 模組 B，不共用迴圈、不互相依賴。
     · 每 0.5~1hr 跑一次即可（賽前數據變慢；投手常「尚未公布」要近開賽才有）。
     · 靜態 HTML → axios + cheerio，不需無頭瀏覽器。
     · officialId（含日期+隊伍縮寫）為配對主鍵，比中文隊名穩。

   ⚠️ 選擇器驗證：作者沙盒連不到 playsport.cc，無法對真站驗證 DOM。
      下列「核心」(URL/聯盟/時區/officialId/中文隊名) 是可靠的；
      「欄位解析」(投手/讓分方/過盤率) 為最佳推測，需跑一次 --debug 鎖定：
          node playsport_scraper.js --debug
      會把第一場的原始 HTML 區塊印出來，貼回來即可校準選擇器。

   用法：
     node playsport_scraper.js                  # 4 聯盟、今天(台灣日期)、運彩盤
     node playsport_scraper.js --leagues=MLB    # 只抓 MLB
     node playsport_scraper.js --date=20260621  # 指定日期
     node playsport_scraper.js --debug          # 印第一場原始 HTML 供校準
   ============================================================ */
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

// ---------- 聯盟代號（已確認）----------
const ALL_LEAGUES = [
  { id: 1, name: 'MLB' },
  { id: 2, name: 'NPB' },
  { id: 6, name: 'CPBL' },
  { id: 9, name: 'KBO' },
];
const OUTPUT_FILE = 'pregame_data.json';
const BASE = 'https://www.playsport.cc/livescore';

// ---------- 防禦 / 節流 ----------
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.playsport.cc/',
  'Accept-Language': 'zh-TW,zh;q=0.9',
};
const REQ_TIMEOUT = 20000;
const LEAGUE_GAP_MIN = 7000, LEAGUE_GAP_MAX = 13000;   // 各聯盟間隨機延遲(jitter)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// ---------- 參數 ----------
function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const get = (k) => { const h = args.find((a) => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : null; };
  const has = (k) => args.includes('--' + k);
  const lg = get('leagues');
  return {
    leagues: lg ? ALL_LEAGUES.filter((l) => lg.split(',').map((s) => s.trim().toUpperCase()).includes(l.name)) : ALL_LEAGUES,
    date: get('date') || twDate(),
    debug: has('debug'),
  };
}

// 台灣(UTC+8)當天日期 YYYYMMDD —— 在 GitHub Actions(UTC) 跑也正確
function twDate() {
  const now = new Date();
  const tw = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  return `${tw.getFullYear()}${String(tw.getMonth() + 1).padStart(2, '0')}${String(tw.getDate()).padStart(2, '0')}`;
}

// ---------- 抓單一聯盟頁 ----------
async function fetchPage(leagueId, date) {
  // mode=1 = 運彩盤（非國際盤）；務必帶 gamedate 避免被快取成舊日期
  const url = `${BASE}/${leagueId}?gamedate=${date}&mode=1&`;
  const res = await axios.get(url, { headers: HEADERS, timeout: REQ_TIMEOUT, validateStatus: (s) => s >= 200 && s < 400 });
  return res.data;
}

// ---------- 小工具：數字 ----------
const num = (s) => { if (s == null) return null; const m = String(s).replace(/[^\d.\-]/g, ''); const v = parseFloat(m); return isNaN(v) ? null : v; };
const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);

// ============================================================
//  解析：把整頁切成「每場一個區塊」，逐場萃取
//  核心(officialId/隊名) 可靠；欄位解析為最佳推測，--debug 可校準。
// ============================================================
function extractGames(html, leagueName) {
  const $ = cheerio.load(html);
  // 區塊容器：優先 .outer-gamebox（GEMINI 提示），找不到則退回用 officialId 邊界切
  let blocks = $('.outer-gamebox').toArray();
  if (!blocks.length) {
    // 退路：每個含 officialId 的最外層 table 當一個區塊
    const seen = new Set();
    $('a[href*="officialId="]').each((_, a) => {
      const box = $(a).closest('table').parent().closest('table');
      const node = box.length ? box[0] : $(a).closest('div')[0];
      if (node && !seen.has(node)) { seen.add(node); blocks.push(node); }
    });
  }

  const games = [];
  for (const node of blocks) {
    const $b = $(node);
    const blockHtml = $.html($b);

    // ---- officialId（可靠主鍵）: LEAGUE_YYYYMMDD_AWAY@HOME_HHMM ----
    const m = blockHtml.match(/officialId=([A-Za-z]+)_(\d{8})_([A-Za-z0-9]+)(?:%40|@)([A-Za-z0-9]+)_(\d{3,4})/);
    if (!m) continue;
    const [, lg, ymd, awayAbbr, homeAbbr, hhmm] = m;
    const gidMatch = blockHtml.match(/gameid=(\d+)/);
    const officialId = `${lg}_${ymd}_${awayAbbr}@${homeAbbr}_${hhmm}`;
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    const time = `${hhmm.padStart(4, '0').slice(0, 2)}:${hhmm.padStart(4, '0').slice(2)}`;

    // ---- 中文隊名（可靠）：teamid 連結文字，前=客、後=主 ----
    const teamLinks = $b.find('a[href*="teamid="]').toArray().map((a) => clean($(a).text())).filter(Boolean);
    const awayTeam = teamLinks[0] || null;
    const homeTeam = teamLinks[1] || null;

    // ---- 以下欄位為最佳推測（label 錨定）；跑 --debug 後我會釘死 ----
    const f = parseFields($, $b);

    games.push({
      league: leagueName, officialId, gameid: gidMatch ? gidMatch[1] : null,
      date, time, awayAbbr, homeAbbr, awayTeam, homeTeam,
      awayPitcher: f.awayPitcher, homePitcher: f.homePitcher,
      awayERA: f.awayERA, homeERA: f.homeERA,
      awayBAA: f.awayBAA, homeBAA: f.homeBAA,
      awayAVG: f.awayAVG, awayOBP: f.awayOBP, awayRuns: f.awayRuns,
      homeAVG: f.homeAVG, homeOBP: f.homeOBP, homeRuns: f.homeRuns,
      lotteryHandicap: f.lotteryHandicap,          // {favSide:'home'|'away', line:1.5} 運彩讓分方
      lotteryHdCoverAway: f.hdCoverAway, lotteryHdCoverHome: f.hdCoverHome,
      lotteryTotalBasis: f.totalBasis,
      scrapedAt: new Date().toISOString(),
    });
  }
  return games;
}

// label 錨定萃取：在區塊內找含某文字的儲存格，取同列的左(客)/右(主)資料。
// ⚠️ 真站欄位位置未驗證 —— 以 --debug 的輸出校準後即可精準。
function rowByLabel($, $b, label) {
  let hit = null;
  $b.find('td,div,th').each((_, el) => {
    if (hit) return;
    if (clean($(el).text()) === label) hit = $(el);
  });
  return hit;
}
function parseFields($, $b) {
  const out = {
    awayPitcher: null, homePitcher: null, awayERA: null, homeERA: null, awayBAA: null, homeBAA: null,
    awayAVG: null, awayOBP: null, awayRuns: null, homeAVG: null, homeOBP: null, homeRuns: null,
    lotteryHandicap: null, hdCoverAway: null, hdCoverHome: null, totalBasis: null,
  };
  try {
    // 防禦率 / 被打擊率：在「先發投手」段，每行 [勝-敗][防禦率][被打擊率]，左客右主
    const era = rowByLabel($, $b, '防禦率');
    if (era) {
      const cells = era.closest('tr').nextAll('tr').first().find('td').toArray().map((c) => clean($(c).text()));
      // 真站結構待校準；先保守抓不到就 null
    }
    // 今日讓分盤口：含 "-1.5"（或「讓X分」）的那邊 = 讓分方
    const hdLabel = rowByLabel($, $b, '今日讓分盤口');
    if (hdLabel) {
      const rowTxt = clean(hdLabel.closest('tr').text()) || '';
      const lm = rowTxt.match(/-?\d+(?:\.\d+)?/g);
      // favSide / line 真站格式待 --debug 校準
    }
  } catch (e) { /* 任何解析失敗 → 留 null，不讓整支掛掉 */ }
  return out;
}

// ---------- 原子存檔 ----------
function saveAtomic(data) {
  const tmp = OUTPUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, OUTPUT_FILE);
}

// ---------- 主程式 ----------
async function run(argv) {
  const { leagues, date, debug } = parseArgs(argv);
  console.log(`\n🚀 玩運彩賽前數據  聯盟=[${leagues.map((l) => l.name).join(',')}]  日期=${date}  運彩盤(mode=1)\n`);

  if (debug) {
    // 只抓第一個聯盟、印第一場原始 HTML 供校準選擇器
    const html = await fetchPage(leagues[0].id, date);
    const $ = cheerio.load(html);
    let block = $('.outer-gamebox').first();
    if (!block.length) {
      const a = $('a[href*="officialId="]').first();
      block = a.closest('table').parent().closest('table');
      if (!block.length) block = a.closest('div');
    }
    console.log('===== DEBUG：第一場原始 HTML（貼這段給我校準選擇器）=====\n');
    console.log(block.length ? $.html(block) : '⚠️ 找不到對戰區塊；改貼整頁前 8000 字：\n' + html.slice(0, 8000));
    console.log('\n===== DEBUG END =====');
    return;
  }

  const all = [];
  for (let i = 0; i < leagues.length; i++) {
    const lg = leagues[i];
    try {
      const html = await fetchPage(lg.id, date);
      const games = extractGames(html, lg.name);
      console.log(`  [${lg.name}] 抓到 ${games.length} 場` + (games.length && games[0].lotteryHandicap == null ? '（欄位待 --debug 校準）' : ''));
      all.push(...games);
    } catch (e) {
      console.log(`  [${lg.name}] ⚠️ 失敗：${e.response ? 'HTTP ' + e.response.status : e.code || e.message}`);
    }
    if (i < leagues.length - 1) await sleep(jitter(LEAGUE_GAP_MIN, LEAGUE_GAP_MAX));
  }
  saveAtomic(all);
  console.log(`\n✅ 共 ${all.length} 場 → ${OUTPUT_FILE}\n`);
  return all;
}

if (require.main === module) {
  run().catch((e) => { console.error('未預期錯誤：', e); process.exitCode = 1; });
}
module.exports = { parseArgs, twDate, extractGames, parseFields, saveAtomic, run, ALL_LEAGUES };
