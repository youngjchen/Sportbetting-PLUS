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

/* ---- 追蹤名單白名單（data/expert_whitelist.json，使用者可直接編輯）---- */
const WHITELIST_FILE = path.join('data', 'expert_whitelist.json');
function loadWhitelist() {
  const out = {};
  for (const { lg } of ALLIANCES) out[lg] = [];
  try {
    const j = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    for (const { lg } of ALLIANCES) if (Array.isArray(j[lg])) out[lg] = j[lg].filter(x => typeof x === 'string' && x);
  } catch (_) {}
  return out;
}

/* ---- 排程感知：決定本輪模式（純函式，供測試）----
   cron 每 30 分打一次（:03/:33），腳本自己決定要不要做事：
   · full：台灣 0/9/12/15/18/21 點的 :03 檔（或手動 dispatch）→ 打榜單＋全聯盟＋今明兩天。
     00:03 那檔就是吃「MLB 半夜貼單」的主力。
   · final：某聯盟有比賽將在 35~65 分鐘後開打 → 賽前終盤確認（吃臨場貼單＋半夜偷改單），
     只抓該聯盟、只抓今天、榜單用快取。30 分 cron × 30 分寬的窗 = 每個開賽群恰好命中一次。
   · skip：其他時段 → 零請求收工（對站方禮貌的關鍵：頻率高的是「檢查」，不是「抓取」）。
   同聯盟 45 分鐘內不重複 final（lastFinal 記在輸出檔）。 */
// full 觸發改「距上次 full ≥ FULL_GAP_H 小時」而非鐘面整點：GitHub cron 實測延遲 25~55 分
// 且大量丟檔（2026-07-18：16:33→16:58、18:03→18:40、15:33/16:03/17:03 直接消失），
// 看鐘面的判斷會被延遲打穿；看間隔則不管哪個 tick 活著到場都能接棒。約 8 輪 full/天。
const FULL_GAP_H = 3;
function decideMode(nowMs, sched, lastFinal, eventName, lastFullAt) {
  if (eventName === 'workflow_dispatch') return { mode: 'full' };
  const lastFull = lastFullAt ? Date.parse(lastFullAt) : 0;
  if (nowMs - lastFull >= FULL_GAP_H * 3600e3) return { mode: 'full' };
  // 終盤窗 [25,70] 分＋40 分防重複：正常命中賽前 40~70 分（抓完+上傳 ≈ 賽前 35 分資料就緒，
  // 板上 5 分刷新 → 賽前 20 分穩到手，2026-07-18 使用者要求的下注緩衝）；
  // GitHub cron 延遲時 25~40 分的兜底檔仍會補抓，不會整群漏掉。
  const lgs = new Set();
  for (const g of sched || []) {
    const dm = (g.startMs - nowMs) / 60000;
    if (dm >= 25 && dm <= 70) {
      const last = lastFinal && lastFinal[g.lg] ? Date.parse(lastFinal[g.lg]) : 0;
      if (nowMs - last >= 40 * 60000) lgs.add(g.lg);
    }
  }
  if (lgs.size) return { mode: 'final', leagues: [...lgs] };
  return { mode: 'skip' };
}

// 官方賽程（玩運彩 feed：今明兩天all場次）→ [{lg, startMs}]
function loadScheduleTimes() {
  const out = [];
  try {
    const feed = JSON.parse(fs.readFileSync(path.join('data', 'pregame_data.json'), 'utf8'));
    for (const g of (Array.isArray(feed) ? feed : Object.values(feed))) {
      const lg = String(g.league || '').toLowerCase();
      const t = (String(g.time || '').match(/\d{1,2}:\d{2}/) || [])[0];
      if (!lg || !g.date || !t) continue;
      const ms = Date.parse(`${g.date}T${t}:00+08:00`);
      if (!isNaN(ms)) out.push({ lg: lg, startMs: ms });
    }
  } catch (_) {}
  return out;
}

function loadPrev() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return null; }
}

// 合併：本輪掃過的 (league|date) 以新結果為準（高手改單/撤單跟著更新），其餘沿用上一輪
function mergePicks(prevPicks, newPicks, scopes) {
  return (prevPicks || []).filter(p => !scopes.has(p.league + '|' + p.date)).concat(newPicks);
}

// 清晨場日界修正（2026-07-20 胡小凱案）：playsport 傍晚後把「明晨場」滾進 today 頁
// （MLB 賽事日跟美國日期走），照頁籤給日期會把 7/21 晨場記成 7/20 → 板上 7/21 卡看不到，
// 且 scope 取代會把先前正確的 7/21 單洗掉。
// 規則：today 頁、尚無結果、開球 < 12:00、且距現在已「過去」≥300 分 → 歸 +1 天。
// 300 分＋正午上限＝避開亞洲午間在打場（KBO 13:00 雙重賽 G1、NPB 12:00 場結果未填時不受影響）。
function fixMorningDate(day, date, p, nowMin, plusOneDate) {
  if (day !== 'today' || p.result) return date;
  const m = /^(\d\d):(\d\d)/.exec(String(p.time || ''));
  if (!m) return date;
  const t = (+m[1]) * 60 + (+m[2]);
  if (t < 720 && (nowMin - t) >= 300) return plusOneDate;
  return date;
}

// 從快取的合格表重建「每聯盟 uid→最佳勝率」（final 模式不打榜單）
function rosterFromQual(qual, mainQual, aid) {
  const m = new Map();
  const eat = obj => {
    for (const [k, v] of Object.entries(obj || {})) {
      const parts = k.split('|');
      if (String(parts[1]) !== String(aid)) continue;
      if ((v && v.wp) > (m.get(parts[0]) || 0)) m.set(parts[0], v.wp);
    }
  };
  eat(qual); eat(mainQual);
  return m;
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

/* ---- 個人戰績頁（季）解析：榜外白名單的合格判定源 ----
   使用者 2026-07-18：白名單一樣只吃合格市場（不是全抓）。榜單抓不到的人
   （注數<30 或榜外），用 /member/{uid}/record/winRate?during=season&allianceid=N
   的分市場戰績表判定：國際盤表(universe-tablecon)/運彩盤表(bank-tablecon)，
   列＝讓分盤/大小盤/不讓分/主推(無文字標籤列)，欄＝勝場/敗場/勝率/獲利。 */
function parseRecordStats(html) {
  const $ = cheerio.load(html);
  const out = [];
  const TABLES = [{ sel: 'table.universe-tablecon', mode: 2 }, { sel: 'table.bank-tablecon', mode: 1 }];
  for (const { sel, mode } of TABLES) {
    $(sel).each((_, tbl) => {
      const $t = $(tbl);
      if ($t.parents('table').length) return;
      if (!/勝場/.test($t.text())) return;                 // 個人「預測」頁同名表格 → 跳過
      $t.find('tr').each((_, tr) => {
        const c = $(tr).children('td,th').map((i, x) => $(x).text().replace(/\s+/g, ' ').trim()).get();
        if (c.length < 4) return;
        const w = parseInt(c[1], 10), l = parseInt(c[2], 10);
        if (isNaN(w) || isNaN(l)) return;
        let kind = null;
        if (/讓分盤/.test(c[0])) kind = 'hd';
        else if (/大小盤/.test(c[0])) kind = 'ou';
        else if (/不讓分/.test(c[0])) kind = 'ml';
        else if (/總勝率/.test(c[0])) return;
        else if (!c[0] || $(tr).find('img[alt="主推"]').length) kind = 'main';   // 主推列用圖示、無文字
        if (!kind) return;
        const total = w + l;
        out.push({ mode: mode, kind: kind, w: w, l: l, total: total, wp: total ? Math.round(100 * w / total) : 0 });
      });
    });
  }
  return { stats: out, nickname: $('.memberidname').first().text().trim() || null };
}

/* ---- 主流程 ---- */
async function run() {
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
  const prev = loadPrev();
  const decision = decideMode(Date.now(), loadScheduleTimes(), (prev && prev.lastFinal) || {}, process.env.GITHUB_EVENT_NAME || '', prev && prev.lastFullAt);
  console.log(`==================== expert_picks ${stamp} mode=${decision.mode}${decision.leagues ? '(' + decision.leagues.join(',') + ')' : ''} ====================`);
  if (decision.mode === 'skip') {
    console.log('· 非整點全掃時段、也沒有 35~65 分內開打的比賽 → 本輪不抓（對站方零請求）');
    return;
  }
  const WL = loadWhitelist();
  const targets = decision.mode === 'full' ? ALLIANCES : ALLIANCES.filter(a => decision.leagues.indexOf(a.lg) >= 0);
  const dates = decision.mode === 'full' ? { today: twDate(0), tomorrow: twDate(1) } : { today: twDate(0) };

  let qual = {};          // `${uid}|${aid}|${mode}|${gt}` -> {wp,w,l,total,label}
  let mainQual = {};      // `${uid}|${aid}|${mode}` -> {wp,total}
  let nick = {};          // uid -> nickname
  const perAlliance = {}; // aid -> Map(uid -> bestWp)
  const cacheFresh = prev && prev.qualCache && prev.qualCache.at && (Date.now() - Date.parse(prev.qualCache.at)) < 12 * 3600e3;
  const useCache = decision.mode === 'final' && cacheFresh;
  if (useCache) {
    qual = prev.qualCache.qual || {}; mainQual = prev.qualCache.mainQual || {}; nick = prev.qualCache.nick || {};
    for (const { id: aid } of targets) perAlliance[aid] = rosterFromQual(qual, mainQual, aid);
    console.log(`· 榜單用快取（${prev.qualCache.at}），終盤確認只抓個人頁`);
  } else for (const { id: aid } of targets) {
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

  // 白名單一律補抓個人戰績頁(季)判定合格市場（60%+30注同一把尺）；結果進 qual/mainQual
  // 不可因「榜上已有身分」跳過：榜單只覆蓋部分市場（例：主推榜上榜≠讓分合格，
  // 劉小武運彩讓分65%/130注因不在讓分榜前段而被漏）。榜單數字優先，戰績頁只補缺的市場鍵。
  // （會一起存進 qualCache，final 模式直接沿用、不重抓）
  if (!useCache) {
    for (const { id: aid, lg } of targets) {
      for (const uid of WL[lg] || []) {
        let rec;
        try { rec = parseRecordStats(await getHTML(`${BASE}/member/${encodeURIComponent(uid)}/record/winRate?during=${DURING}&allianceid=${aid}`)); }
        catch (e) { console.log(`  ⚠️ 戰績頁 ${uid} a${aid}: ${e.message}`); await sleep(jitter()); continue; }
        let best = 0;
        for (const s of rec.stats) {
          if (s.wp < THRESH_WP || s.total < MIN_BETS) continue;
          if (s.kind === 'main') {
            const k = `${uid}|${aid}|${s.mode}`;
            if (!mainQual[k]) mainQual[k] = { wp: s.wp, total: s.total };
          } else {
            const gt = gtOf(s.mode, s.kind);
            if (gt == null) continue;
            const k = `${uid}|${aid}|${s.mode}|${gt}`;
            if (!qual[k]) qual[k] = { wp: s.wp, w: s.w, l: s.l, total: s.total, label: '追蹤·' + QUAL_GT[s.mode][gt] };
          }
          if (s.wp > best) best = s.wp;
        }
        const b0 = (perAlliance[aid] = perAlliance[aid] || new Map()).get(uid) || 0;
        if (best > b0) perAlliance[aid].set(uid, best);
        if (rec.nickname && !nick[uid]) nick[uid] = rec.nickname;
        await sleep(jitter());
      }
    }
  }

  const picks = [];
  const coverage = {};
  for (const { id: aid, lg } of targets) {
    const uids = [...(perAlliance[aid] || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, EXPERT_CAP).map(x => x[0]);
    for (const w of WL[lg] || []) if (uids.indexOf(w) < 0) uids.push(w);   // 追蹤名單必抓、不占名額
    coverage[lg] = { qualified: (perAlliance[aid] || new Map()).size, fetched: uids.length, whitelist: (WL[lg] || []).length };
    console.log(`[a${aid} ${lg}] 合格 ${coverage[lg].qualified} 名，抓 ${uids.length} 名（含追蹤名單 ${coverage[lg].whitelist}）`);
    for (const uid of uids) {
      for (const [day, date] of Object.entries(dates)) {
        let html;
        try { html = await getHTML(`${BASE}/member/${encodeURIComponent(uid)}/prediction?allianceid=${aid}&gameday=${day}`); }
        catch (e) { console.log(`  ⚠️ ${uid} ${day}: ${e.message}`); continue; }
        for (const p of parseExpertPage(html)) {
          const gt = gtOf(p.mode, p.kind);
          const q = gt != null ? qual[`${uid}|${aid}|${p.mode}|${gt}`] : null;
          const mq = p.main ? mainQual[`${uid}|${aid}|${p.mode}`] : null;
          // 60% 教義一體適用：榜上合格看榜單、榜外白名單看戰績頁(已灌進 qual/mainQual)，
          // 兩者都沒有 → 不吃（使用者 2026-07-18 確認：白名單也只吃合格市場）。
          if (!q && !mq) continue;
          const src = q || mq;
          const nowTw = new Date(Date.now() + 8 * 3600e3);
          const nowMin = nowTw.getUTCHours() * 60 + nowTw.getUTCMinutes();
          picks.push({
            league: lg, date: fixMorningDate(day, date, p, nowMin, twDate(1)), time: p.time,
            away: feedCanon(p.away, lg) || p.away, home: feedCanon(p.home, lg) || p.home,
            market: boardMarket(p.mode, p.kind),
            team: p.team ? (feedCanon(p.team, lg) || p.team) : null,
            side: p.side, line: p.line,
            srcMode: p.mode, srcLabel: q ? q.label : '主推',
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
  // at＝這筆單「首次被抓到」的時間（沿用上一輪同鍵的 at）；高手改單＝新鍵＝新時間 → 板上可辨識更新
  const prevAt = {};
  for (const p of (prev && prev.picks) || []) {
    prevAt[[p.uid, p.league, p.date, p.away, p.home, p.time, p.market, p.team || p.side].join('|')] = p.at;
  }
  const seen = new Set(), dedup = [];
  for (const p of picks) {
    const k = [p.uid, p.league, p.date, p.away, p.home, p.time, p.market, p.team || p.side].join('|');
    if (seen.has(k)) continue;
    seen.add(k); p.at = prevAt[k] || stamp; dedup.push(p);
  }

  // 合併上一輪：本輪掃過的 (league,date) 用新結果整批取代，其餘沿用；只留昨天以後（歷史在 git）
  const scopes = new Set();
  for (const { lg } of targets) for (const date of Object.values(dates)) scopes.add(lg + '|' + date);
  const cutoff = twDate(-1);
  const merged = mergePicks(prev && prev.picks, dedup, scopes).filter(p => p.date >= cutoff);

  const lastFinal = Object.assign({}, (prev && prev.lastFinal) || {});
  if (decision.mode === 'final') for (const lg of decision.leagues) lastFinal[lg] = stamp;

  const out = {
    updated: stamp, mode: decision.mode, during: DURING, thresholds: { wp: THRESH_WP, minBets: MIN_BETS },
    lastFullAt: decision.mode === 'full' ? stamp : ((prev && prev.lastFullAt) || null),
    counts: { qualified: Object.keys(qual).length, mainQualified: Object.keys(mainQual).length, picks: merged.length, newThisRun: dedup.length },
    coverage: coverage,
    lastFinal: lastFinal,
    qualCache: useCache ? prev.qualCache : { at: stamp, qual: qual, mainQual: mainQual, nick: nick },
    picks: merged,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`✅ 寫入 ${OUT}（${decision.mode}）：本輪 ${dedup.length} 筆、合併後 ${merged.length} 筆、合格市場 ${out.counts.qualified}、合格主推 ${out.counts.mainQualified}`);
}

if (require.main === module) {
  run().catch(e => { console.error('未預期錯誤：', e); process.exit(1); });
}
module.exports = { parsePick, parseExpertPage, parseRecordStats, boardMarket, gtOf, toHHMM, twDate, QUAL_GT, THRESH_WP, MIN_BETS, decideMode, mergePicks, loadWhitelist, loadScheduleTimes, rosterFromQual, FULL_GAP_H, fixMorningDate };
