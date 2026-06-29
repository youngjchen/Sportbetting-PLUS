/* ============================================================
   computeC1.js — 神刻投手生年干「C1」前瞻訊號計算（路1 半自動）
   ------------------------------------------------------------
   ▌預先註冊規則 v1（2026-06-29 凍結；上線後不准事後改，避免多重比較自欺）▐
   用神 / 判據：
     · 盤      = 開賽時刻的「神刻奇門盤」(yixinsoft /qimen/shenke，台灣時鐘、轉盤拆補)。
     · 投手    = 該場「實際先發投手」(非被換掉的 probable)。生年干 = 天干[(西元出生年−4) mod 10]。
     · 落宮    = 生年干在神刻盤的落宮（先取天盤，無則地盤）。
     · 破敗    = 該宮犯「擊刑 / 入墓 / 門迫 / 空亡」之數量（陰盤真口訣，無生剋無吉凶分級）。
                 入墓: 甲乙→坤2 丙丁戊己→乾6 庚辛→艮8 壬癸→巽4（干落其墓庫宮）。
                 擊刑(六儀): 戊→震3 己→坤2 庚→艮8 辛→离9 壬→巽4 癸→巽4。
                 門迫: 宮(五行)克門(五行)。 空亡: 該宮 kong 非空字串。
     · C1 選邊 = 破敗較少的一方（home 投手破敗 < away 投手破敗 → 押 home；> → 押 away；相等 → 無訊號 null）。
   可用形態（驗證門檻，前瞻累積後才判定）：
     · 單獨對抗市場無價值（逆收盤熱門僅 ~51.5%）→ C1 僅作「確認過濾器」。
     · 行動規則 = 「C1 選邊」與「收盤(close) ML 熱門」同邊時，加強該熱門注；不同邊則不出手。
     · 啟用門檻（n≥100 時一次性判定，之後持續監看、不准移動門檻）：
         rate≥58% 且 Wilson 95%CI 下界≥54% → ✅ 可參考下注
         52%≤rate<58% 或 CI 跨基準              → ⚠ 觀察中（趨勢未定）
         rate<52%                               → ❌ 雜訊，放棄
       （基準 = 同期「無腦押收盤熱門」≈55%；要明顯高於它才有附加價值。）
   回測現況（actual starter，已含甲遁旬首定位，N=542/「與熱門一致」子集 n=268）：
     標準型 C1 55.4%、一致子集 60.8%（前63%/後58%），安慰劑 p=0.007、前後半穩定；
     逆熱門僅 49.8%（無獨立價值）。過不了全study多重比較 → 屬「待驗證假設」，未證實、勿提前下注。
   ------------------------------------------------------------
   輸入：--games data/mlb_games.json  --bdays data/pitcher_birthdays.json
   輸出：--out   data/qimen_c1.json   { gameKey: {pick,homeBroken,awayBroken,ygHome,ygAway,
              gongHome,gongAway,neikeJu,actualStarter,computedAt} }
   用法：node computeC1.js [--from 2026-06-20] [--to 2026-06-29] [--limit N] [--selftest]
   去重：同 gameKey 已存在即略過（神刻盤由時間完全決定，可隨時續跑）。
   禮儀：沿用 qimen_scraper 的 UA 與 0.5~1.2s 隨機延遲；每場只打 1 個請求（只抓神刻盤）。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parseChart, gameKey, castParams } = require('./qimen_scraper');

const BASE = 'https://www.yixinsoft.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rndDelay = () => sleep(500 + Math.floor(Math.random() * 700));
const arg = (k, d) => { const i = process.argv.indexOf(k); if (i >= 0) return process.argv[i + 1]; const h = process.argv.find(a => a.startsWith(k + '=')); return h ? h.split('=').slice(1).join('=') : d; };
const has = (k) => process.argv.includes(k);
const loadJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };

// ---- 五行 / 破敗 規則表（與 qimen_features.py 一致；簡體宮名，對齊 yixinsoft 解析）----
const GONG_WX = { '坎一宫': '水', '坤二宫': '土', '震三宫': '木', '巽四宫': '木', '中五宫': '土', '乾六宫': '金', '兑七宫': '金', '艮八宫': '土', '离九宫': '火' };
const MEN_WX = { '休门': '水', '生门': '土', '伤门': '木', '杜门': '木', '景门': '火', '死门': '土', '惊门': '金', '开门': '金' };
const KE = { '木': '土', '土': '水', '水': '火', '火': '金', '金': '木' };
const GAN_MU_GONG = { '甲': '坤二宫', '乙': '坤二宫', '丙': '乾六宫', '丁': '乾六宫', '戊': '乾六宫', '己': '乾六宫', '庚': '艮八宫', '辛': '艮八宫', '壬': '巽四宫', '癸': '巽四宫' };
const YI_JIXING_GONG = { '戊': '震三宫', '己': '坤二宫', '庚': '艮八宫', '辛': '离九宫', '壬': '巽四宫', '癸': '巽四宫' };
const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
// 甲遁六儀:生年干=甲時,甲藏於旬首,須改用旬首六儀在盤上定位(否則甲找不到→該場被誤丟)
const XUNSHOU = { '甲子': '戊', '甲戌': '己', '甲申': '庚', '甲午': '辛', '甲辰': '壬', '甲寅': '癸' };

function yearGan(birthDate) {
  const y = parseInt(String(birthDate || '').slice(0, 4), 10);
  return isNaN(y) ? null : GAN[(((y - 4) % 10) + 10) % 10];
}
// 真正用來在盤上定位的天干:甲→旬首六儀,其餘=本干
function locateStem(birthDate) {
  const y = parseInt(String(birthDate || '').slice(0, 4), 10);
  if (isNaN(y)) return null;
  const g = GAN[(((y - 4) % 10) + 10) % 10];
  if (g !== '甲') return g;
  return XUNSHOU['甲' + ZHI[(((y - 4) % 12) + 12) % 12]];
}
function findGong(pals, stem, layer) {
  for (const nm in pals) { const arr = pals[nm] && pals[nm][layer]; if (Array.isArray(arr) && arr.includes(stem)) return nm; }
  return null;
}
function brokenAt(pals, gong, stem) {
  const p = pals[gong]; if (!p) return null;
  const men = p.men || '';
  const kong = !!(p.kong && String(p.kong).trim());
  const rumu = GAN_MU_GONG[stem] === gong;
  const jixing = YI_JIXING_GONG[stem] === gong;            // 僅六儀(戊己庚辛壬癸)會命中
  const mw = MEN_WX[men], gw = GONG_WX[gong];
  const pomen = (mw && gw) ? (KE[gw] === mw) : false;       // 宮克門 = 門迫
  return (kong ? 1 : 0) + (rumu ? 1 : 0) + (jixing ? 1 : 0) + (pomen ? 1 : 0);
}
function pitcherBroken(chart, birthDate) {
  const stem = locateStem(birthDate); if (!stem) return null;   // 甲遁→旬首
  const pals = (chart && chart.palaces) || {};
  const gong = findGong(pals, stem, 'tian') || findGong(pals, stem, 'di');
  if (!gong) return null;
  return { yg: yearGan(birthDate), locStem: stem, gong, broken: brokenAt(pals, gong, stem) };
}

// 只抓神刻盤（每場 1 請求）
function buildBody(cast) {
  return new URLSearchParams({
    timeType: 'GongLi', year: String(cast.year), month: String(cast.month), day: String(cast.day),
    hour: String(cast.hour), minute: String(cast.minute),
    paiPanType: 'ZhuanPan', qiJuType: 'ChaiBu', runyue: '0', name: '', sex: '1', txtWhy: ''
  }).toString();
}
async function fetchShenke(date, gameTime) {
  const cast = castParams(date, gameTime, 0);
  if (!cast) return null;
  const r = await axios.post(BASE + '/qimen/shenke', buildBody(cast), {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000
  });
  return parseChart(r.data);
}

function computeOne(chart, g, bdays) {
  const hp = g.homePitcher, ap = g.awayPitcher;
  const hb = hp && bdays[hp.id] ? pitcherBroken(chart, bdays[hp.id].birthDate) : null;
  const ab = ap && bdays[ap.id] ? pitcherBroken(chart, bdays[ap.id].birthDate) : null;
  if (!hb || !ab || hb.broken === ab.broken) {
    return { pick: null, homeBroken: hb ? hb.broken : null, awayBroken: ab ? ab.broken : null,
      ygHome: hb && hb.yg, ygAway: ab && ab.yg, gongHome: hb && hb.gong, gongAway: ab && ab.gong,
      neikeJu: chart.ju || null, actualStarter: g.status === 'Final', reason: hb && ab ? 'tie' : 'missing' };
  }
  return {
    pick: hb.broken < ab.broken ? 'home' : 'away',
    homeBroken: hb.broken, awayBroken: ab.broken, ygHome: hb.yg, ygAway: ab.yg,
    gongHome: hb.gong, gongAway: ab.gong, neikeJu: chart.ju || null,
    actualStarter: g.status === 'Final', computedAt: new Date().toISOString()
  };
}

async function main() {
  if (has('--selftest')) {
    const chart = await fetchShenke('2026-04-02', '00:15');
    console.log('神刻盤局：', chart && chart.ju, '宮數：', chart && Object.keys(chart.palaces || {}).length);
    console.log('示例破敗(生年1989=己)：', pitcherBroken(chart, '1989-03-30'));
    return;
  }
  const games = loadJson(arg('--games', path.join('data', 'mlb_games.json')), []);
  const bdays = loadJson(arg('--bdays', path.join('data', 'pitcher_birthdays.json')), {});
  const qimenCache = arg('--qimen') ? loadJson(arg('--qimen'), {}) : {};   // 已抓的神刻盤(回補/續跑用,免再打 yixinsoft)
  const outPath = arg('--out', path.join('data', 'qimen_c1.json'));
  const out = loadJson(outPath, {});
  const from = arg('--from'), to = arg('--to'), limit = parseInt(arg('--limit', '0'), 10);
  let done = 0, skip = 0, fail = 0, cached = 0;
  for (const g of games) {
    const key = g.key || gameKey(g.date, g.away, g.home, g.gameTime);
    if (out[key]) { skip++; continue; }
    if (from && g.date < from) continue;
    if (to && g.date > to) continue;
    if (!g.homePitcher || !g.awayPitcher) continue;
    try {
      let chart = qimenCache[key] && qimenCache[key].shenkeStart;        // 先用快取
      if (!chart || !chart.palaces) { chart = await fetchShenke(g.date, g.gameTime); await rndDelay(); } // 沒快取才連線
      else cached++;
      out[key] = computeOne(chart, g, bdays);
      done++;
      if (done % 100 === 0) { fs.writeFileSync(outPath, JSON.stringify(out)); console.log(`  ...已算 ${done}（快取 ${cached}；最新 ${key} → ${out[key].pick || '無訊號'}）`); }
    } catch (e) { fail++; console.log('  ✗', key, (e.message || '').slice(0, 60)); }
    if (limit && done >= limit) break;
  }
  console.log(`（其中 ${cached} 場用快取神刻盤、${done - cached} 場現抓）`);
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`完成：新算 ${done}、略過(已存) ${skip}、失敗 ${fail} → ${outPath}（共 ${Object.keys(out).length} 場）`);
}
if (require.main === module) main();
module.exports = { pitcherBroken, computeOne, yearGan, brokenAt };
