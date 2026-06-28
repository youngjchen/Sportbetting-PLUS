/* ============================================================
   模組 C：奇門遁甲數據爬蟲 (qimen_scraper.js)
   來源：www.yixinsoft.com 經典版（POST 表單 → 伺服器渲染 HTML）
   每場比賽抓三個盤（皆以「台灣時鐘時間」為慣例、不開真太陽時、不帶地點）：
     · 開賽時家盤   /qimen/shi    （判讀 ①誰贏 ②讓分 ③大小分 + NRFI 首局）
     · 開賽神刻盤   /qimen/shenke （起局/首局；神刻 10 分鐘一變，取開賽這一格）
     · 結束時辰時家盤 /qimen/shi  （開賽+160 分，平均賽長；判讀 ④尾局逆轉）
   產出：data/qimen_data.json，鍵 = date + 兩隊 + gameTime（與盤面/賠率同一套唯一鍵）
   禮儀：自訂 User-Agent；每個 HTTP 請求之間隨機延遲 1~3 秒。
   去重：奇門盤由時間戳完全決定 → 已抓過的場次（同鍵）直接略過，可隨時續跑。
   用法：
     node qimen_scraper.js --games games.json [--out data/qimen_data.json] [--limit N]
     node qimen_scraper.js --selftest        （只跑單場，印出解析結果，不寫檔）
   games.json 格式：[{ "date":"2026-06-25", "away":"大都會", "home":"小熊", "gameTime":"01:10" }, ...]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.yixinsoft.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const GAME_LEN_MIN = 160;            // 平均賽長（投球計時器後 ~2h40m）→ 結束時辰盤的取樣點
const DELAY_MIN_MS = 500, DELAY_MAX_MS = 1200;   // 一次性回補,適度加速(仍≥0.5s禮貌間隔)
const PALACE_RE = /[巽离離坤乾兌兑艮坎震中][一二三四五六七八九][宫宮]/;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rndDelay = () => sleep(DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS)));

// 唯一鍵：date|兩隊(排序)|gameTime —— 與雙重賽修法同一套
function gameKey(g) {
  const teams = [String(g.away), String(g.home)].sort().join('@');
  return `${g.date}|${teams}|${g.gameTime}`;
}

// 把 "HH:MM" + 日期拆成排盤參數；offsetMin 可加分鐘（結束時辰盤用），會正確跨日
function castParams(date, hhmm, offsetMin) {
  const [Y, M, D] = String(date).split('-').map(Number);
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return null;
  // 用 UTC 做純時鐘運算，避開執行機器的本地時區干擾
  const dt = new Date(Date.UTC(Y, M - 1, D, +m[1], +m[2]) + (offsetMin || 0) * 60000);
  return {
    year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate(),
    hour: dt.getUTCHours(), minute: dt.getUTCMinutes()
  };
}

function buildBody(cast) {
  return new URLSearchParams({
    timeType: 'GongLi',
    year: String(cast.year), month: String(cast.month), day: String(cast.day),
    hour: String(cast.hour), minute: String(cast.minute),
    paiPanType: 'ZhuanPan', qiJuType: 'ChaiBu', runyue: '0',
    name: '', sex: '1', txtWhy: ''
  }).toString();
}

// 解析一張盤：9 宮各取 八神/九星/八門/天盤干/地盤干/暗干/空亡，加四柱(日干時干)/局/馬星/斷語
// 天盤干 vs 地盤干：同宮 cell 順序為 …天盤干→(暗干)→八門→地盤干…，故以「是否已過八門」分上下；暗干由 title「暗」開頭辨認。
const GZ = '[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]';
function parseChart(html) {
  const $ = cheerio.load(html);
  const palaces = {};
  $('.gongfont').each((i, el) => {
    const name = ($(el).text().match(PALACE_RE) || [])[0];
    if (!name || palaces[name]) return;
    const tbl = $(el).closest('table');
    let shen = '', men = '', kong = '', menSeen = false; const xing = [], tian = [], di = [], an = [];
    tbl.find('td span[id]').each((j, s) => {
      const id = $(s).attr('id') || '', ti = $(s).attr('title') || '', tx = $(s).text().trim();
      if (/_shen$/.test(id)) { if (tx) shen = tx; return; }
      if (/_xing[12]$/.test(id)) { if (tx) xing.push(tx); return; }
      if (/_men$/.test(id)) { if (tx) men = tx; menSeen = true; return; }
      if (/_kong$/.test(id)) { if (tx) kong = tx; return; }
      if (/_gan/.test(id) && tx) { if (/^暗/.test(ti)) an.push(tx); else if (!menSeen) tian.push(tx); else di.push(tx); }
    });
    palaces[name] = { shen, xing, men, tian, di, an, kong };
  });
  // 四柱 / 局 / 馬星
  const body = $('body').text().replace(/\s+/g, ' ');
  const sm = body.match(new RegExp('干支：(' + GZ + ')\\s*(' + GZ + ')\\s*(' + GZ + ')\\s*(' + GZ + ')'));
  const siZhu = sm ? [sm[1], sm[2], sm[3], sm[4]] : null;   // [年,月,日,時]柱
  const ju = ($('#Label_Ju').text() || '').trim();
  const maStar = ($('#Label_Ma').text() || '').trim();
  const duanyu = ($('#txtQiMen').val() || $('#txtQiMen').text() || '').trim();
  return {
    palaces, siZhu,
    riGan: siZhu ? siZhu[2][0] : null, shiGan: siZhu ? siZhu[3][0] : null,
    ju, maStar, duanyu, palaceCount: Object.keys(palaces).length
  };
}

async function fetchChart(endpoint, cast) {
  const r = await axios.post(BASE + endpoint, buildBody(cast), {
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      'Accept-Language': 'zh-TW,zh;q=0.9', 'Referer': BASE + endpoint
    },
    timeout: 20000, validateStatus: () => true
  });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  const parsed = parseChart(html);
  if (parsed.palaceCount !== 9) throw new Error('宮位數=' + parsed.palaceCount + '（非9，疑似解析或回應異常）');
  return parsed;
}

// 抓單場三盤
async function scrapeGame(g) {
  const startCast = castParams(g.date, g.gameTime, 0);
  const endCast = castParams(g.date, g.gameTime, GAME_LEN_MIN);
  if (!startCast) throw new Error('gameTime 無法解析: ' + g.gameTime);

  const shiStart = await fetchChart('/qimen/shi', startCast);      await rndDelay();
  const shenkeStart = await fetchChart('/qimen/shenke', startCast); await rndDelay();
  const shiEnd = await fetchChart('/qimen/shi', endCast);

  return {
    key: gameKey(g), date: g.date, away: g.away, home: g.home, gameTime: g.gameTime,
    castStart: startCast, castEnd: endCast, gameLenMin: GAME_LEN_MIN,
    convention: 'TaiwanClock/noSolarTime/noLocation',
    shiStart, shenkeStart, shiEnd,
    scrapedAt: new Date().toISOString()
  };
}

function loadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }

async function main() {
  const args = process.argv.slice(2);
  const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

  if (args.includes('--selftest')) {
    const g = { date: '2026-06-25', away: '大都會', home: '小熊', gameTime: '01:10' };
    console.log('自測單場：', gameKey(g));
    const rec = await scrapeGame(g);
    for (const tag of ['shiStart', 'shenkeStart', 'shiEnd']) {
      const c = rec[tag];
      console.log(`\n--- ${tag}  四柱:${(c.siZhu || []).join(' ')} 日干:${c.riGan} 時干:${c.shiGan} 局:${c.ju} ${c.maStar} ---`);
      for (const [name, p] of Object.entries(c.palaces))
        console.log(`  ${name} 神:${p.shen} 星:${p.xing.join('/')} 門:${p.men} 天盤:${p.tian.join(',')} 地盤:${p.di.join(',')}${p.an.length ? ' 暗:' + p.an.join(',') : ''}${p.kong ? ' 空:' + p.kong : ''}`);
    }
    return;
  }

  const gamesPath = getArg('--games');
  if (!gamesPath) { console.error('需要 --games <file.json>（或用 --selftest）'); process.exit(1); }
  const outPath = getArg('--out', path.join('data', 'qimen_data.json'));
  const limit = parseInt(getArg('--limit', '0'), 10) || 0;

  const games = loadJson(gamesPath, []);
  const out = loadJson(outPath, {});                 // {key: record}（物件便於去重/續跑）
  const before = Object.keys(out).length;
  let done = 0, fail = 0, skip = 0;

  for (const g of games) {
    const key = gameKey(g);
    if (out[key]) { skip++; continue; }              // 已抓過 → 略過
    try {
      out[key] = await scrapeGame(g);
      done++;
      if (done % 10 === 0) { fs.writeFileSync(outPath, JSON.stringify(out)); console.log(`  ...checkpoint 已存 ${done} 場`); }
      console.log(`[OK] ${key}`);
    } catch (e) {
      fail++; console.warn(`[FAIL] ${key} :: ${e.message}`);
    }
    if (limit && done >= limit) break;
    await rndDelay();
  }
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`\n完成。新抓 ${done}、略過(已存) ${skip}、失敗 ${fail}。總計 ${Object.keys(out).length} 場（原 ${before}）→ ${outPath}`);
}

if (require.main === module) main().catch(e => { console.error('FATAL', e); process.exit(1); });
module.exports = { parseChart, gameKey, castParams, scrapeGame };
