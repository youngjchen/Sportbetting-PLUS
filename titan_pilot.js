// titan_pilot.js — 回補守門 pilot：自動判定(bet365 vs 台彩軸) vs 使用者手標 flipState 對答案
//
// ⚠ 軸聲明：本工具判定的是「國際盤(titan007 bet365) vs 台彩(玩運彩運彩盤)」關係，
//   與使用者手標時實際盯的 STAKE 是不同平台——結論不得外推到 STAKE（使用者明令）。
//   比對目的＝驗證解析與判定管線的正確率，通過才准回補 4/1-6/26。
//
// 方向語義（2026-07-10 考據定案）：
//   · titan007 讓分變動表：主隊在左；盤口带正負號 → 正=主讓、負=客讓（符號=權威）
//   · HK 賠率 +1 = decimal；高賠率側=讓分方 僅當旁證（大熱門區會反轉，一致率 85-92%）
//   · 变化时间欄含「走地」= 開賽後盤，排除；序列時間戳保留
//   · 1x2 js：c[3]/c[4]=開盤 主/客、c[8]/c[9]=收盤 主/客（decimal）
//   · 玩運彩台彩側：pregame_data.json git 歷史（~9分/格），只認 src='運彩'
//
// 用法： node titan_pilot.js enum     → 291 場 ↔ titan id 配對
//        node titan_pilot.js fetch    → 抓 hd/ou/ml（快取、0.9s 節流、可續跑）
//        node titan_pilot.js lottery  → git 回放台彩序列
//        node titan_pilot.js label    → 自動判定＋對答案＋出報告
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { execSync } = require('child_process');
const axios = require('axios'), vm = require('vm');

const DIR = path.join('divination_lab', 'titan_pilot');
const CACHE = path.join(DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://sports.titan007.com/' };
const GAP_MS = 900;
const LEAGUES_CFG = [ { key: 'mlb', id: 1 }, { key: 'npb', id: 2 }, { key: 'kbo', id: 17 }, { key: 'cpbl', id: 5 } ];
const WIN_LO = '2026-06-27', WIN_HI = '2026-07-10';   // pilot 窗＝手標樣本窗
const PERSIST_MIN = 30;                               // 規則0：狀態需持續 ≥30 分鐘

// ---- 隊名對照：直接從 index.js 原始碼切出 LEAGUE_TEAMS（單一事實來源）----
function loadLeagueTeams() {
  const src = fs.readFileSync('index.js', 'utf8');
  const m = src.match(/const LEAGUE_TEAMS = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error('index.js 中找不到 LEAGUE_TEAMS');
  const sb = {}; vm.createContext(sb);
  vm.runInContext('T=' + m[1], sb);
  const T = sb.T;
  // 玩運彩頁面短名補充（extractTwoTeams 用正向包含，index.js 字典缺這些頁面寫法）
  const extra = { kbo: { 'LG雙子': ['雙子'], 'NC恐龍': ['恐龍'], 'SSG登陸者': ['登陸者'], 'KT巫師': ['巫師'], '韓華鷹': ['華老鷹'], '培證英雄': ['英雄'] } };
  for (const lg of Object.keys(extra)) for (const std of Object.keys(extra[lg])) if (T[lg] && T[lg][std]) T[lg][std].push(...extra[lg][std]);
  return T;
}
function resolveName(teams, league, titanName) {
  const dict = teams[league]; if (!dict || !titanName) return null;
  for (const std of Object.keys(dict)) {
    if (dict[std].some(alias => titanName.includes(alias))) return std;
  }
  // 反向包含（feed 短名如「雙子」⊂ 別名「LG雙子」）；限 ≥2 字防誤中
  for (const std of Object.keys(dict)) {
    if (titanName.length >= 2 && dict[std].some(alias => alias.includes(titanName))) return std;
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (f, v) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(v, null, 1));
const R = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

// ---- 讀盤面手標樣本 -------------------------------------------------------
function boardTargets() {
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join('state', 'board_state.json.gz'))));
  return (doc.games || []).filter(g => g.flipState && g.awayScore != null && g.homeScore != null
    && g.date >= WIN_LO && g.date <= WIN_HI);
}

// ---- stage: enum -----------------------------------------------------------
async function stageEnum() {
  const teams = loadLeagueTeams();
  const targets = boardTargets();
  console.log(`手標樣本（${WIN_LO}~${WIN_HI}）：${targets.length} 場`);
  const titan = [];
  for (const lg of LEAGUES_CFG) {
    for (const mo of [6, 7]) {
      const url = `https://sports.titan007.com/jsData/baseball/matchResult/2026/l${lg.id}_1_2026_${mo}.js`;
      try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const sb = {}; vm.createContext(sb); vm.runInContext(res.data, sb);
        const dict = {}; (sb.arrTeam || []).forEach(t => { dict[t[0]] = t[2]; });
        for (const m of (sb.arrData || [])) {
          const time = String(m[2]);                       // GMT+8
          const date = time.slice(0, 10);
          if (date < WIN_LO || date > WIN_HI) continue;
          titan.push({
            id: m[0], league: lg.key, time, date,
            homeRaw: dict[m[3]] || '', awayRaw: dict[m[4]] || '',
            home: resolveName(teams, lg.key, dict[m[3]] || ''), away: resolveName(teams, lg.key, dict[m[4]] || ''),
            closeHd: m[7] != null ? String(m[7]) : null, closeOu: m[8] != null ? String(m[8]) : null
          });
        }
        await sleep(GAP_MS);
      } catch (e) { console.log(`  ⚠️ ${url} ${e.message}`); }
    }
  }
  console.log(`titan 窗內比賽：${titan.length} 場`);
  const matches = [], unmatched = [], ambiguous = [];
  for (const g of targets) {
    const cands = titan.filter(t => t.league === g.league && t.date === g.date && t.home === g.homeTeam && t.away === g.awayTeam);
    if (cands.length === 1) matches.push({ sid: g.sid, titanId: cands[0].id, league: g.league, date: g.date, away: g.awayTeam, home: g.homeTeam, startTime: cands[0].time, closeHdSched: cands[0].closeHd, closeOuSched: cands[0].closeOu, hand: { flipState: g.flipState, preGameSwap: !!g.preGameSwap, hdFav: g.hdFav, hdVal: g.hdVal, totVal: g.totVal, closeOddsAway: g.closeOddsAway, closeOddsHome: g.closeOddsHome, flipOddsAway: g.flipOddsAway, flipOddsHome: g.flipOddsHome } });
    else if (cands.length === 0) unmatched.push({ sid: g.sid, league: g.league, date: g.date, away: g.awayTeam, home: g.homeTeam, flipState: g.flipState });
    else ambiguous.push({ sid: g.sid, date: g.date, away: g.awayTeam, home: g.homeTeam, n: cands.length });
  }
  J('matches.json', { matches, unmatched, ambiguous });
  console.log(`配對成功 ${matches.length}｜對不上 ${unmatched.length}｜雙重賽模糊 ${ambiguous.length}`);
  if (unmatched.length) console.log('對不上樣本:', JSON.stringify(unmatched.slice(0, 8)));
  if (ambiguous.length) console.log('模糊:', JSON.stringify(ambiguous));
}

// ---- stage: fetch ----------------------------------------------------------
async function stageFetch() {
  const { matches } = R('matches.json');
  let done = 0, skip = 0, fail = 0;
  for (const m of matches) {
    for (const [kind, url] of [
      ['hd', `https://sports.titan007.com/ChangeDetail/handicap.aspx?id=${m.titanId}&companyid=8&t=2`],
      ['ou', `https://sports.titan007.com/ChangeDetail/overunder.aspx?id=${m.titanId}&companyid=8&t=2`],
      ['ml', `https://sports.titan007.com/jsData/baseball/1x2/${m.titanId}.js`]
    ]) {
      const f = path.join(CACHE, `${m.titanId}_${kind}.txt`);
      if (fs.existsSync(f) && fs.statSync(f).size > 100) { skip++; continue; }
      try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        fs.writeFileSync(f, typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
        done++;
      } catch (e) { fail++; console.log(`  ❌ ${m.titanId} ${kind}: ${e.message}`); }
      await sleep(GAP_MS);
    }
    if ((done + skip) % 60 === 0) console.log(`  進度 抓${done} 快取${skip} 失敗${fail}`);
  }
  console.log(`fetch 完成：新抓 ${done}、已快取 ${skip}、失敗 ${fail}`);
}

// ---- stage: lottery（git 回放台彩序列）------------------------------------
function stageLottery() {
  const teams = loadLeagueTeams();
  const { matches } = R('matches.json');
  const want = new Map();  // key league|date|away|home（canonical）→ sid
  for (const m of matches) want.set(`${m.league}|${m.date}|${m.away}|${m.home}`, m.sid);
  const series = {};       // sid → [{t(epoch s), favSide, line}]
  const unresolved = new Set();
  const commits = execSync('git log --reverse --format="%H %ct" --since=2026-06-26 -- data/pregame_data.json', { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').map(l => { const [h, t] = l.split(' '); return { h, t: parseInt(t, 10) }; });
  console.log(`pregame git 快照：${commits.length} 格`);
  let i = 0;
  for (const c of commits) {
    let arr;
    try { arr = JSON.parse(execSync(`git show ${c.h}:data/pregame_data.json`, { encoding: 'utf8', maxBuffer: 1 << 26 })); }
    catch (e) { continue; }
    const list = Array.isArray(arr) ? arr : Object.values(arr);
    for (const g of list) {
      const lh = g.lotteryHandicap;
      if (!lh || lh.src !== '運彩' || !lh.favSide) continue;
      const lg = String(g.league || '').toLowerCase();
      const away = resolveName(teams, lg, g.awayTeam), home = resolveName(teams, lg, g.homeTeam);
      if (!away && g.awayTeam) unresolved.add(lg + ':' + g.awayTeam);
      if (!home && g.homeTeam) unresolved.add(lg + ':' + g.homeTeam);
      const sid = want.get(`${lg}|${g.date}|${away}|${home}`); if (!sid) continue;
      const s = series[sid] = series[sid] || [];
      const last = s[s.length - 1];
      if (!last || last.favSide !== lh.favSide || last.line !== lh.line) s.push({ t: c.t, favSide: lh.favSide, line: lh.line });
      else last.tLast = c.t;                            // 同狀態延續，記錄最後見到時間
    }
    if (++i % 300 === 0) console.log(`  回放 ${i}/${commits.length}`);
  }
  J('lottery_series.json', series);
  const withData = Object.keys(series).length;
  console.log(`lottery 完成：${withData}/${matches.length} 場有台彩序列`);
  if (unresolved.size) console.log('未對應 feed 隊名：', [...unresolved].join('、'));
}

// ---- 解析工具 ---------------------------------------------------------------
function parseChangeTable(html, year) {
  const m = html.match(/id=['"]?odds2['"]?[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!m) return null;
  const rows = [];
  for (const r of m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(td => td[1].replace(/<[^>]+>/g, '').trim());
    if (tds.length < 4 || isNaN(parseFloat(tds[0]))) continue;   // 跳表頭
    const live = /走地/.test(tds[3]);
    const tm = tds[3].match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    const t = tm ? Date.parse(`${year}-${String(tm[1]).padStart(2, '0')}-${String(tm[2]).padStart(2, '0')}T${String(tm[3]).padStart(2, '0')}:${tm[4]}:00+08:00`) / 1000 : null;
    rows.push({ home: parseFloat(tds[0]), line: parseFloat(tds[1]), away: parseFloat(tds[2]), t, live });
  }
  rows.reverse();                                       // 由舊到新
  return rows.length ? rows : null;
}
// 方向序列壓縮＋持續性門檻（規則0）：只留「持續≥PERSIST_MIN 或為收盤態」的方向變化
function compressDir(points, closeT) {                   // points: [{t, dir}] 由舊到新
  const chg = [];
  for (const p of points) {
    if (!p.dir || p.t == null) continue;
    if (!chg.length || chg[chg.length - 1].dir !== p.dir) chg.push({ t: p.t, dir: p.dir });
  }
  const kept = [];
  for (let i = 0; i < chg.length; i++) {
    const end = i + 1 < chg.length ? chg[i + 1].t : closeT;
    const dur = (end - chg[i].t) / 60;
    const isFinal = i === chg.length - 1;
    if (dur >= PERSIST_MIN || isFinal) kept.push(chg[i]);
  }
  // 相鄰同向合併
  const out = [];
  for (const k of kept) { if (!out.length || out[out.length - 1].dir !== k.dir) out.push(k); }
  return out;
}
function sideAt(seq, t) {                                // seq=[{t,dir}]由舊到新
  let cur = null;
  for (const s of seq) { if (s.t <= t) cur = s.dir; else break; }
  return cur;
}

// ---- stage: label ----------------------------------------------------------
function stageLabel() {
  const { matches, unmatched, ambiguous } = R('matches.json');
  const lot = R('lottery_series.json');
  const rows = [];
  for (const m of matches) {
    const year = m.date.slice(0, 4);
    const startT = Date.parse(m.startTime.replace(' ', 'T') + ':00+08:00') / 1000;
    const out = { ...m, auto: {}, note: [] };
    // 國際側（bet365 hd）
    let hdRows = null;
    try { hdRows = parseChangeTable(fs.readFileSync(path.join(CACHE, `${m.titanId}_hd.txt`), 'utf8'), year); } catch (e) {}
    const pre = (hdRows || []).filter(r => !r.live && r.t != null && r.t <= startT + 10 * 60);
    const intlPoints = pre.map(r => ({ t: r.t, dir: r.line > 0 ? 'home' : (r.line < 0 ? 'away' : null), line: r.line }));
    const intlSeq = compressDir(intlPoints, startT);
    const intlClose = pre.length ? pre[pre.length - 1] : null;
    const intlCloseDir = intlClose ? (intlClose.line > 0 ? 'home' : intlClose.line < 0 ? 'away' : null) : null;
    // 台彩側
    const ls = (lot[m.sid] || []).filter(p => p.t <= startT + 10 * 60);
    const lotSeq = compressDir(ls.map(p => ({ t: p.t, dir: p.favSide })), startT);
    const lotClose = ls.length ? ls[ls.length - 1] : null;
    // 大小收盤（QA 用）
    let ouClose = null;
    try {
      const ouRows = parseChangeTable(fs.readFileSync(path.join(CACHE, `${m.titanId}_ou.txt`), 'utf8'), year);
      const ouPre = (ouRows || []).filter(r => !r.live && r.t != null && r.t <= startT + 10 * 60);
      if (ouPre.length) ouClose = Math.abs(ouPre[ouPre.length - 1].line);
    } catch (e) {}
    // 獨贏（bet365 開/收）
    let mlOpen = null, mlClose = null;
    try {
      const sb = {}; vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(CACHE, `${m.titanId}_ml.txt`), 'utf8'), sb);
      const b = (sb.game || []).map(x => x.split('|')).find(c => (c[16] || '').toLowerCase().includes('36'));
      if (b) { mlOpen = { home: parseFloat(b[3]), away: parseFloat(b[4]) }; mlClose = { home: parseFloat(b[8] || b[3]), away: parseFloat(b[9] || b[4]) }; }
    } catch (e) {}
    // --- 自動判定 ---
    if (!intlSeq.length) out.note.push('無國際賽前序列');
    if (!lotSeq.length) out.note.push('無台彩序列');
    out.auto.swapIntl = intlSeq.length > 1;
    out.auto.swapLottery = lotSeq.length > 1;
    out.auto.intlCloseDir = intlCloseDir; out.auto.lotCloseDir = lotClose ? lotClose.favSide : null;
    out.auto.intlCloseLine = intlClose ? Math.abs(intlClose.line) : null;
    out.auto.lotCloseLine = lotClose ? lotClose.line : null;
    out.auto.ouCloseLine = ouClose;
    out.auto.mlCloseFav = (mlClose && Math.abs(mlClose.home - mlClose.away) >= 0.10) ? (mlClose.home < mlClose.away ? 'home' : 'away') : null;
    out.auto.divergeIntl = (out.auto.mlCloseFav && intlCloseDir) ? (out.auto.mlCloseFav !== intlCloseDir) : null;
    if (intlSeq.length && lotSeq.length && intlCloseDir && out.auto.lotCloseDir) {
      // 曾相反：合併事件時間軸逐段比對，累計最長相反持續
      const evts = [...intlSeq.map(s => s.t), ...lotSeq.map(s => s.t)].sort((a, b) => a - b);
      let maxOpp = 0, oppStart = null, lastOppEnd = null, moverAfterOpp = null;
      for (let i = 0; i < evts.length; i++) {
        const t0 = evts[i], t1 = i + 1 < evts.length ? evts[i + 1] : startT;
        const a = sideAt(intlSeq, t0), b = sideAt(lotSeq, t0);
        const opp = a && b && a !== b;
        if (opp) { if (oppStart == null) oppStart = t0; maxOpp = Math.max(maxOpp, (t1 - oppStart) / 60); lastOppEnd = t1; }
        else if (oppStart != null) { oppStart = null; }
      }
      const everOpp = maxOpp >= PERSIST_MIN;
      const closeOpp = intlCloseDir !== out.auto.lotCloseDir;
      if (closeOpp) out.auto.flipState = 'flipped';
      else if (everOpp) {
        // 收斂方向＝相反段結束後是誰改了方向（比對相反段末的兩側 vs 收盤）
        const aEnd = sideAt(intlSeq, lastOppEnd - 1), bEnd = sideAt(lotSeq, lastOppEnd - 1);
        if (aEnd !== intlCloseDir && bEnd === out.auto.lotCloseDir) out.auto.flipState = 'converged_intl';
        else if (bEnd !== out.auto.lotCloseDir && aEnd === intlCloseDir) out.auto.flipState = 'converged_lottery';
        else out.auto.flipState = 'converged_unknown';
      }
      else out.auto.flipState = 'none';
      out.auto.maxOppMin = Math.round(maxOpp);
    } else out.auto.flipState = 'na';
    rows.push(out);
  }
  // ---- 對答案 ----
  const fam = s => /^converged/.test(s) ? 'converged' : s;
  const judged = rows.filter(r => r.auto.flipState !== 'na');
  const agree3 = judged.filter(r => fam(r.auto.flipState) === fam(r.hand.flipState)).length;
  const exact = judged.filter(r => r.auto.flipState === r.hand.flipState || (fam(r.auto.flipState) === 'converged' && r.hand.flipState === 'converged_unknown')).length;
  const dis = judged.filter(r => fam(r.auto.flipState) !== fam(r.hand.flipState));
  const mtx = {};
  for (const r of judged) { const k = fam(r.hand.flipState) + '→' + fam(r.auto.flipState); mtx[k] = (mtx[k] || 0) + 1; }
  // swap（不同軸，資訊性）
  const swapBoth = judged.filter(r => r.hand.preGameSwap && (r.auto.swapIntl || r.auto.swapLottery)).length;
  const swapHandOnly = judged.filter(r => r.hand.preGameSwap && !(r.auto.swapIntl || r.auto.swapLottery)).length;
  const swapAutoOnly = judged.filter(r => !r.hand.preGameSwap && (r.auto.swapIntl || r.auto.swapLottery)).length;
  // 線值 QA
  const hdDiff = judged.filter(r => r.auto.intlCloseLine != null && r.hand.hdVal != null).map(r => Math.abs(r.auto.intlCloseLine - Math.abs(r.hand.hdVal)));
  const ouDiff = judged.filter(r => r.auto.ouCloseLine != null && r.hand.totVal != null).map(r => Math.abs(r.auto.ouCloseLine - r.hand.totVal));
  const eq0 = a => a.filter(x => x === 0).length;
  const rep = [];
  rep.push(`# titan007 回補 pilot 對答案報告（${new Date().toISOString().slice(0, 10)}）`);
  rep.push(`\n⚠ 軸聲明：自動判定＝bet365(國際) vs 台彩；使用者手標時盯的是 STAKE。此比對驗證管線正確率，**不證明 STAKE 行為**。\n`);
  rep.push(`## 樣本`);
  rep.push(`- 手標窗內 ${rows.length + unmatched.length + ambiguous.length} 場：titan 配對成功 ${rows.length}、對不上 ${unmatched.length}、雙重賽模糊 ${ambiguous.length}`);
  rep.push(`- 可自動判定（兩側序列齊）${judged.length} 場、資料不足(na) ${rows.length - judged.length} 場`);
  rep.push(`\n## flipState 對答案（家族層級：flipped/converged/none）`);
  rep.push(`- 家族一致：**${agree3}/${judged.length}＝${(100 * agree3 / judged.length).toFixed(1)}%**；含收斂方向全等：${exact}/${judged.length}`);
  rep.push(`- 混淆矩陣（手標→自動）：${JSON.stringify(mtx)}`);
  rep.push(`\n## 不一致清單（逐場，供裁決——自動判可能才是對的，也可能解析錯）`);
  for (const r of dis) rep.push(`- ${r.date} ${r.away}@${r.home}［${r.league}］手標=${r.hand.flipState}｜自動=${r.auto.flipState}（相反持續${r.auto.maxOppMin ?? '—'}分；國際收盤=${r.auto.intlCloseDir}/台彩收盤=${r.auto.lotCloseDir}；${r.note.join('、') || '序列齊'}）`);
  rep.push(`\n## 對調（不同軸，僅資訊性——手標=你盯 STAKE；自動=國際或台彩側）`);
  rep.push(`- 兩邊都有 ${swapBoth}｜只有手標 ${swapHandOnly}｜只有自動 ${swapAutoOnly}`);
  rep.push(`\n## 背離（國際盤內，資訊性）`);
  const dvY = judged.filter(r => r.auto.divergeIntl === true).length, dvN = judged.filter(r => r.auto.divergeIntl === false).length;
  rep.push(`- 自動背離 ${dvY}／不背離 ${dvN}／不可判 ${judged.length - dvY - dvN}`);
  rep.push(`\n## 線值 QA（自動收盤線 vs 你卡片上的線；你的線=STAKE，僅代理對照）`);
  rep.push(`- 讓分線：可比 ${hdDiff.length} 場，完全相等 ${eq0(hdDiff)}（${hdDiff.length ? (100 * eq0(hdDiff) / hdDiff.length).toFixed(0) : 0}%），差≥1 ${hdDiff.filter(x => x >= 1).length}`);
  rep.push(`- 大小線：可比 ${ouDiff.length} 場，完全相等 ${eq0(ouDiff)}（${ouDiff.length ? (100 * eq0(ouDiff) / ouDiff.length).toFixed(0) : 0}%），差≥1 ${ouDiff.filter(x => x >= 1).length}`);
  rep.push(`\n## 回補涵蓋預告（若通過）`);
  rep.push(`- 每場可得：國際讓分方向序列(ts+走地濾)、收盤讓分線、收盤大小線、bet365 開/收盤獨贏 → 讓分過盤/開大/獨贏三市場都可算（比分由 MLB API/matchResult 取）`);
  fs.writeFileSync(path.join(DIR, 'PILOT_REPORT.md'), rep.join('\n'));
  J('labeled.json', rows);
  console.log(rep.join('\n'));
}

// ============================================================================
// v2 修正（2026-07-11）：pregame feed 的 lotteryHandicap 實測為「開盤一次性快照」
// （287/287 場零變動、距開賽中位 16.2h）→ 不可當台彩收盤。
// 台彩收盤權威源改為玩運彩「賽事結果頁」(playsport.cc/gamesData/result)，
// 判定改端點代數：intl 開/收（bet365 序列）× 台彩 開（feed 首值）/收（playsport）。
// ============================================================================
const PS_HEADERS = { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://www.playsport.cc/', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const PS_URL = (aid, ymd) => `https://www.playsport.cc/gamesData/result?allianceid=${aid}&gametime=${ymd}`;
const psGap = () => sleep(4000 + Math.floor(Math.random() * 3000));

// 每場=兩個 tr[gameid]，但隊名擠在同一個 td-teaminfo（含比分「7 V.S. 1 海盜 國民」）
// → 用「位置序」抽兩個已知隊名（同 playsport_totals.js 法）；讓分格全文自帶「客-1.5, 1.75」
// → 方向直接讀 客/主 前綴，不賭列序。
function extractTwoTeams(teams, league, text) {
  const dict = teams[league]; if (!dict) return [null, null];
  const found = [];
  for (const std of Object.keys(dict)) {
    let best = -1;
    for (const alias of dict[std]) { const i = text.indexOf(alias); if (i >= 0 && (best < 0 || i < best)) best = i; }
    if (best >= 0) found.push([best, std]);
  }
  found.sort((a, b) => a[0] - b[0]);
  return [found[0] && found[0][1], found[1] && found[1][1]];
}
function parsePsDay(html, league, teams) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const byGame = {};
  $('table.gamedata-results tr[gameid]').each((i, tr) => { const $tr = $(tr); const gid = $tr.attr('gameid'); if (gid) (byGame[gid] = byGame[gid] || []).push($tr); });
  const out = [];
  for (const gid in byGame) {
    const rows = byGame[gid];
    let time = '', tot = null, hdAway = null, teamText = '';
    rows.forEach(($tr) => {
      const t = $tr.find('td.td-gameinfo h4').first().text().trim();
      if (t && !time) { const m = /(AM|PM)?\s*(\d{1,2}):(\d{2})/i.exec(t); if (m) { let h = +m[2]; const ap = (m[1] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; time = `${String(h).padStart(2, '0')}:${m[3]}`; } }
      teamText += ' ' + $tr.find('td.td-teaminfo').text().replace(/\s+/g, ' ').trim();
      const tv = $tr.find('td.td-bank-bet02 .data-wrap > strong').first().text().trim(); if (tv && tot == null) tot = tv;
      if (hdAway == null) {
        const cellTxt = $tr.find('td.td-bank-bet01').text().replace(/\s+/g, '');
        const hm = /([客主])(受讓)?([+-]?\d+(?:\.\d+)?)/.exec(cellTxt);
        if (hm) { let v = parseFloat(hm[3]); if (hm[2]) v = Math.abs(v); /* 受讓=拿分,對客=正 */ if (hm[1] === '主') v = -v; hdAway = v; }
      }
    });
    const [away, home] = extractTwoTeams(teams, league, teamText);
    if (!away || !home || away === home) continue;
    const sm = /(\d+)\s*V\.?S\.?\s*(\d+)/i.exec(teamText);            // 「7 V.S. 1」＝客分 V.S. 主分（客列在前）
    out.push({ league, away, home, time, totLine: tot != null ? parseFloat(tot) : null, hdAwayLine: (hdAway != null && !isNaN(hdAway)) ? hdAway : null,
      awayScore: sm ? parseInt(sm[1], 10) : null, homeScore: sm ? parseInt(sm[2], 10) : null });
  }
  return out;
}

async function stagePsProbe() {
  const teams = loadLeagueTeams();
  for (let aid = 1; aid <= 12; aid++) {
    try {
      const r = await axios.get(PS_URL(aid, '20260705'), { headers: PS_HEADERS, timeout: 20000, validateStatus: () => true });
      if (r.status !== 200) { console.log(`aid=${aid} HTTP ${r.status}`); await psGap(); continue; }
      const hits = {};
      for (const lg of ['mlb', 'npb', 'kbo', 'cpbl']) hits[lg] = parsePsDay(r.data, lg, teams).length;
      console.log(`aid=${aid} 解析場數:`, JSON.stringify(hits));
    } catch (e) { console.log(`aid=${aid} ERR ${e.message}`); }
    await psGap();
  }
}

async function stagePsClose() {
  const teams = loadLeagueTeams();
  const AIDS = JSON.parse(process.env.PS_AIDS || '{"mlb":1}');   // 探測後由環境變數傳入
  const { matches } = R('matches.json');
  const days = [...new Set(matches.map(m => m.date))].sort();
  const store = {};
  for (const d of days) {
    const ymd = d.replace(/-/g, '');
    for (const [lg, aid] of Object.entries(AIDS)) {
      const cacheF = path.join(CACHE, `ps_${aid}_${ymd}.html`);
      let html;
      if (fs.existsSync(cacheF) && fs.statSync(cacheF).size > 500) html = fs.readFileSync(cacheF, 'utf8');
      else {
        try { const r = await axios.get(PS_URL(aid, ymd), { headers: PS_HEADERS, timeout: 20000 }); html = r.data; fs.writeFileSync(cacheF, html); }
        catch (e) { console.log(`  ❌ ${lg} ${d}: ${e.message}`); continue; }
        await psGap();
      }
      for (const g of parsePsDay(html, lg, teams)) store[`${lg}|${d}|${g.away}|${g.home}`] = g;
    }
    console.log(`  ${d} 累計 ${Object.keys(store).length} 場`);
  }
  J('ps_close.json', store);
  console.log(`psclose 完成：${Object.keys(store).length} 場`);
}

function stageLabel2() {
  const { matches, unmatched, ambiguous } = R('matches.json');
  const lot = R('lottery_series.json');       // 僅用「首值」＝台彩開盤
  const ps = R('ps_close.json');              // 台彩收盤（權威）
  const rows = [];
  for (const m of matches) {
    const year = m.date.slice(0, 4);
    const startT = Date.parse(m.startTime.replace(' ', 'T') + ':00+08:00') / 1000;
    const out = { ...m, auto: {}, note: [] };
    let hdRows = null;
    try { hdRows = parseChangeTable(fs.readFileSync(path.join(CACHE, `${m.titanId}_hd.txt`), 'utf8'), year); } catch (e) {}
    const pre = (hdRows || []).filter(r => !r.live && r.t != null && r.t <= startT + 10 * 60);
    const dirOf = L => L > 0 ? 'home' : (L < 0 ? 'away' : null);
    const intlSeq = compressDir(pre.map(r => ({ t: r.t, dir: dirOf(r.line) })), startT);
    const intlOpen = intlSeq.length ? intlSeq[0].dir : null;
    const intlClose = intlSeq.length ? intlSeq[intlSeq.length - 1].dir : null;
    const intlCloseLine = pre.length ? Math.abs(pre[pre.length - 1].line) : null;
    const lotSer = (lot[m.sid] || []);
    const lotOpen = lotSer.length ? lotSer[0].favSide : null;                       // feed 首值＝開盤
    const psRec = ps[`${m.league}|${m.date}|${m.away}|${m.home}`] || null;
    const lotClose = (psRec && psRec.hdAwayLine != null) ? (psRec.hdAwayLine < 0 ? 'away' : 'home') : null;   // 客線負=客讓
    let ouClose = null;
    try {
      const ouRows = parseChangeTable(fs.readFileSync(path.join(CACHE, `${m.titanId}_ou.txt`), 'utf8'), year);
      const ouPre = (ouRows || []).filter(r => !r.live && r.t != null && r.t <= startT + 10 * 60);
      if (ouPre.length) ouClose = Math.abs(ouPre[ouPre.length - 1].line);
    } catch (e) {}
    let mlClose = null;
    try {
      const sb = {}; vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(CACHE, `${m.titanId}_ml.txt`), 'utf8'), sb);
      const b = (sb.game || []).map(x => x.split('|')).find(c => (c[16] || '').toLowerCase().includes('36'));
      if (b) mlClose = { home: parseFloat(b[8] || b[3]), away: parseFloat(b[9] || b[4]) };
    } catch (e) {}
    out.auto = {
      intlOpen, intlClose, intlSwing: intlSeq.length > 1,
      lotOpen, lotClose, lotSwing: (lotOpen && lotClose) ? lotOpen !== lotClose : null,
      intlCloseLine, ouCloseLine: ouClose, psTotLine: psRec ? psRec.totLine : null, psHdAwayLine: psRec ? psRec.hdAwayLine : null,
      mlCloseFav: (mlClose && Math.abs(mlClose.home - mlClose.away) >= 0.10) ? (mlClose.home < mlClose.away ? 'home' : 'away') : null
    };
    out.auto.divergeIntl = (out.auto.mlCloseFav && intlClose) ? (out.auto.mlCloseFav !== intlClose) : null;
    // 端點代數（v2）：
    if (!intlClose || !lotClose) out.auto.flipState = 'na';
    else if (intlClose !== lotClose) out.auto.flipState = 'flipped';
    else {
      const intlFlipped = intlOpen && intlOpen !== intlClose;
      const lotFlipped = lotOpen && lotOpen !== lotClose;
      if (intlFlipped && !lotFlipped) out.auto.flipState = (lotOpen ? 'converged_intl' : 'converged_intl');       // 國際貼向台彩
      else if (!intlFlipped && lotFlipped) out.auto.flipState = 'converged_lottery';                              // 台彩貼向國際
      else if (intlFlipped && lotFlipped) out.auto.flipState = (intlOpen !== lotOpen) ? 'converged_unknown' : 'none'; // 同向對調→none（情境B）
      else out.auto.flipState = (intlOpen && lotOpen && intlOpen !== lotOpen) ? 'converged_unknown' : 'none';
    }
    rows.push(out);
  }
  // ---- 對答案 v2 ----
  const fam = s => /^converged/.test(s) ? 'converged' : s;
  const judged = rows.filter(r => r.auto.flipState !== 'na');
  const agree = judged.filter(r => fam(r.auto.flipState) === fam(r.hand.flipState)).length;
  const dis = judged.filter(r => fam(r.auto.flipState) !== fam(r.hand.flipState));
  const mtx = {};
  for (const r of judged) { const k = fam(r.hand.flipState) + '→' + fam(r.auto.flipState); mtx[k] = (mtx[k] || 0) + 1; }
  // 手標自洽（v2：hdFav vs 台彩收盤=playsport）
  let sc = { flipped: { ok: 0, bad: 0 }, converged: { ok: 0, bad: 0 }, none: { ok: 0, bad: 0 } }; const scBad = [];
  for (const r of judged) {
    if (!r.hand.hdFav || !r.auto.lotClose) continue;
    const f = fam(r.hand.flipState); const opp = r.hand.hdFav !== r.auto.lotClose;
    const ok = (opp === (f === 'flipped'));
    sc[f][ok ? 'ok' : 'bad']++;
    if (!ok) scBad.push(`${r.date} ${r.away}@${r.home}［${r.league}］手標=${r.hand.flipState}｜你的讓分方=${r.hand.hdFav} vs 台彩收盤=${r.auto.lotClose}${opp ? '(相反)' : '(同向)'}`);
  }
  const rep = [];
  rep.push(`# pilot 對答案報告 v2（2026-07-11，台彩收盤改用玩運彩結果頁後重跑）`);
  rep.push(`\n> v1 缺陷（使用者抽查 3 場全中）：pregame feed 的台彩欄位＝開盤一次性快照（287/287 場零變動、距開賽中位 16.2h），被誤當收盤。v2 台彩收盤改玩運彩結果頁（權威），開盤仍用 feed 首值，判定改端點代數。`);
  rep.push(`\n⚠ 軸聲明不變：自動判定＝bet365 vs 台彩，不代表 STAKE。\n`);
  rep.push(`## 樣本：配對 ${rows.length}｜可判 ${judged.length}｜na ${rows.length - judged.length}（含玩運彩頁缺讓分線/隊名未識別）`);
  rep.push(`\n## flipState 家族一致率：**${agree}/${judged.length}＝${(100 * agree / judged.length).toFixed(1)}%**`);
  rep.push(`混淆矩陣（手標→自動）：${JSON.stringify(mtx)}`);
  rep.push(`\n## 手標自洽性 v2（hdFav vs 玩運彩台彩收盤）`);
  rep.push(`flipped 應相反：${sc.flipped.ok}自洽/${sc.flipped.bad}不自洽｜converged 應同向：${sc.converged.ok}/${sc.converged.bad}｜none 應同向：${sc.none.ok}/${sc.none.bad}`);
  rep.push(scBad.length ? `不自洽清單（${scBad.length}）：\n${scBad.map(x => '- ' + x).join('\n')}` : '（零不自洽）');
  rep.push(`\n## 家族不一致清單（${dis.length}）`);
  for (const r of dis) rep.push(`- ${r.date} ${r.away}@${r.home}［${r.league}］手標=${r.hand.flipState}｜自動=${r.auto.flipState}（intl ${r.auto.intlOpen}→${r.auto.intlClose}${r.auto.intlSwing ? '·曾擺動' : ''}｜台彩 ${r.auto.lotOpen || '?'}→${r.auto.lotClose}）`);
  fs.writeFileSync(path.join(DIR, 'PILOT_REPORT_v2.md'), rep.join('\n'));
  J('labeled_v2.json', rows);
  console.log(rep.slice(0, 12).join('\n'));
  console.log(`（完整報告見 divination_lab/titan_pilot/PILOT_REPORT_v2.md）`);
}

// ============================================================================
// 回補（4/1–6/26，國際軸）：titan bet365 hd/ou/ml + 玩運彩結果頁台彩收盤。
// 台彩「開盤」歷史不存在（feed git 僅回到 6/22）→ 端點代數退化為三值：
//   flipped（收盤相反，最強最乾淨）／none（收盤同向且 intl 全程未擺動）／
//   intl_swung_close_same（intl 曾換邊、收盤同向＝converged_intl 或 同向對調，無台彩開盤不可分）
// converged_lottery 在回補期＝不可偵測（結構限制，report 註明）。
// ============================================================================
const BF_DIR = path.join('divination_lab', 'titan_backfill');
const BF_CACHE = path.join(BF_DIR, 'cache');
const BF_LO = '2026-04-01', BF_HI = '2026-06-26';
const BFJ = (f, v) => { fs.mkdirSync(BF_DIR, { recursive: true }); fs.writeFileSync(path.join(BF_DIR, f), JSON.stringify(v)); };
const BFR = f => JSON.parse(fs.readFileSync(path.join(BF_DIR, f), 'utf8'));

async function bfEnum() {
  const teams = loadLeagueTeams();
  const list = []; const keyCnt = {};
  for (const lg of LEAGUES_CFG) {
    for (const mo of [3, 4, 5, 6]) {
      const url = `https://sports.titan007.com/jsData/baseball/matchResult/2026/l${lg.id}_1_2026_${mo}.js`;
      try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        const sb = {}; vm.createContext(sb); vm.runInContext(res.data, sb);
        const dict = {}; (sb.arrTeam || []).forEach(t => { dict[t[0]] = t[2]; });
        for (const m of (sb.arrData || [])) {
          const time = String(m[2]); const date = time.slice(0, 10);
          if (date < BF_LO || date > BF_HI) continue;
          const home = resolveName(teams, lg.key, dict[m[3]] || ''), away = resolveName(teams, lg.key, dict[m[4]] || '');
          if (!home || !away) continue;
          const key = `${lg.key}|${date}|${away}|${home}`;
          keyCnt[key] = (keyCnt[key] || 0) + 1;
          list.push({ id: m[0], league: lg.key, date, time, away, home, key, schedHd: m[7] != null ? String(m[7]) : null, schedOu: m[8] != null ? String(m[8]) : null });
        }
      } catch (e) { console.log(`  ⚠️ ${url} ${e.message}`); }
      await sleep(GAP_MS);
    }
    console.log(`  [${lg.key}] 累計 ${list.length}`);
  }
  for (const g of list) g.dh = keyCnt[g.key] > 1;                     // 雙重賽：playsport join 不可靠，標記
  BFJ('bf_matches.json', list);
  console.log(`bfenum 完成：${list.length} 場（雙重賽 ${list.filter(g => g.dh).length}）`);
}

async function bfFetch() {
  fs.mkdirSync(BF_CACHE, { recursive: true });
  const list = BFR('bf_matches.json');
  let done = 0, skip = 0, fail = 0, i = 0;
  for (const m of list) {
    for (const [kind, url] of [
      ['hd', `https://sports.titan007.com/ChangeDetail/handicap.aspx?id=${m.id}&companyid=8&t=2`],
      ['ou', `https://sports.titan007.com/ChangeDetail/overunder.aspx?id=${m.id}&companyid=8&t=2`],
      ['ml', `https://sports.titan007.com/jsData/baseball/1x2/${m.id}.js`]
    ]) {
      const f = path.join(BF_CACHE, `${m.id}_${kind}.txt`);
      if (fs.existsSync(f) && fs.statSync(f).size > 100) { skip++; continue; }
      try { const res = await axios.get(url, { headers: HEADERS, timeout: 15000 }); fs.writeFileSync(f, typeof res.data === 'string' ? res.data : JSON.stringify(res.data)); done++; }
      catch (e) { fail++; }
      await sleep(GAP_MS);
    }
    if (++i % 100 === 0) console.log(`  bf-fetch ${i}/${list.length}（抓${done} 快取${skip} 失敗${fail}）`);
  }
  console.log(`bffetch 完成：抓 ${done}、快取 ${skip}、失敗 ${fail}`);
}

async function bfPs() {
  fs.mkdirSync(BF_CACHE, { recursive: true });
  const teams = loadLeagueTeams();
  const AIDS = { mlb: 1, npb: 2, kbo: 9, cpbl: 6 };
  const store = {}; const days = [];
  for (let d = new Date(BF_LO + 'T00:00:00Z'); d <= new Date(BF_HI + 'T00:00:00Z'); d = new Date(d.getTime() + 86400000)) days.push(d.toISOString().slice(0, 10));
  let i = 0;
  for (const d of days) {
    const ymd = d.replace(/-/g, '');
    for (const [lg, aid] of Object.entries(AIDS)) {
      const cacheF = path.join(BF_CACHE, `ps_${aid}_${ymd}.html`);
      let html = null;
      if (fs.existsSync(cacheF) && fs.statSync(cacheF).size > 500) html = fs.readFileSync(cacheF, 'utf8');
      else {
        try { const r = await axios.get(PS_URL(aid, ymd), { headers: PS_HEADERS, timeout: 20000 }); html = r.data; fs.writeFileSync(cacheF, html); }
        catch (e) { console.log(`  ❌ ps ${lg} ${d}: ${e.message}`); }
        await psGap();
      }
      if (html) for (const g of parsePsDay(html, lg, teams)) store[`${lg}|${d}|${g.away}|${g.home}`] = g;
    }
    if (++i % 10 === 0) console.log(`  bf-ps ${i}/${days.length} 天（累計 ${Object.keys(store).length} 場）`);
  }
  BFJ('bf_ps.json', store);
  console.log(`bfps 完成：${Object.keys(store).length} 場`);
}

function bfLabel() {
  const list = BFR('bf_matches.json');
  const ps = BFR('bf_ps.json');
  const out = [];
  for (const m of list) {
    const year = m.date.slice(0, 4);
    const startT = Date.parse(m.time.replace(' ', 'T') + ':00+08:00') / 1000;
    let hdRows = null, ouRows = null, mlClose = null;
    try { hdRows = parseChangeTable(fs.readFileSync(path.join(BF_CACHE, `${m.id}_hd.txt`), 'utf8'), year); } catch (e) {}
    try { ouRows = parseChangeTable(fs.readFileSync(path.join(BF_CACHE, `${m.id}_ou.txt`), 'utf8'), year); } catch (e) {}
    try {
      const sb = {}; vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(BF_CACHE, `${m.id}_ml.txt`), 'utf8'), sb);
      const b = (sb.game || []).map(x => x.split('|')).find(c => (c[16] || '').toLowerCase().includes('36'));
      if (b) mlClose = { home: parseFloat(b[8] || b[3]), away: parseFloat(b[9] || b[4]) };
    } catch (e) {}
    const dirOf = L => L > 0 ? 'home' : (L < 0 ? 'away' : null);
    const pre = (hdRows || []).filter(r => !r.live && r.t != null && r.t <= startT + 10 * 60);
    const seq = compressDir(pre.map(r => ({ t: r.t, dir: dirOf(r.line) })), startT);
    const intlOpen = seq.length ? seq[0].dir : null, intlClose = seq.length ? seq[seq.length - 1].dir : null;
    const intlCloseLine = pre.length ? pre[pre.length - 1].line : null;                 // 帶符號
    const ouPre = (ouRows || []).filter(r => !r.live && r.t != null && r.t <= startT + 10 * 60);
    const ouClose = ouPre.length ? Math.abs(ouPre[ouPre.length - 1].line) : null;
    const psRec = m.dh ? null : (ps[m.key] || null);                                    // 雙重賽不 join
    const lotClose = (psRec && psRec.hdAwayLine != null) ? (psRec.hdAwayLine < 0 ? 'away' : 'home') : null;
    const firstSeen = pre.length ? pre[0].t : null;
    let flipStateIntl;
    if (!intlClose || !lotClose) flipStateIntl = 'na';
    else if (intlClose !== lotClose) flipStateIntl = 'flipped';
    else flipStateIntl = (intlOpen && intlOpen !== intlClose) ? 'intl_swung_close_same' : 'none';
    out.push({
      id: m.id, league: m.league, date: m.date, time: m.time, away: m.away, home: m.home, dh: m.dh,
      flipStateIntl, intlOpen, intlClose, intlSwing: seq.length > 1,
      intlCloseLine, intlOuClose: ouClose, mlClose,
      divergeIntl: (mlClose && intlClose && Math.abs(mlClose.home - mlClose.away) >= 0.10) ? ((mlClose.home < mlClose.away ? 'home' : 'away') !== intlClose) : null,
      lotClose, lotHdAwayLine: psRec ? psRec.hdAwayLine : null, lotTotLine: psRec ? psRec.totLine : null,
      awayScore: psRec ? psRec.awayScore : null, homeScore: psRec ? psRec.homeScore : null,
      firstSeenT: firstSeen, startT
    });
  }
  BFJ('bf_labeled.json', out);
  // ---- 報告（三市場全列，無主勝特權）----
  const settled = out.filter(g => g.awayScore != null && g.homeScore != null);
  const cls = ['flipped', 'intl_swung_close_same', 'none', 'na'];
  const rep = [`# 回補資料集報告（國際軸 bet365 vs 台彩，${BF_LO}~${BF_HI}，${new Date().toISOString().slice(0, 10)} 產出）`,
    `\n⚠ 本資料集＝國際盤(bet365) vs 台彩軸。**不代表 STAKE**（使用者紅線）。converged_lottery 在回補期不可偵測（無台彩開盤史料）；intl_swung_close_same＝converged_intl 或同向對調（不可分）。`,
    `\n總場數 ${out.length}（雙重賽排除 join ${out.filter(g => g.dh).length}）｜有比分 ${settled.length}`, ''];
  const pc = (k, n) => n ? `${Math.round(100 * k / n)}% (${k}/${n})` : '—';
  for (const lg of ['mlb', 'npb', 'kbo', 'cpbl', 'all']) {
    const pool = lg === 'all' ? settled : settled.filter(g => g.league === lg);
    if (!pool.length) continue;
    rep.push(`## ${lg.toUpperCase()}（有比分 ${pool.length}）`);
    rep.push(`| 類別 | 場數 | 主勝 | 讓分過盤(bet365收盤線) | 開大(bet365收盤線) | 背離(intl) |`);
    rep.push(`|---|---|---|---|---|---|`);
    for (const c of cls) {
      const arr = pool.filter(g => g.flipStateIntl === c);
      if (!arr.length) { rep.push(`| ${c} | 0 | — | — | — | — |`); continue; }
      const wl = arr.filter(g => g.awayScore !== g.homeScore);
      const hw = wl.filter(g => g.homeScore > g.awayScore).length;
      let cov = 0, covN = 0, ov = 0, ovN = 0, dv = 0, dvN = 0;
      for (const g of arr) {
        if (g.intlCloseLine != null) {
          const L = g.intlCloseLine; const margin = (L > 0 ? g.homeScore - g.awayScore : g.awayScore - g.homeScore);
          const need = Math.abs(L);
          if (margin !== need) { covN++; if (margin > need) cov++; }
        }
        if (g.intlOuClose != null) { const t = g.awayScore + g.homeScore; if (t !== g.intlOuClose) { ovN++; if (t > g.intlOuClose) ov++; } }
        if (g.divergeIntl != null) { dvN++; if (g.divergeIntl) dv++; }
      }
      rep.push(`| ${c} | ${arr.length} | ${pc(hw, wl.length)} | ${pc(cov, covN)} | ${pc(ov, ovN)} | ${pc(dv, dvN)} |`);
    }
    rep.push('');
  }
  fs.writeFileSync(path.join(BF_DIR, 'BF_REPORT.md'), rep.join('\n'));
  console.log(rep.join('\n'));
}

(async () => {
  const stage = process.argv[2];
  if (stage === 'enum') await stageEnum();
  else if (stage === 'fetch') await stageFetch();
  else if (stage === 'lottery') stageLottery();
  else if (stage === 'label') stageLabel();
  else if (stage === 'psprobe') await stagePsProbe();
  else if (stage === 'psclose') await stagePsClose();
  else if (stage === 'label2') stageLabel2();
  else if (stage === 'bfenum') await bfEnum();
  else if (stage === 'bffetch') await bfFetch();
  else if (stage === 'bfps') await bfPs();
  else if (stage === 'bflabel') bfLabel();
  else console.log('用法: node titan_pilot.js enum|fetch|lottery|label|psprobe|psclose|label2|bfenum|bffetch|bfps|bflabel');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
