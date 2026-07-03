/* ============================================================
   玩運彩「運彩盤」大小線 + 讓分線回補（賽事結果查詢頁，補 fused 的大小線缺口）
   來源：https://www.playsport.cc/gamesData/result?allianceid=1&gametime=YYYYMMDD（MLB=allianceid 1）
   每場 = 兩個 <tr gameid>（客、主）；td-bank-bet02 .data-wrap>strong = 運彩大小線、
        td-bank-bet01 = 運彩讓分線、td-gameinfo h4 = 台灣開賽時間、td-teaminfo h3 a = 隊名。
   國際盤欄位此頁僅預測%（非乾淨線）→ 不抓；國際線需用 odds_log(Titan007)。
   用法：
     node playsport_totals.js --selftest 2026-06-05     （測單日、印出、不寫檔）
     node playsport_totals.js --from 2026-04-01 --to 2026-06-25 [--out data/playsport_totals.json]
                              [--seasononly]（只跑 3~11 月）[--resume]（跳過 _done.json 已完成日期，長區間分段續跑用）
   產出：陣列 [{key,date,time,away,home,totLine,hdAwayLine,gameid}]，key=date+兩隊+time。
   歷史回補註記：2019~2021 克里夫蘭隊名「印地安人」（2022 起改「守護者」），KNOWN_TEAMS 兩者皆收；
     全期 2019→今約 2,700 天 × 4-8s ≈ 4~6 小時，建議 --seasononly 並分年段跑，進度記在 *_done.json。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const URL = (date) => `https://www.playsport.cc/gamesData/result?allianceid=1&gametime=${date}`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9',
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rndGap = () => sleep(4000 + Math.floor(Math.random() * 4000));
const arg = (k, d) => { const i = process.argv.indexOf(k); if (i >= 0) return process.argv[i + 1]; const h = process.argv.find(a => a.startsWith(k + '=')); return h ? h.split('=').slice(1).join('=') : d; };
const ymdDash = (s) => { const n = String(s).replace(/-/g, ''); return `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}`; };
function dateList(from, to) {
  const mk = (s) => { const n = String(s).replace(/-/g, ''); return new Date(Date.UTC(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8))); };
  const out = []; let d = mk(from); const end = mk(to);
  const p = (x) => String(x).padStart(2, '0');
  while (d <= end) { out.push(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`); d = new Date(d.getTime() + 86400000); }
  return out;
}
function to24(s) { // "AM 06:40" / "PM 01:05" → "06:40" / "13:05"
  const m = /(AM|PM)?\s*(\d{1,2}):(\d{2})/i.exec(s || ''); if (!m) return '';
  let h = +m[2]; const ap = (m[1] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[3]}`;
}
const lineNum = ($cell) => { const t = $cell.find('.data-wrap > strong').first().text().trim(); return t || null; };
// 30 隊中文名（與 MLB spine 一致）：用「已知隊名」比對，避免把日籍球員漢字名(今永昇太/大谷翔平等)誤當隊名
const KNOWN_TEAMS = ['天使', '響尾蛇', '金鶯', '紅襪', '小熊', '紅人', '守護者', '落磯', '老虎', '太空人', '皇家', '道奇', '國民', '大都會', '運動家', '海盜', '教士', '水手', '巨人', '紅雀', '光芒', '遊騎兵', '藍鳥', '雙城', '費城人', '勇士', '白襪', '馬林魚', '洋基', '釀酒人', '印地安人', '印第安人']; // 末兩項=克里夫蘭 2019~2021 舊名（2022 改守護者），兩種寫法皆收
function teamsFromText(text) {
  const found = [];
  for (const name of KNOWN_TEAMS) { const idx = text.indexOf(name); if (idx >= 0) found.push([idx, name]); }
  found.sort((a, b) => a[0] - b[0]);
  return [found[0] && found[0][1], found[1] && found[1][1]];
}

function parseDay(html, dateDash) {
  const $ = cheerio.load(html);
  const byGame = {};
  $('table.gamedata-results tr[gameid]').each((i, tr) => {
    const $tr = $(tr); const gid = $tr.attr('gameid'); if (!gid) return;
    (byGame[gid] ||= []).push($tr);
  });
  const out = []; const skipped = [];
  for (const gid in byGame) {
    const rows = byGame[gid];
    let time = '', teamText = '', tot = null, hd = null; const links = [];
    for (const $tr of rows) {
      const t = $tr.find('td.td-gameinfo h4').first().text().trim(); if (t && !time) time = to24(t);
      const ti = $tr.find('td.td-teaminfo').first().text().replace(/\s+/g, ' ').trim(); if (ti) teamText += ' ' + ti;
      $tr.find('td.td-teaminfo h3 a').each((j, a) => { const tx = $(a).text().trim(); if (tx) links.push(tx); });
      const tv = lineNum($tr.find('td.td-bank-bet02')); if (tv && tot == null) tot = tv;
      const hv = lineNum($tr.find('td.td-bank-bet01')); if (hv && hd == null) hd = hv;
    }
    let away, home;
    const byKnown = teamsFromText(teamText);                                 // 已結束版面：用已知隊名比對(最穩)
    if (byKnown[0] && byKnown[1]) { away = byKnown[0]; home = byKnown[1]; }
    else if (links.length >= 2) { away = links[0]; home = links[1]; }        // 未開賽版面退路：各隊一個連結
    if (!away || !home) { skipped.push({ gameid: gid, teamText: teamText.trim().slice(0, 60) }); continue; }
    const totLine = tot != null ? parseFloat(tot) : null;
    out.push({
      key: `${dateDash}|${[away, home].sort().join('@')}|${time}`,
      date: dateDash, time, away, home,
      totLine: isNaN(totLine) ? null : totLine,
      hdAwayLine: hd != null ? parseFloat(hd) : null,
      gameid: gid,
    });
  }
  out.skipped = skipped; // 診斷用陣列屬性：JSON.stringify 不會帶出，僅供呼叫端檢視（把靜默丟棄變可見）
  return out;
}

async function fetchDay(date) {
  const r = await axios.get(URL(date), { headers: HEADERS, timeout: 20000, validateStatus: () => true });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return r.data;
}

async function main() {
  const st = arg('--selftest');
  if (st) {
    const date = String(st).replace(/-/g, '');
    const games = parseDay(await fetchDay(date), ymdDash(date));
    console.log(`自測 ${ymdDash(date)}：${games.length} 場`);
    games.slice(0, 8).forEach(g => console.log(`  ${g.time} ${g.away}@${g.home} | 大小線 ${g.totLine} | 讓分(客) ${g.hdAwayLine} | ${g.key}`));
    console.log(`有大小線: ${games.filter(g => g.totLine != null).length}/${games.length}`);
    const sk = games.skipped || [];
    if (sk.length) { console.log(`隊名未識別跳過 ${sk.length} 場：`); sk.slice(0, 5).forEach(s => console.log(`  ⚠ ${s.teamText}`)); }
    return;
  }
  const from = arg('--from'), to = arg('--to');
  if (!from || !to) { console.error('需要 --from --to（或 --selftest YYYY-MM-DD）'); process.exit(1); }
  const outPath = arg('--out', path.join('data', 'playsport_totals.json'));
  const donePath = outPath.replace(/\.json$/i, '') + '_done.json';   // 已完成日期側檔（斷點續補）
  const done = new Set((() => { try { return JSON.parse(fs.readFileSync(donePath, 'utf8')); } catch (e) { return []; } })());
  let dates = dateList(from, to);
  if (process.argv.includes('--seasononly')) dates = dates.filter(d => { const m = +d.slice(4, 6); return m >= 3 && m <= 11; }); // MLB 約 3~11 月（含季後賽）
  if (process.argv.includes('--resume')) dates = dates.filter(d => !done.has(d));
  const store = {};
  for (const g of (() => { try { return JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { return []; } })()) store[g.key] = g;
  let added = 0, withTot = 0, fail = 0;
  console.log(`運彩大小線回補 ${from}~${to}（${dates.length} 天）→ ${outPath}\n`);
  for (let i = 0; i < dates.length; i++) {
    try {
      const games = parseDay(await fetchDay(dates[i]), ymdDash(dates[i]));
      for (const g of games) { store[g.key] = g; added++; if (g.totLine != null) withTot++; }
      done.add(dates[i]);
      const sk = (games.skipped || []).length;
      console.log(`  ${dates[i]}  ${games.length} 場（有大小線 ${games.filter(g => g.totLine != null).length}${sk ? `，隊名未識別 ${sk}` : ''}）`);
      if (sk) games.skipped.slice(0, 2).forEach(s => console.warn(`    ⚠ 未識別: ${s.teamText}`));
    } catch (e) { fail++; console.warn(`  ${dates[i]} ⚠ ${e.message}`); }
    if (i % 10 === 9) { fs.writeFileSync(outPath, JSON.stringify(Object.values(store))); fs.writeFileSync(donePath, JSON.stringify([...done])); }
    await rndGap();
  }
  fs.writeFileSync(outPath, JSON.stringify(Object.values(store)));
  fs.writeFileSync(donePath, JSON.stringify([...done]));
  console.log(`\n完成。處理 ${added} 場列、有大小線 ${withTot}、失敗日 ${fail}。總計 ${Object.keys(store).length} 場 → ${outPath}`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
