/* ============================================================
   wnba_scraper.js — WNBA 每日管線（WNBA_PLAN.md T7）
   來源A: livescore/7（賽程+狀態+即時比分+節數+賽前台彩線;.outer-gamebox 標記體系=棒球同款,
          差異: oid 無時間尾碼(時間取 no_start_team .team_cinter)、比分 id={gid}_asr_big/_hsr_big、
          節數 {gid}_as1..5/_hs1..5、狀態 {gid}_inning_big）
   來源B: gamesData/result?allianceid=7（昨/今結算真相: 台彩讓分/大小線+mlOffered(td-bank-bet03)+終分;
          解析器=nba_lab/wnba_pull_ps.js parseDay,與季初回補同一支=口徑一致）
   輸出: data/wnba_pregame.json（KEEP_DAYS 滾動,officialId=WNBA_YYYYMMDD_客_主_HHMM 供板面/鬧鐘）
        data/wnba_lottery_series.json（台彩讓分方/線值變動序列,對調偵測）
   傳輸: sidecar_client（curl 優先,Cloudflare 挑戰自動切隱形瀏覽器）
   用法: node wnba_scraper.js [--selftest]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchText, shutdown } = require('./sidecar_client.js');
const { parseDay } = require('./nba_lab/wnba_pull_ps.js');
const { resolveHandicap } = require('./playsport_scraper.js');

const OUT = path.join('data', 'wnba_pregame.json');
const SERIES = path.join('data', 'wnba_lottery_series.json');
const KEEP_DAYS = 5;
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const num = (s) => { const m = /-?\d+(?:\.\d+)?/.exec(String(s == null ? '' : s).replace(/,/g, '')); return m ? parseFloat(m[0]) : null; };

function twDate(offset) {
  const d = new Date(Date.now() + 8 * 3600e3 + (offset || 0) * 86400e3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* livescore/7 單日解析 → 場次陣列 */
function extractLive(html, date) {
  const $ = cheerio.load(html);
  const out = [];
  $('.outer-gamebox[data-oid]').each((_, node) => {
    const $box = $(node);
    const oid = $box.attr('data-oid') || '';
    if (!/^WNBA_\d{8}_/.test(oid)) return;
    const $prev = $box.find('.js-gamePreviewBox').first();
    const $on = $box.find('.js-gameOnbox').first();
    const gid = (($box.attr('id') || '').match(/(\d+)$/) || [])[1] || null;
    const previewVisible = !((($prev.attr('style')) || '').includes('display:none'));

    // 隊名: 未開賽=no_start_team 連結文字(客左主右);開賽後=on-box data-namea/nameh
    let away = clean($on.attr('data-namea')), home = clean($on.attr('data-nameh'));
    if (!away || !home) {
      const t = $prev.find('table.no_start_team td a').toArray().map(a => clean($(a).text())).filter(Boolean);
      away = away || t[0] || null; home = home || t[1] || null;
    }
    const time = clean($prev.find('.team_cinter').first().text()) || null;   // 24h 台灣時間

    // 賽前台彩線: 兩張 no_start_datd_is(客,主) datd_s 欄;row0=讓分、row3=大小
    const isT = $prev.find('table.no_start_datd_is').toArray();
    const sCell = (tbl, rowIdx) => clean($(tbl).find('tr').eq(rowIdx).find('td.datd_s').text());
    const ahAwayRaw = isT[0] ? sCell(isT[0], 0) : null, ahHomeRaw = isT[1] ? sCell(isT[1], 0) : null;
    const totRaw = isT[0] ? sCell(isT[0], 3) : null;
    const hd = resolveHandicap({ ahAwayRaw, ahHomeRaw, awayTeam: away, homeTeam: home,
      aheadPrice: clean($on.attr('data-aheadprice')), winTeam: clean($on.find('.teamname_highlight').first().text()),
      betTxt: gid ? clean($on.find(`#${gid}_bet`).text()) : null });
    const totLine = num(totRaw);

    // 比分/節數/狀態
    const asr = gid ? num($on.find(`#${gid}_asr_big`).text()) : null;
    const hsr = gid ? num($on.find(`#${gid}_hsr_big`).text()) : null;
    const q = (pfx) => { const arr = []; for (let i = 1; i <= 5; i++) { const v = gid ? num($on.find(`#${gid}_${pfx}${i}`).text()) : null; arr.push(v); } while (arr.length && arr[arr.length - 1] == null) arr.pop(); return arr; };
    const onText = clean($on.text()) || '';
    const isFinished = /比賽結束|完場|終場|Final/.test(onText);
    const isPostponed = /比賽延期|比賽取消|比賽中止|延賽|順延|保留比賽|裁定/.test(onText);
    const status = isFinished ? 'finished' : isPostponed ? 'postponed' : (previewVisible ? 'upcoming' : 'inprogress');
    const inning = gid ? clean($on.find(`#${gid}_inning_big`).text()) : '';

    if (!away || !home) return;
    const hhmm = (time || '00:00').replace(':', '');
    out.push({
      officialId: `WNBA_${date.replace(/-/g, '')}_${away}_${home}_${hhmm}`,
      league: 'WNBA', date, time, away, home, oid, gid,
      status, inning: status === 'inprogress' ? inning : '',
      awayScore: (status === 'upcoming') ? null : asr,
      homeScore: (status === 'upcoming') ? null : hsr,
      qAway: (status === 'upcoming') ? [] : q('as'),
      qHome: (status === 'upcoming') ? [] : q('hs'),
      hdFav: hd && hd.src === '運彩' ? hd.favSide : (hd ? hd.favSide : null),
      hdVal: hd ? hd.line : null,
      hdSrc: hd ? hd.src : null,     // '運彩'=賽前線;'過盤'=on-box退路(僅結算參考,不可判顛倒)
      totLine
    });
  });
  return out;
}

function loadJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } }
function saveAtomic(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, f);
}

/* 台彩序列: 每場讓分方/線值/大小線變動才追加（對調偵測底料） */
function recordSeries(games, nowIso) {
  const s = loadJSON(SERIES, {});
  let changed = 0;
  for (const g of games) {
    if (g.hdSrc !== '運彩' && g.hdFav != null && g.status !== 'upcoming') continue;  // 只錄賽前線(運彩源);開賽後不再錄
    const key = g.officialId;
    const rows = s[key] = s[key] || [];
    const last = rows[rows.length - 1];
    const cur = { hdFav: g.hdFav || null, hdVal: g.hdVal == null ? null : g.hdVal, totLine: g.totLine == null ? null : g.totLine };
    if (!last || last.hdFav !== cur.hdFav || last.hdVal !== cur.hdVal || last.totLine !== cur.totLine) {
      rows.push({ t: nowIso, ...cur }); changed++;
    }
  }
  // 修剪: 只留 KEEP_DAYS 內
  const cutoff = twDate(-KEEP_DAYS).replace(/-/g, '');
  for (const k of Object.keys(s)) { const m = k.match(/^WNBA_(\d{8})_/); if (m && m[1] < cutoff) delete s[k]; }
  saveAtomic(SERIES, s);
  return changed;
}

(async () => {
  const selftest = process.argv.includes('--selftest');
  const nowIso = new Date().toISOString();
  const today = twDate(0), tomorrow = twDate(1), yesterday = twDate(-1);
  const all = [];

  // A. livescore 今+明
  for (const d of [today, tomorrow]) {
    const ymd = d.replace(/-/g, '');
    try {
      const html = await fetchText(`https://www.playsport.cc/livescore/7?gamedate=${ymd}&mode=1&`, H, 25000);
      const games = extractLive(html, d);
      all.push(...games);
      console.log(`livescore ${d}: ${games.length} 場`);
    } catch (e) { console.log(`❌ livescore ${d}: ${e.message}`); }
    await sleep(1200 + Math.random() * 800);
  }

  // B. result 頁(昨+今) → 結算真相覆蓋: 台彩線/mlOffered/終分（與季初回補同一解析器）
  for (const d of [yesterday, today]) {
    const ymd = d.replace(/-/g, '');
    try {
      const html = await fetchText(`https://www.playsport.cc/gamesData/result?allianceid=7&gametime=${ymd}`, H, 25000);
      const rows = parseDay(html);
      for (const p of rows) {
        const hit = all.find(g => g.date === d && g.away === p.away && g.home === p.home);
        const patch = {
          mlOffered: p.mlOffered !== false,
          hdFav: p.hdAwayLine == null ? null : (p.hdAwayLine < 0 ? 'away' : 'home'),
          hdVal: p.hdAwayLine == null ? null : Math.abs(p.hdAwayLine),
          totLine: p.totLine == null ? null : p.totLine, hdSrc: '運彩'
        };
        if (hit) {
          Object.assign(hit, patch);
          if (p.awayScore != null && hit.awayScore == null) { hit.awayScore = p.awayScore; hit.homeScore = p.homeScore; hit.status = 'finished'; }
        } else if (p.awayScore != null) {
          // 昨日場已不在 livescore 今明頁 → 直接補一筆(結算用)
          all.push({ officialId: `WNBA_${ymd}_${p.away}_${p.home}_${(p.time || '00:00').replace(':', '')}`,
            league: 'WNBA', date: d, time: p.time || null, away: p.away, home: p.home, oid: null, gid: p.gid,
            status: 'finished', inning: '', awayScore: p.awayScore, homeScore: p.homeScore, qAway: [], qHome: [], ...patch });
        }
      }
      console.log(`result ${d}: ${rows.length} 場（結算覆蓋）`);
    } catch (e) { console.log(`❌ result ${d}: ${e.message}`); }
    await sleep(1200 + Math.random() * 800);
  }

  if (selftest) { console.log(JSON.stringify(all, null, 1).slice(0, 3000)); shutdown(); return; }

  // C. merge: 舊檔留 KEEP_DAYS 內、本輪掃過日期整批取代（空頁防擦除: 本輪 0 筆且舊檔該日 >0 → 保留舊）
  const prev = loadJSON(OUT, { games: [] });
  const prevGames = Array.isArray(prev.games) ? prev.games : [];
  const scanned = new Set([today, tomorrow, yesterday]);
  const newByDate = {};
  for (const g of all) (newByDate[g.date] = newByDate[g.date] || []).push(g);
  const cutoff = twDate(-KEEP_DAYS);
  const merged = [];
  const oldByDate = {};
  for (const g of prevGames) if (g.date >= cutoff) (oldByDate[g.date] = oldByDate[g.date] || []).push(g);
  const dates = new Set([...Object.keys(newByDate), ...Object.keys(oldByDate)]);
  for (const d of dates) {
    if (scanned.has(d)) {
      const nw = newByDate[d] || [];
      if (!nw.length && (oldByDate[d] || []).length) { merged.push(...oldByDate[d]); continue; }  // 翻空保舊
      merged.push(...nw);
    } else merged.push(...(oldByDate[d] || []));
  }
  merged.sort((a, b) => (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1);
  const seriesChanged = recordSeries(all.filter(g => scanned.has(g.date)), nowIso);
  saveAtomic(OUT, { updated: nowIso, count: merged.length, games: merged });
  console.log(`=== ${OUT}: ${merged.length} 場｜序列變動 ${seriesChanged} 筆`);
  shutdown();
})();
