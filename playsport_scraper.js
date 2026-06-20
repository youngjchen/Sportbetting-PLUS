/* ============================================================
   模組 A：玩運彩 (Playsport) 賽前深度數據爬蟲
   產出 pregame_data.json，供前端 add-on「讀取時融合」：
     · 運彩讓分方 → 自動偵測顛倒場(vs 你手填的 STAKE 讓分方)
     · 先發投手 / 防禦率 / 被打擊率 → 給「勝率差警告」交叉驗算
   獨立於 Titan007 模組 B；每 0.5~1hr 一次；靜態 HTML → axios + cheerio。
   選擇器已依真站 HTML 校準。賽前欄位只有「未開賽」場次才有值；
   已結束場會改抓終場比分 + 結算讓分方(可供回填)。
   用法：
     node playsport_scraper.js [--leagues=MLB] [--date=20260621] [--debug]
   ============================================================ */
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const ALL_LEAGUES = [
  { id: 1, name: 'MLB' }, { id: 2, name: 'NPB' },
  { id: 6, name: 'CPBL' }, { id: 9, name: 'KBO' },
];
const OUTPUT_FILE = 'pregame_data.json';
const BASE = 'https://www.playsport.cc/livescore';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9',
};
const REQ_TIMEOUT = 20000, LEAGUE_GAP_MIN = 7000, LEAGUE_GAP_MAX = 13000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const num = (s) => { if (s == null) return null; const v = parseFloat(String(s).replace(/[^\d.\-]/g, '')); return isNaN(v) ? null : v; };
const clean = (s) => (s == null ? null : String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() || null);
const pct = (s) => { const v = num(s); return v == null ? null : v / 100; };

const KEEP_DAYS = 5;  // 累積保存：超過 5 天的舊場自動清掉
function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const get = (k) => { const h = args.find((a) => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : null; };
  const lg = get('leagues');
  const oneDate = get('date');
  const days = parseInt(get('days') || '2', 10);  // 預設抓今天+明天（清晨場賽前在前一晚）
  const dates = oneDate ? [oneDate] : Array.from({ length: Math.max(1, days) }, (_, i) => twDate(i));
  return {
    leagues: lg ? ALL_LEAGUES.filter((l) => lg.split(',').map((s) => s.trim().toUpperCase()).includes(l.name)) : ALL_LEAGUES,
    dates, debug: args.includes('--debug'),
  };
}
function twDate(offsetDays) {
  const now = new Date();
  const tw = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  if (offsetDays) tw.setDate(tw.getDate() + offsetDays);
  return `${tw.getFullYear()}${String(tw.getMonth() + 1).padStart(2, '0')}${String(tw.getDate()).padStart(2, '0')}`;
}
async function fetchPage(leagueId, date) {
  const url = `${BASE}/${leagueId}?gamedate=${date}&mode=1&`;  // mode=1 = 運彩盤；帶 gamedate 防快取
  const res = await axios.get(url, { headers: HEADERS, timeout: REQ_TIMEOUT, validateStatus: (s) => s >= 200 && s < 400 });
  return res.data;
}

// 取某表第一筆資料列(表頭 tr 之後第一個 tr)的儲存格文字
function firstDataRow($, $table) {
  if (!$table || !$table.length) return [];
  const rows = $table.find('tr');
  let headerIdx = 0;
  rows.each((i, r) => { if (headerIdx === 0 && $(r).find('th').length) headerIdx = i; });
  const dataTr = rows.eq(headerIdx + 1);
  return dataTr.find('td').toArray().map((c) => clean($(c).text()));
}

// 解析運彩讓分方：優先 preview 運彩欄(未開賽)，退回 on-box(已結束)
function resolveHandicap(p) {
  const side = (raw) => {
    if (!raw || raw === '-' ) return null;
    const give = /讓/.test(raw) || /(^|[^+\d])-\s*\d/.test(raw);
    const recv = /受/.test(raw) || /\+\s*\d/.test(raw);
    const v = num(raw); return { give: give && !recv, recv, val: v == null ? null : Math.abs(v), raw };
  };
  const a = side(p.ahAwayRaw), h = side(p.ahHomeRaw);
  if (a && a.give) return { favSide: 'away', line: a.val, src: '運彩' };
  if (h && h.give) return { favSide: 'home', line: h.val, src: '運彩' };
  if (a && a.recv) return { favSide: 'home', line: a.val, src: '運彩' };
  if (h && h.recv) return { favSide: 'away', line: h.val, src: '運彩' };
  // 退回 on-box：注意！已結束場的高亮隊 = 過盤方(cover result)，不是賽前讓分方。
  // 經 14/14 驗證確認。標 src='過盤'，僅供參考，不可拿來判顛倒（顛倒只認 src='運彩'）。
  if (p.winTeam && (p.winTeam === p.homeTeam || p.winTeam === p.awayTeam)) {
    const coverSide = p.winTeam === p.homeTeam ? 'home' : 'away';
    const line = num(p.aheadPrice) != null ? num(p.aheadPrice) : (p.betTxt ? num(p.betTxt) : null);
    return { favSide: coverSide, line: line == null ? null : Math.abs(line), src: '過盤' };
  }
  return null;
}

function extractGames(html, leagueName) {
  const $ = cheerio.load(html);
  const games = [];
  $('.outer-gamebox').each((_, node) => {
    const $box = $(node);
    const oid = $box.attr('data-oid');
    if (!oid) return;
    const m = oid.match(/^([A-Za-z]+)_(\d{8})_([A-Za-z0-9]+)@([A-Za-z0-9]+)_(\d{3,4})$/);
    if (!m) return;
    const [, , ymd, awayAbbr, homeAbbr, hhmm] = m;
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    const hh = hhmm.padStart(4, '0'); const time = `${hh.slice(0, 2)}:${hh.slice(2)}`;

    const $prev = $box.find('.js-gamePreviewBox').first();
    const $on = $box.find('.js-gameOnbox').first();
    const gameid = (($box.find('a[href*="gameid="]').attr('href') || '').match(/gameid=(\d+)/) || [])[1] || null;
    const previewVisible = !((($prev.attr('style')) || '').includes('display:none'));

    let awayTeam = clean($on.attr('data-namea'));
    let homeTeam = clean($on.attr('data-nameh'));
    if (!awayTeam || !homeTeam) {
      const links = $prev.find('a[href*="teamid="]').toArray().map((a) => clean($(a).text())).filter(Boolean);
      awayTeam = awayTeam || links[0] || null; homeTeam = homeTeam || links[1] || null;
    }

    // 投手 [勝-敗,防禦率,被打擊率] —— 表頭含「勝-敗」的兩張(客,主)
    const pitcherT = $prev.find('table.pitcherRecord-table').filter((_, t) => /勝-敗/.test($(t).find('th').first().text())).toArray();
    const pa = firstDataRow($, $(pitcherT[0])), ph = firstDataRow($, $(pitcherT[1]));
    // 團隊打擊 [打擊率,上壘率,平均得分] —— 表頭含「打擊率」的兩張
    const batT = $prev.find('table.pitcherRecord-table').filter((_, t) => /打擊率/.test($(t).find('th').first().text())).toArray();
    const ba = firstDataRow($, $(batT[0])), bh = firstDataRow($, $(batT[1]));
    // 投手名
    const pn = $prev.find('td.start_pitcher').toArray().map((t) => clean($(t).text()));

    // 運彩讓分盤口/過盤率：no_start_datd_is 兩張(客,主)；列序 讓分盤口/讓分過盤率/近十場/大小盤口/大小過盤率；datd_s=運彩
    const isT = $prev.find('table.no_start_datd_is').toArray();
    const sCell = (tbl, rowIdx) => clean($(tbl).find('tr').eq(rowIdx).find('td.datd_s').text());
    const ahAwayRaw = isT[0] ? sCell(isT[0], 0) : null, ahHomeRaw = isT[1] ? sCell(isT[1], 0) : null;
    const hdCoverAway = isT[0] ? pct(sCell(isT[0], 1)) : null, hdCoverHome = isT[1] ? pct(sCell(isT[1], 1)) : null;
    const ouAwayRaw = isT[0] ? sCell(isT[0], 3) : null;

    // on-box 退路(已結束)
    const winTeam = clean($on.find('.teamname_highlight').first().text());
    const betTxt = clean($on.find('[id$="_bet"]').first().text());
    const aheadPrice = clean($on.attr('data-aheadprice'));

    const handicap = resolveHandicap({ ahAwayRaw, ahHomeRaw, awayTeam, homeTeam, aheadPrice, winTeam, betTxt });
    const awayScore = num($on.find('[id$="_as_b"]').first().text());
    const homeScore = num($on.find('[id$="_hs_b"]').first().text());
    // 「結束」只認 on-box 那句「比賽結束/完場/終場」，不靠比分存在（避免把 0:0 進行中誤判為結束）
    const onText = clean($on.text()) || '';
    const isFinished = /比賽結束|完場|終場|Final/.test(onText);
    const status = isFinished ? 'finished' : (previewVisible ? 'upcoming' : 'inprogress');

    games.push({
      league: leagueName, officialId: oid, gameid, date, time, awayAbbr, homeAbbr,
      awayTeam, homeTeam, status,
      awayPitcher: pn[0] || null, homePitcher: pn[1] || null,
      awayERA: num(pa[1]), homeERA: num(ph[1]), awayBAA: num(pa[2]), homeBAA: num(ph[2]),
      awayAVG: num(ba[0]), awayOBP: num(ba[1]), awayRuns: num(ba[2]),
      homeAVG: num(bh[0]), homeOBP: num(bh[1]), homeRuns: num(bh[2]),
      lotteryHandicap: handicap, lotteryHdCoverAway: hdCoverAway, lotteryHdCoverHome: hdCoverHome,
      lotteryTotal: (function (s) { const m = String(s == null ? '' : s).match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : null; })(ouAwayRaw),  // 運彩大小基準（賽前才有）
      awayScore, homeScore,
      rawHd: { away: ahAwayRaw, home: ahHomeRaw, ou: ouAwayRaw },  // 原始字串供首次校準
      scrapedAt: new Date().toISOString(),
    });
  });
  return games;
}

function saveAtomic(data) {
  const tmp = OUTPUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, OUTPUT_FILE);
}

// 讀既有累積檔（Actions 會把 data/pregame_data.json checkout 進來；本機則讀根目錄）
function loadStore() {
  for (const p of ['data/pregame_data.json', OUTPUT_FILE]) {
    try { const arr = JSON.parse(fs.readFileSync(p, 'utf8')); if (Array.isArray(arr)) return arr; } catch (_) {}
  }
  return [];
}

// 合併：賽前數據（ERA/投手/打擊）一旦抓到就保留；狀態/比分/讓分方取最新；清掉過舊場
function mergeStore(existing, fresh, keepDays) {
  const byId = new Map(existing.map((g) => [g.officialId, g]));
  const keepPre = (nv, ov) => (nv != null && nv !== 0) ? nv : ((ov != null && ov !== 0) ? ov : nv);
  for (const g of fresh) {
    const prev = byId.get(g.officialId);
    if (!prev) { byId.set(g.officialId, g); continue; }
    const merged = { ...prev, ...g };
    for (const k of ['awayERA', 'homeERA', 'awayBAA', 'homeBAA', 'awayAVG', 'awayOBP', 'awayRuns', 'homeAVG', 'homeOBP', 'homeRuns', 'lotteryTotal'])
      merged[k] = keepPre(g[k], prev[k]);
    merged.awayPitcher = g.awayPitcher || prev.awayPitcher;
    merged.homePitcher = g.homePitcher || prev.homePitcher;
    // 讓分盤口：優先保留賽前運彩盤口(真正的讓分方)；賽後的 過盤 結果不可覆蓋它
    const isLine = (hd) => hd && hd.src === '運彩';
    merged.lotteryHandicap = isLine(prev.lotteryHandicap) ? prev.lotteryHandicap
                           : (isLine(g.lotteryHandicap) ? g.lotteryHandicap
                           : (g.lotteryHandicap || prev.lotteryHandicap));
    byId.set(g.officialId, merged);
  }
  const cutoff = new Date(Date.now() - keepDays * 86400000);
  return [...byId.values()].filter((g) => { const d = new Date((g.date || '') + 'T00:00:00'); return isNaN(d) || d >= cutoff; });
}

async function run(argv) {
  const { leagues, dates, debug } = parseArgs(argv);
  console.log(`\n🚀 玩運彩賽前數據  聯盟=[${leagues.map((l) => l.name).join(',')}]  日期=[${dates.join(',')}]  運彩盤\n`);
  if (debug) {
    const html = await fetchPage(leagues[0].id, dates[0]);
    const $ = cheerio.load(html);
    const b = $('.outer-gamebox').first();
    console.log('===== DEBUG 第一場 HTML =====\n' + (b.length ? $.html(b) : html.slice(0, 8000)) + '\n===== END =====');
    return;
  }
  const fresh = [];
  for (let di = 0; di < dates.length; di++) {
    for (let i = 0; i < leagues.length; i++) {
      try {
        const games = extractGames(await fetchPage(leagues[i].id, dates[di]), leagues[i].name);
        const up = games.filter((g) => g.status === 'upcoming').length;
        const fin = games.filter((g) => g.status === 'finished').length;
        console.log(`  ${dates[di]} [${leagues[i].name}] ${games.length} 場(未開賽 ${up}／結束 ${fin})`);
        fresh.push(...games);
      } catch (e) { console.log(`  ${dates[di]} [${leagues[i].name}] ⚠️ ${e.response ? 'HTTP ' + e.response.status : e.code || e.message}`); }
      if (!(di === dates.length - 1 && i === leagues.length - 1)) await sleep(jitter(LEAGUE_GAP_MIN, LEAGUE_GAP_MAX));
    }
  }
  const merged = mergeStore(loadStore(), fresh, KEEP_DAYS);
  saveAtomic(merged);
  const withEra = merged.filter((g) => (g.awayERA || 0) > 0 || (g.homeERA || 0) > 0).length;
  console.log(`\n✅ 本次抓 ${fresh.length} 場；累積保存 ${merged.length} 場（含 ERA ${withEra} 場）→ ${OUTPUT_FILE}\n`);
  return merged;
}
if (require.main === module) run().catch((e) => { console.error('未預期錯誤：', e); process.exitCode = 1; });
module.exports = { parseArgs, twDate, extractGames, resolveHandicap, saveAtomic, loadStore, mergeStore, run, ALL_LEAGUES };
