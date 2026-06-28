/* ============================================================
   融合：把六個來源 join 成一張「每場一列」的分析總表 data/fused.json
   來源（皆以唯一鍵 date+兩隊+gameTime 對齊；缺時間者用同日同隊+比分回退）：
     · mlb_games.json        spine：比分/投手/官方日夜/台灣date+time
     · qimen_data.json       奇門三盤（fused 只放參照鍵+開賽盤值符宫；全盤留原檔）
     · playsport_history.json 逐局+RHE、讓分線(favSide=過盤方)
     · pitcher_birthdays.json 投手生日→出賽日年齡
     · odds_log.json(.matches) 大小線(ou收盤)、ML熱門(收盤較低賠率)
     · 盤面備份 doc.games     favorite(hdFav)、讓分/大小線與結果、platformFlip/preGameSwap/lights（已結算子集）
   產出每列：勝負、NRFI、尾局逆轉、讓分過盤、大小、日夜、星期、投手年齡、奇門參照 等。
   用法：
     node fuse_data.js [--board "C:\\Users\\User\\Downloads\\排盤備份_2026-06-25.json"] [--out data/fused.json]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const load = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };
const arg = (k, d) => { const i = process.argv.indexOf(k); if (i >= 0) return process.argv[i + 1]; const h = process.argv.find(a => a.startsWith(k + '=')); return h ? h.split('=').slice(1).join('=') : d; };

const keyOf = (date, a, h, t) => `${date}|${[a, h].sort().join('@')}|${t}`;
const dtTeams = (date, a, h) => `${date}|${[a, h].sort().join('@')}`;
const innVal = (v) => { if (v == null) return 0; const s = String(v).trim().toUpperCase(); if (s === '' || s === 'X' || s === '-') return 0; const n = parseInt(s, 10); return isNaN(n) ? 0 : n; };
const cum = (arr, n) => (arr || []).slice(0, n).reduce((s, v) => s + innVal(v), 0);
const ymd = (s) => String(s).slice(0, 10);

function ageYears(birth, on) { if (!birth) return null; const b = new Date(birth), o = new Date(on); if (isNaN(b) || isNaN(o)) return null; let a = o.getUTCFullYear() - b.getUTCFullYear(); const m = o.getUTCMonth() - b.getUTCMonth(); if (m < 0 || (m === 0 && o.getUTCDate() < b.getUTCDate())) a--; return a; }

// odds_log：收盤(最後一筆) ML 熱門 + ou 大小線
function oddsClosing(match) {
  let fav = null, totLine = null;
  try {
    const books = match.ml ? Object.keys(match.ml) : [];
    const bk = books.includes('bet365') ? 'bet365' : books[0];
    if (bk) { const live = match.ml[bk].live || []; const last = live[live.length - 1] || match.ml[bk].open; if (last) fav = last.home < last.away ? 'home' : (last.away < last.home ? 'away' : null); }
  } catch (e) {}
  try { const ou = match.ou && (match.ou.bet365 || match.ou[Object.keys(match.ou)[0]]); if (ou && ou.length) { const v = parseFloat(ou[ou.length - 1].line); if (!isNaN(v)) totLine = v; } } catch (e) {}
  return { fav, totLine };
}

function main() {
  const boardPath = arg('--board', 'C:\\Users\\User\\Downloads\\排盤備份_2026-06-25.json');
  const outPath = arg('--out', path.join('data', 'fused.json'));

  const mlb = load('data/mlb_games.json', []);
  const qimen = load('data/qimen_data.json', {});
  const play = load('data/playsport_history.json', {});
  const bdays = load('data/pitcher_birthdays.json', {});
  const oddsDoc = load('data/odds_log.json', { matches: {} });
  const odds = oddsDoc.matches || {};
  const board = (load(boardPath, { games: [] }).games) || [];
  const totals = load('data/playsport_totals.json', []);   // 運彩盤大小線（全歷史）

  // 索引
  const playByKey = {}, playByDT = {};
  for (const id in play) { const g = play[id]; const k = keyOf(ymd(g.date), g.awayTeam, g.homeTeam, g.time); playByKey[k] = g; (playByDT[dtTeams(ymd(g.date), g.awayTeam, g.homeTeam)] ||= []).push(g); }
  const oddsByKey = {}, oddsByDT = {};
  for (const id in odds) { const g = odds[id]; const d = ymd(g.startISO || g.time || ''); const k = keyOf(d, g.awayTeam, g.homeTeam, (g.startISO || '').slice(11, 16)); oddsByKey[k] = g; (oddsByDT[dtTeams(d, g.awayTeam, g.homeTeam)] ||= []).push(g); }
  const boardByDT = {};
  for (const g of board) { (boardByDT[dtTeams(ymd(g.date), g.awayTeam, g.homeTeam)] ||= []).push(g); }
  const totByKey = {}, totByDT = {};
  for (const g of totals) { totByKey[g.key] = g; (totByDT[dtTeams(g.date, g.away, g.home)] ||= []).push(g); }
  const tMin = (t) => { const m = /(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const pickByTime = (list, wantT) => { if (!list || !list.length) return null; if (list.length === 1) return list[0]; const w = tMin(wantT); if (w == null) return list[0]; let best = list[0], bd = Infinity; for (const g of list) { const d = Math.abs((tMin(g.time) ?? 1e9) - w); if (d < bd) { bd = d; best = g; } } return best; };

  // 同日同隊回退：多筆時用比分挑（雙重賽）
  const pickByScore = (list, as, hs) => { if (!list || !list.length) return null; if (list.length === 1) return list[0]; return list.find(g => +g.awayScore === +as && +g.homeScore === +hs) || list[0]; };

  const rows = [];
  let nLine = 0, nHd = 0, nTot = 0, nFlags = 0, nQimen = 0;

  for (const g of mlb) {
    if (!(g.status === 'Final' || /final/i.test(g.status || ''))) continue;  // 只融合已完成場
    const as = g.awayScore, hs = g.homeScore;
    if (as == null || hs == null) continue;
    const dt = dtTeams(g.date, g.away, g.home);

    // playsport（逐局）
    const ps = playByKey[g.key] || pickByScore(playByDT[dt], as, hs);
    const ls = ps && ps.lineScore;
    // board（結果+旗標）
    const bd = pickByScore(boardByDT[dt], as, hs);
    // odds_log（大小線+熱門）
    const ol = oddsByKey[g.key] || (oddsByDT[dt] && oddsByDT[dt][0]);
    const oc = ol ? oddsClosing(ol) : { fav: null, totLine: null };

    // 勝負
    const mlWinner = as > hs ? 'away' : (hs > as ? 'home' : 'tie');
    const totalRuns = as + hs;

    // 逐局衍生：NRFI、尾局逆轉
    let nrfi = null, firstInnRuns = null, lateReversal = null, leadAfter7 = null;
    if (ls && ls.away && ls.home) {
      firstInnRuns = innVal(ls.away[0]) + innVal(ls.home[0]);
      nrfi = firstInnRuns === 0;
      const a7 = cum(ls.away, 7), h7 = cum(ls.home, 7);
      leadAfter7 = a7 > h7 ? 'away' : (h7 > a7 ? 'home' : 'tie');
      lateReversal = (leadAfter7 !== 'tie' && mlWinner !== 'tie' && mlWinner !== leadAfter7);
    }

    // 運彩盤資料(讓分線正負號標熱門、大小線) — 讓分與大小共用
    const pt = totByKey[g.key] || pickByTime(totByDT[dt], g.gameTime);

    // 讓分：以運彩盤客隊讓分線定熱門(客線<0=客隊熱門)；熱門需贏「>線」才過盤(已用盤面權威核對 89.9%)
    let hdLine = null, favoriteSide = null, favCovered = null, hdCoveredSide = null;
    if (pt && pt.hdAwayLine != null) { hdLine = Math.abs(pt.hdAwayLine); favoriteSide = pt.hdAwayLine < 0 ? 'away' : 'home'; }
    else if (bd && (bd.hdFav === 'home' || bd.hdFav === 'away')) { favoriteSide = bd.hdFav; hdLine = (bd.hdVal != null && bd.hdVal !== '') ? parseFloat(bd.hdVal) : 1.5; }
    else if (oc.fav) { favoriteSide = oc.fav; hdLine = 1.5; }
    if (favoriteSide && hdLine != null && mlWinner !== 'tie') {
      const favScore = favoriteSide === 'away' ? as : hs, dogScore = favoriteSide === 'away' ? hs : as;
      favCovered = (favScore - dogScore) > hdLine;
      hdCoveredSide = favCovered ? favoriteSide : (favoriteSide === 'away' ? 'home' : 'away');
    }

    // 大小：線(運彩盤全歷史 → board totVal → odds_log ou) + 結果
    const totLine = (pt && pt.totLine != null) ? pt.totLine
      : ((bd && bd.totVal != null && bd.totVal !== '') ? parseFloat(bd.totVal) : oc.totLine);
    let totResult = null;
    if (totLine != null) totResult = totalRuns > totLine ? 'over' : (totalRuns < totLine ? 'under' : 'push');

    // 投手 + 年齡
    const pit = (p) => { if (!p) return null; const b = bdays[p.id]; return { name: p.name, id: p.id, bday: b ? b.birthDate : null, throws: b ? b.throws : null, age: b ? ageYears(b.birthDate, g.gameDateUTC) : null }; };

    // 奇門：參照鍵 + 開賽盤「值符」落宫（值符=八神名為值符的宮）
    const q = qimen[g.key];
    let zhifuPalace = null;
    if (q && q.shiStart && q.shiStart.palaces) { for (const [nm, pl] of Object.entries(q.shiStart.palaces)) if (pl.shen === '值符') zhifuPalace = nm; }

    // 旗標 + 燈號（board）：只有「經完整結算」的紀錄(有 preGameSwap 欄位)才採信；
    // 舊的精簡紀錄沒有這些欄位 → flags=null，避免「沒資料」被當成 false 污染分析
    const richBoard = bd && Object.prototype.hasOwnProperty.call(bd, 'preGameSwap');
    const flags = richBoard ? { platformFlip: !!bd.platformFlip, preGameSwap: !!bd.preGameSwap, flipVanished: !!bd.flipVanished } : null;

    const usDow = (() => { const d = new Date((g.usDate || g.date) + 'T12:00:00Z'); return isNaN(d) ? null : d.getUTCDay(); })();

    rows.push({
      key: g.key, date: g.date, gameTime: g.gameTime, usDate: g.usDate, usWeekday: usDow,
      away: g.away, home: g.home, dayNight: g.dayNight,
      awayScore: as, homeScore: hs, totalRuns, mlWinner,
      awayPitcher: pit(g.awayPitcher), homePitcher: pit(g.homePitcher),
      lineScore: ls || null, firstInningRuns: firstInnRuns, nrfi, leadAfter7, lateReversal,
      hdLine, hdCoveredSide, favoriteSide, favCovered,
      totLine, totResult,
      flags, lights: bd ? (bd.lightsSnapshot || null) : null,
      qimenKey: q ? g.key : null, zhifuPalaceStart: zhifuPalace,
      doubleHeader: g.doubleHeader, gamePk: g.gamePk,
    });
    if (ls) nLine++;
    if (hdLine != null) nHd++;
    if (totLine != null) nTot++;
    if (flags) nFlags++;
    if (q) nQimen++;
  }

  fs.writeFileSync(outPath, JSON.stringify(rows));
  console.log(`融合完成：${rows.length} 場 → ${outPath}`);
  console.log(`  有逐局 ${nLine}｜有讓分線 ${nHd}｜有大小線 ${nTot}｜有奇門 ${nQimen}｜有盤面旗標/燈號 ${nFlags}`);
  console.log(`  範例:`, JSON.stringify({ ...rows[0], lineScore: '…', qimenKey: rows[0].qimenKey }).slice(0, 400));
}
main();
