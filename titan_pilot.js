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
  return sb.T;
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

(async () => {
  const stage = process.argv[2];
  if (stage === 'enum') await stageEnum();
  else if (stage === 'fetch') await stageFetch();
  else if (stage === 'lottery') stageLottery();
  else if (stage === 'label') stageLabel();
  else console.log('用法: node titan_pilot.js enum|fetch|lottery|label');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
