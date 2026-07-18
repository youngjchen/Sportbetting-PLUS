/* ============================================================
   玩運彩「找高手」明牌爬蟲 → data/expert_picks.json
   使用者規則（2026-07-18 拍板）：
     · 合格門檻：本賽季(during=season) 勝率 ≥60% 且 ≥30 注（榜單本身已有注數門檻）
     · 範圍：MLB/日職/中職/韓職 × 國際盤(mode=2) + 運彩盤(mode=1)
     · 只吃「合格市場」的推薦：國際盤 讓分(gt11)/大小(gt12)；運彩盤 讓分(gt1)/大小(gt2)/不讓分(gt3)
       ＋ 主推榜(mainPrediction)合格者的「主推」標記單
     · 燈號歸類：國際盤讓分(-1(-185) 整數盤)→獨贏；大小(不分盤)→大/小；
       運彩盤 讓分→讓分、大小→大/小、不讓分→獨贏
     · 只吃免費/裸單：販售中的未來場推薦「不在」頁面 HTML 裡（伺服器端鎖）→ 天然過濾，
       免費附贈單(img alt=免費)看得到、照吃。
   來源端點（皆匿名可取）：
     · /billboard/winRate?allianceid&mode&during=season&page  (XHR → JSON rankers)
     · /billboard/mainPrediction?allianceid&during=season     (XHR → JSON rankers 以 mode 為鍵)
     · /member/{uid}/prediction?allianceid&gameday=today|tomorrow  (HTML，cheerio 解析)
   節奏：溫和(1.0~1.6s 抖動)；每聯盟合格高手取勝率前 EXPERT_CAP 名。
   ============================================================ */
'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { feedCanon } = require('./index.js');   // 隊名正規化沿用主爬蟲（分聯盟別名表）

const OUT = path.join('data', 'expert_picks.json');
const BASE = 'https://www.playsport.cc';
const DURING = 'season';
const THRESH_WP = 60;          // 勝率門檻（%）
const MIN_BETS = 30;           // 最少注數
// 個人頁抓取名額（每聯盟，依最佳勝率排序）。合格名單本身不受此限（勝率榜翻頁到 120 名、
// 主推榜也翻頁），這個上限只管「每輪去抓幾個人的個人頁」——2026-07-18 使用者反映遺珠
// 後由 25 調到 40（MLB 合格 124 人仍抓不完；再放大就要考慮站方流量禮貌）。
const EXPERT_CAP = 40;
const MAX_PAGES = 4;           // 勝率榜最多翻 4 頁（120 名）
const ALLIANCES = [
  { id: 1, lg: 'mlb' }, { id: 2, lg: 'npb' }, { id: 6, lg: 'cpbl' }, { id: 9, lg: 'kbo' },
];
// 合格市場：billboard gametype → 市場。mode2=國際盤、mode1=運彩盤(北富盤)。gt0(全部)不用。
const QUAL_GT = {
  2: { 11: '國際盤讓分', 12: '國際盤大小' },
  1: { 1: '運彩盤讓分', 2: '運彩盤大小', 3: '運彩盤不讓分' },
};
// 推薦 → 盤面市場歸類（使用者規則）
//   mode2 hd→ml(獨贏)、ou→ou；mode1 hd→hd、ou→ou、ml→ml
function boardMarket(mode, kind) {
  if (kind === 'ou') return 'ou';
  if (kind === 'hd') return mode === 2 ? 'ml' : 'hd';
  return 'ml';
}
// 推薦種類 → 對應 billboard gametype（判斷合格用）
function gtOf(mode, kind) {
  if (mode === 2) return kind === 'hd' ? 11 : (kind === 'ou' ? 12 : null);   // 國際盤獨贏歸「全部」→ 不單獨計
  return kind === 'hd' ? 1 : (kind === 'ou' ? 2 : 3);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.playsport.cc/',
  'Accept-Language': 'zh-TW,zh;q=0.9',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 1000 + Math.floor(Math.random() * 600);

async function getJSON(url) {
  const r = await axios.get(url, { headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' }, HEADERS), timeout: 20000 });
  return r.data;
}
async function getHTML(url) {
  const r = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  return r.data;
}

function twDate(offsetDays) {
  const tw = new Date(Date.now() + 8 * 3600e3 + (offsetDays || 0) * 86400e3);
  const p = n => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())}`;
}

// 玩運彩時間 → 24h "HH:MM"。
// ⚠ 站方對亞洲下午/晚場用「PM 13:00」「PM 17:00」這種【24 小時制混用 PM 前綴】的格式
//   （2026-07-18 日職頁原始碼證實）——PM 且時數 ≥13 時「不可」再加 12，
//   否則變 25:00 → 板上 ±120 分配對全滅（日職/韓職膠囊消失事故的根因）。
// 規則：PM 且 h<12 → +12（PM 10:05→22:05）；PM 且 h≥12 → 原樣（PM 13:00→13:00）；
//       AM 12→00；其餘原樣。
function toHHMM(txt) {
  const m = /(AM|PM)\s*(\d{1,2}):(\d{2})/i.exec(txt || '');
  if (!m) { const n = /(\d{1,2}):(\d{2})/.exec(txt || ''); return n ? `${n[1].padStart(2, '0')}:${n[2]}` : null; }
  let h = +m[2];
  if (/PM/i.test(m[1]) && h < 12) h += 12;
  if (/AM/i.test(m[1]) && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[3]}`;
}

/* ---- 解析單格「預測」文字（純函式，供測試）----
   國際盤: "釀酒人 讓分" / "巨人 受讓" / "10 大分 輸50%" / "8.5 小分" / "洋基 輸贏"
   運彩盤: "運動家 主 +1.5" / "紅雀 客 +1.5"(受讓) / "光芒 客 -1.5"(讓) / "11.5 大分"
   不讓分(PK)：付費單附贈常見「軟銀 客 PK」、一般免費單「軟銀 PK」（2026-07-18 使用者截圖證實），
   也保留「{隊} 主|客」「{隊} 不讓分/輸贏/獨贏」變體。
   回傳 {kind:'hd'|'ou'|'ml', team?, side?('over'|'under'), line?} 或 null */
function parsePick(text) {
  const t = String(text || '').replace(/\s+/g, ' ').replace(/(贏|輸)50%/g, '').trim();
  if (!t || t === '無預測') return null;
  let m = /^([0-9.]+)\s*(大分|小分)/.exec(t);
  if (m) return { kind: 'ou', side: m[2] === '大分' ? 'over' : 'under', line: parseFloat(m[1]) };
  m = /^(\S+?)\s*(讓分|受讓)$/.exec(t);
  if (m) return { kind: 'hd', team: m[1] };
  m = /^(\S+?)\s*[主客]\s*([+\-][0-9.]+)$/.exec(t);
  if (m) return { kind: 'hd', team: m[1], line: parseFloat(m[2]) };
  m = /^(\S+?)\s*(?:[主客]\s*)?PK$/i.exec(t);            // 不讓分："軟銀 客 PK" / "軟銀 PK"
  if (m) return { kind: 'ml', team: m[1] };
  m = /^(\S+?)\s*(輸贏|獨贏|不讓分)$/.exec(t);
  if (m) return { kind: 'ml', team: m[1] };
  m = /^(\S+?)\s*[主客]$/.exec(t);                       // 後備："水手 主"
  if (m) return { kind: 'ml', team: m[1] };
  return null;
}

/* ---- 解析高手個人頁（純函式，供 fixture 測試）----
   universe-tablecon=國際盤(mode2)、bank-tablecon=運彩盤(mode1)。
   回傳 [{mode,kind,team|side,line,away,home,time,main,free,result}] */
function parseExpertPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  const TABLES = [{ sel: 'table.universe-tablecon', mode: 2 }, { sel: 'table.bank-tablecon', mode: 1 }];
  for (const { sel, mode } of TABLES) {
    $(sel).each((_, tbl) => {
      const $t = $(tbl);
      if ($t.parents('table').length) return;
      let cur = null;   // 目前這一場（同場多注時，第二注的 tr 沒有 gamenum/隊名 → 沿用上一場）
      $t.find('> tbody > tr, > tr').each((_, tr) => {
        const $tr = $(tr);
        const timeTxt = $tr.children('td.gamenum').text();
        const ths = $tr.find('th').map((i, x) => $(x).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
        if (timeTxt && ths.length >= 2) {
          cur = {
            away: ths[0].replace(/\(主\)$/, '').trim(),
            home: ths[1].replace(/\(主\)$/, '').trim(),
            time: toHHMM(timeTxt),
          };
        }
        const $pk = $tr.children('td.managerpredictcon');
        if (!$pk.length || !cur) return;
        const pick = parsePick($pk.text());
        if (!pick) return;
        const rTxt = $tr.children('td.predictresult, td[class*="predictresult"]').text().trim();
        out.push({
          mode: mode, kind: pick.kind, team: pick.team || null, side: pick.side || null,
          line: pick.line != null ? pick.line : null,
          away: cur.away, home: cur.home, time: cur.time,
          main: $tr.find('img[alt="主推"]').length > 0,
          free: $tr.find('img[alt="免費"]').length > 0,
          result: /準/.test(rTxt) ? 'win' : (/囧/.test(rTxt) ? 'lose' : null),
        });
      });
    });
  }
  return out;
}

/* ---- 主流程 ---- */
async function run() {
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
  console.log(`==================== expert_picks ${stamp} ====================`);
  const qual = {};        // `${uid}|${aid}|${mode}|${gt}` -> {wp,w,l,total,label}
  const mainQual = {};    // `${uid}|${aid}|${mode}` -> {wp,total}
  const nick = {};        // uid -> nickname
  const perAlliance = {}; // aid -> Map(uid -> bestWp)

  for (const { id: aid } of ALLIANCES) {
    perAlliance[aid] = new Map();
    for (const mode of [2, 1]) {
      for (let page = 0; page < MAX_PAGES; page++) {
        let j;
        try { j = await getJSON(`${BASE}/billboard/winRate?allianceid=${aid}&mode=${mode}&during=${DURING}&page=${page}`); }
        catch (e) { console.log(`  ⚠️ winRate a${aid} m${mode} p${page}: ${e.message}`); break; }
        let more = false;
        for (const [gt, rows] of Object.entries((j && j.rankers) || {})) {
          const label = (QUAL_GT[mode] || {})[gt];
          if (!label) continue;
          for (const r of rows || []) {
            if (r.winpercentage >= THRESH_WP && r.total_game >= MIN_BETS) {
              qual[`${r.userid}|${aid}|${mode}|${gt}`] = { wp: r.winpercentage, w: r.wingame, l: r.losegame, total: r.total_game, label: label };
              nick[r.userid] = r.nickname;
              const b = perAlliance[aid].get(r.userid) || 0;
              if (r.winpercentage > b) perAlliance[aid].set(r.userid, r.winpercentage);
            }
          }
          if ((rows || []).length === 30 && rows[29].winpercentage >= THRESH_WP) more = true;
        }
        await sleep(jitter());
        if (!more) break;
      }
    }
    // 主推榜（rankers 以 mode 為鍵）；也翻頁抓到 60% 線下為止（防遺珠），
    // 用「第一名 uid 重複」當迴圈保險（不確定端點是否支援 page 時不會重複計）。
    let firstUid = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      let j;
      try { j = await getJSON(`${BASE}/billboard/mainPrediction?allianceid=${aid}&during=${DURING}&page=${page}`); }
      catch (e) { console.log(`  ⚠️ mainPred a${aid} p${page}: ${e.message}`); break; }
      let more = false, pageFirst = null;
      for (const [mode, rows] of Object.entries((j && j.rankers) || {})) {
        for (const r of rows || []) {
          if (pageFirst == null) pageFirst = r.userid;
          if (r.winpercentage >= THRESH_WP && r.total_game >= MIN_BETS) {
            mainQual[`${r.userid}|${aid}|${mode}`] = { wp: r.winpercentage, total: r.total_game };
            nick[r.userid] = r.nickname;
            const b = perAlliance[aid].get(r.userid) || 0;
            if (r.winpercentage > b) perAlliance[aid].set(r.userid, r.winpercentage);
          }
        }
        if ((rows || []).length === 30 && rows[29].winpercentage >= THRESH_WP) more = true;
      }
      await sleep(jitter());
      if (page === 0) firstUid = pageFirst;
      else if (pageFirst === firstUid) break;               // 端點不吃 page 參數 → 同一頁，停
      if (!more) break;
    }
  }

  const picks = [];
  const dates = { today: twDate(0), tomorrow: twDate(1) };
  for (const { id: aid, lg } of ALLIANCES) {
    const uids = [...perAlliance[aid].entries()].sort((a, b) => b[1] - a[1]).slice(0, EXPERT_CAP).map(x => x[0]);
    console.log(`[a${aid} ${lg}] 合格高手 ${perAlliance[aid].size} 名，抓前 ${uids.length} 名`);
    for (const uid of uids) {
      for (const [day, date] of Object.entries(dates)) {
        let html;
        try { html = await getHTML(`${BASE}/member/${encodeURIComponent(uid)}/prediction?allianceid=${aid}&gameday=${day}`); }
        catch (e) { console.log(`  ⚠️ ${uid} ${day}: ${e.message}`); continue; }
        for (const p of parseExpertPage(html)) {
          const gt = gtOf(p.mode, p.kind);
          const q = gt != null ? qual[`${uid}|${aid}|${p.mode}|${gt}`] : null;
          const mq = p.main ? mainQual[`${uid}|${aid}|${p.mode}`] : null;
          if (!q && !mq) continue;                        // 非合格市場、也不是合格主推 → 不吃
          const src = q || mq;
          picks.push({
            league: lg, date: date, time: p.time,
            away: feedCanon(p.away, lg) || p.away, home: feedCanon(p.home, lg) || p.home,
            market: boardMarket(p.mode, p.kind),
            team: p.team ? (feedCanon(p.team, lg) || p.team) : null,
            side: p.side, line: p.line,
            srcMode: p.mode, srcLabel: q ? q.label : `主推`,
            wp: src.wp, total: src.total,
            main: p.main, free: p.free, result: p.result,
            uid: uid, nickname: nick[uid] || uid,
          });
        }
        await sleep(jitter());
      }
    }
  }

  // 去重：同人同場同市場同邊（today/tomorrow 頁重疊、或讓分+主推雙重身分）
  const seen = new Set(), dedup = [];
  for (const p of picks) {
    const k = [p.uid, p.league, p.date, p.away, p.home, p.time, p.market, p.team || p.side].join('|');
    if (seen.has(k)) continue;
    seen.add(k); dedup.push(p);
  }

  const out = {
    updated: stamp, during: DURING, thresholds: { wp: THRESH_WP, minBets: MIN_BETS },
    counts: { qualified: Object.keys(qual).length, mainQualified: Object.keys(mainQual).length, picks: dedup.length },
    picks: dedup,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`✅ 寫入 ${OUT}：合格市場 ${out.counts.qualified}、合格主推 ${out.counts.mainQualified}、明牌 ${dedup.length} 筆`);
}

if (require.main === module) {
  run().catch(e => { console.error('未預期錯誤：', e); process.exit(1); });
}
module.exports = { parsePick, parseExpertPage, boardMarket, gtOf, toHHMM, twDate, QUAL_GT, THRESH_WP, MIN_BETS };
