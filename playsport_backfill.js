/* ============================================================
   玩運彩歷史回補：逐局比分 + RHE + 讓分/大小結果（archive 模式，不剪舊資料）
   重用 playsport_scraper.js 的 extractGames 解析器（逐局+RHE 已實測可回補到數月前）。
   與每日滾動的 pregame_data.json(KEEP_DAYS=5) 分開存，產出長期 archive。
   用法：
     node playsport_backfill.js --from 2026-04-01 --to 2026-06-25 [--leagues=MLB] [--out data/playsport_history.json]
   特性：以 officialId 去重合併、可重複跑續補、請求間隨機延遲。
   注意：玩運彩歷史頁「結束場」只有逐局+比分+讓分結果，沒有先發投手（投手改由 MLB API 補）。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { extractGames, ALL_LEAGUES } = require('./playsport_scraper.js');

const BASE = 'https://www.playsport.cc/livescore';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9',
};
const REQ_TIMEOUT = 20000, GAP_MIN = 4000, GAP_MAX = 8000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rndGap = () => sleep(GAP_MIN + Math.floor(Math.random() * (GAP_MAX - GAP_MIN)));

function arg(k, d) { const i = process.argv.indexOf(k); if (i >= 0) return process.argv[i + 1]; const h = process.argv.find(a => a.startsWith(k + '=')); return h ? h.split('=').slice(1).join('=') : d; }
function ymd(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }
function dateList(from, to) {
  const norm = (s) => s.replace(/-/g, '');
  const mk = (s) => { const n = norm(s); return new Date(Date.UTC(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8))); };
  const out = []; let d = mk(from); const end = mk(to);
  while (d <= end) { out.push(ymd(d)); d = new Date(d.getTime() + 86400000); }
  return out;
}
function loadJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }

async function fetchDateLeague(leagueId, date) {
  const url = `${BASE}/${leagueId}?gamedate=${date}&mode=1&`;
  const res = await axios.get(url, { headers: HEADERS, timeout: REQ_TIMEOUT, validateStatus: () => true });
  if (res.status !== 200) throw new Error('HTTP ' + res.status);
  return res.data;
}

async function main() {
  const from = arg('--from'), to = arg('--to');
  if (!from || !to) { console.error('需要 --from YYYY-MM-DD --to YYYY-MM-DD'); process.exit(1); }
  const lgArg = (arg('--leagues', 'MLB') || 'MLB').toUpperCase().split(',').map(s => s.trim());
  const leagues = ALL_LEAGUES.filter(l => lgArg.includes(l.name));
  const outPath = arg('--out', path.join('data', 'playsport_history.json'));

  const dates = dateList(from, to);
  const store = loadJson(outPath, {});           // { officialId: gameRecord }
  const before = Object.keys(store).length;
  let added = 0, updated = 0, withLine = 0, fail = 0;

  console.log(`玩運彩回補 ${from}~${to}（${dates.length} 天）聯盟=[${leagues.map(l => l.name).join(',')}] → ${outPath}\n`);

  for (let di = 0; di < dates.length; di++) {
    for (const lg of leagues) {
      try {
        const games = extractGames(await fetchDateLeague(lg.id, dates[di]), lg.name);
        const fin = games.filter(g => g.status === 'finished');
        for (const g of fin) {
          if (!g.officialId) continue;
          const had = store[g.officialId];
          store[g.officialId] = had ? { ...had, ...g } : g;
          if (had) updated++; else added++;
          if (g.lineScore && g.lineScore.away && g.lineScore.away.length) withLine++;
        }
        console.log(`  ${dates[di]} [${lg.name}] 結束 ${fin.length} 場`);
      } catch (e) { fail++; console.warn(`  ${dates[di]} [${lg.name}] ⚠ ${e.message}`); }
      await rndGap();
    }
    if (di % 10 === 9) { fs.writeFileSync(outPath, JSON.stringify(store)); console.log(`  ...checkpoint（已處理 ${di + 1}/${dates.length} 天）`); }
  }
  fs.writeFileSync(outPath, JSON.stringify(store));
  console.log(`\n完成。新增 ${added}、更新 ${updated}、有逐局 ${withLine}、失敗 ${fail}。archive 共 ${Object.keys(store).length} 場（原 ${before}）`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
