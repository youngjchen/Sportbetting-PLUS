/* ============================================================
   wnba_titan_odds.js — WNBA Bet365 變盤序列（WNBA_PLAN.md T8）
   來源: nba.titan007.com 月檔(枚舉今明 ScheId) + odds/Handicap.aspx / odds/OverDownChart.aspx (companyId=8)
   輸出: data/wnba_odds_log.json = { updated, games: { [officialId]: {scheId,date,away,home,hd:[{t,line,o1,o2}],ou:[...] } } }
   語義: rows[0]=最新（titan prepend 鐵則,棒球 7/23 釘死）;讓分線 負=客讓（wnba_join_audit 實證,月檔同義）
   隊名: wnba_team_map.json titanId→玩運彩短名（=板面/賽程檔隊名）
   節流: 今明場次 ×2 端點,~1s 抖動;titan 無 WAF,node fetch 直連
   用法: node wnba_titan_odds.js [--selftest]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join('data', 'wnba_odds_log.json');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', 'Referer': 'https://nba.titan007.com/' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const KEEP_DAYS = 5;

function twDate(offset) {
  const d = new Date(Date.now() + 8 * 3600e3 + (offset || 0) * 86400e3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
async function fetchText(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try { const r = await fetch(url, { headers: H, signal: c.signal }); if (r.status !== 200) throw new Error('HTTP ' + r.status); return await r.text(); }
  finally { clearTimeout(t); }
}
function loadJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } }

/* 月檔 arrData 枚舉（同 wnba_pull_titan 映射;這裡只要 id/時間/隊） */
function parseMonth(js) {
  const c = js.replace(/^﻿/, '');
  const m = c.match(/arrData\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  const rows = m[1].match(/\[[^\[\]]+\]/g) || [];
  return rows.map(r => {
    const f = r.slice(1, -1).split(',');
    return { scheId: +f[0], timeBJ: (f[2] || '').replace(/'/g, ''), homeId: +f[3], awayId: +f[4] };  // teamA=主(實證)
  }).filter(g => g.scheId && g.timeBJ);
}

/* 變盤頁: <tr> 抽 [數字/時間] 樣式;支援「o1|line|o2|M-D HH:mm」與「M-D HH:mm|line」兩型;輸出保持頁面順序(新→舊) */
function parseChangeRows(html) {
  const out = [];
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  for (const tr of trs) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || []).map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    const flat = cells.filter(c => c !== '');
    if (!flat.length) continue;
    const tIdx = flat.findIndex(c => /^\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.test(c));
    if (tIdx < 0) continue;
    const nums = flat.filter((c, i) => i !== tIdx && /^-?\d+(?:\.\d+)?$/.test(c)).map(Number);
    if (!nums.length) continue;
    const t = flat[tIdx];
    if (nums.length >= 3) out.push({ t, line: nums[1], o1: nums[0], o2: nums[2] });
    else out.push({ t, line: nums[0] });
  }
  return out;
}

(async () => {
  const selftest = process.argv.includes('--selftest');
  const today = twDate(0), tomorrow = twDate(1);
  const months = new Set([today.slice(0, 7), tomorrow.slice(0, 7)]);
  const games = [];
  for (const ym of months) {
    const [y, m] = ym.split('-').map(Number);
    try { games.push(...parseMonth(await fetchText(`https://nba.titan007.com/jsData/matchResult/26/l2_1_${y}_${m}.js`))); }
    catch (e) { console.log(`❌ 月檔 ${ym}: ${e.message}`); }
    await sleep(700);
  }
  const targets = games.filter(g => { const d = g.timeBJ.slice(0, 10); return d === today || d === tomorrow; });
  const tmap = loadJSON(path.join('nba_lab', 'wnba_team_map.json'), { teams: [] });
  const psName = {}; for (const t of tmap.teams) psName[t.titanId] = t.psName;
  const pregame = loadJSON(path.join('data', 'wnba_pregame.json'), { games: [] });
  const oidOf = (date, away, home) => {
    const hit = (pregame.games || []).find(g => g.date === date && g.away === away && g.home === home);
    return hit ? hit.officialId : `${date}|${away}|${home}`;
  };

  const prev = loadJSON(OUT, { games: {} });
  const store = {};
  const cutoff = twDate(-KEEP_DAYS);
  for (const k of Object.keys(prev.games || {})) {
    const d = (prev.games[k].date || '');
    if (d >= cutoff) store[k] = prev.games[k];
  }

  let ok = 0, noName = 0;
  for (const g of targets) {
    const date = g.timeBJ.slice(0, 10);
    const home = psName[g.homeId], away = psName[g.awayId];
    if (!home || !away) { noName++; console.log(`⚠️ 無隊名對照: titanId ${g.homeId}/${g.awayId}（新隊? 補 wnba_team_map）`); continue; }
    try {
      const hdHtml = await fetchText(`https://nba.titan007.com/odds/Handicap.aspx?ScheId=${g.scheId}&companyId=8`);
      await sleep(600 + Math.random() * 500);
      const ouHtml = await fetchText(`https://nba.titan007.com/odds/OverDownChart.aspx?scheId=${g.scheId}&companyId=8&num=1&t=1`);
      const hd = parseChangeRows(hdHtml), ou = parseChangeRows(ouHtml);
      // 獨贏歐指（2026-08-04 使用者指定接入）：/1x2/data1x2/{d0}/{d12}/{id}.js
      // var game=Array("公司id|oddsId||初主|初客|...|現主|現客|...|時間|名*|..") ;公司 214=Bet365（已用美夢讓1.5方向驗證 主客欄序）
      let ml = null;
      try {
        await sleep(500 + Math.random() * 400);
        const sid = String(g.scheId);
        const oddsJs = await fetchText(`https://nba.titan007.com/1x2/data1x2/${sid[0]}/${sid.slice(1, 3)}/${sid}.js`);
        const gm = oddsJs.match(/var game=Array\(([\s\S]*?)\);/);
        if (gm) {
          for (const row of gm[1].match(/"[^"]+"/g) || []) {
            const f = row.replace(/^"|"$/g, '').split('|');
            if (f[0] === '214') {   // Bet365
              ml = { openH: parseFloat(f[3]) || null, openA: parseFloat(f[4]) || null,
                     curH: parseFloat(f[8]) || null, curA: parseFloat(f[9]) || null, t: f[15] || null };
              break;
            }
          }
        }
      } catch (e2) { console.log(`  ⚠ 1x2 scheId ${g.scheId}: ${e2.message}`); }
      store[oidOf(date, away, home)] = { scheId: g.scheId, date, away, home, startBJ: g.timeBJ, hd, ou, ml };
      ok++;
      console.log(`✅ ${date} ${away}@${home} scheId=${g.scheId} hd=${hd.length} ou=${ou.length} ml=${ml ? (ml.curH + '/' + ml.curA) : '無'}`);
    } catch (e) { console.log(`❌ scheId ${g.scheId}: ${e.message}`); }
    await sleep(600 + Math.random() * 500);
  }
  if (selftest) { console.log(JSON.stringify(Object.values(store)[0] || {}, null, 1).slice(0, 1200)); return; }
  const tmpF = OUT + '.tmp';
  fs.writeFileSync(tmpF, JSON.stringify({ updated: new Date().toISOString(), games: store }, null, 1));
  fs.renameSync(tmpF, OUT);
  console.log(`=== ${OUT}: ${Object.keys(store).length} 場（本輪抓 ${ok}｜無對照 ${noName}）`);
})();
