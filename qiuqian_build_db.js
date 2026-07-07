// qiuqian_build_db.js — 六十甲子籤建庫（求籤臂 A1）
// 來源A（正本）：北港朝天宮官網 60 首詳頁掃描圖（下載存檔+SHA256）
// 來源B（文字工作副本）：chance.org.tw 籤詩網（Big5）詩文/五行/籤解/故事
// 輸出：divination_lab/qiuqian_db.json + divination_lab/ctg_images/*.jpg + divination_lab/qiuqian_build_report.json
// 依賴：node_modules/iconv-lite（npm i iconv-lite --no-save）
// 用法：node qiuqian_build_db.js [--only ctg|chance] [--from N --to N]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const iconv = require('iconv-lite');

const ROOT = __dirname;
const LAB = path.join(ROOT, 'divination_lab');
const IMG_DIR = path.join(LAB, 'ctg_images');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const ONLY = argVal('--only', null);
const FROM = parseInt(argVal('--from', '1'), 10);
const TO = parseInt(argVal('--to', '60'), 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 700 + Math.floor(Math.random() * 500);

function fetchBuf(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(fetchBuf(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout ' + url)));
  });
}
async function fetchRetry(url) {
  try { return await fetchBuf(url); }
  catch (e) { await sleep(2500); return await fetchBuf(url); }
}

// 頁面快取：省重跑流量＋留存來源供審計
const CACHE = path.join(LAB, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
async function fetchCachedText(cacheName, url, enc) {
  const f = path.join(CACHE, cacheName);
  if (fs.existsSync(f) && fs.statSync(f).size > 2000) return fs.readFileSync(f, 'utf8');
  const buf = await fetchRetry(url);
  const txt = enc === 'big5' ? iconv.decode(buf, 'big5') : buf.toString('utf8');
  fs.writeFileSync(f, txt, 'utf8');
  await sleep(jitter());
  return txt;
}

function stripTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .split('\n').map(s => s.trim()).filter(Boolean);
}

// ── 期望干支序（六十甲子籤序：同干六支一組；甲丙戊庚壬配子寅辰午申戌、乙丁己辛癸配丑卯巳未酉亥）
const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI_EVEN = '子寅辰午申戌', ZHI_ODD = '丑卯巳未酉亥';
function expectedGanzhi(n) { // n: 1..60
  const s = Math.floor((n - 1) / 6), b = (n - 1) % 6;
  return GAN[s] + (s % 2 === 0 ? ZHI_EVEN[b] : ZHI_ODD[b]);
}
const normGz = s => (s || '').replace(/戍/g, '戌');

// ── 來源A：朝天宮 ─────────────────────────────
async function buildCtg(report) {
  const adids = fs.readFileSync(path.join(LAB, 'ctg_adids.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (adids.length !== 60) throw new Error('ctg_adids.txt 應有 60 行，實得 ' + adids.length);
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const out = {};
  for (const adid of adids) {
    const url = 'https://www.matsu.org.tw/?act=jieqianyuandi&cmd=detail&ad_id=' + adid;
    let html;
    try { html = await fetchCachedText('ctg_' + adid + '.html', url, 'utf8'); }
    catch (e) { report.errors.push({ src: 'ctg', adid, err: e.message }); continue; }
    const img = html.match(/<img[^>]*src="\.?\/?(upload_files[^"]+)"[^>]*alt="(\d+)\.(\S{2})"/);
    if (!img) { report.errors.push({ src: 'ctg', adid, err: 'parse fail: no content img' }); continue; }
    const h3 = html.match(/>第(\d+)籤\s*(\S{2})</); // 任意標籤內文；失敗則以 img alt 補救
    const n = h3 ? parseInt(h3[1], 10) : parseInt(img[2], 10);
    const gzSrc = h3 ? h3[2] : img[3];
    if (n < FROM || n > TO) continue;
    const imgUrl = 'https://www.matsu.org.tw/' + img[1];
    const ext = (imgUrl.match(/\.(jpe?g|png)$/i) || [, 'jpg'])[1].toLowerCase();
    const file = path.join(IMG_DIR, String(n).padStart(2, '0') + '_' + normGz(gzSrc) + '.' + ext);
    let buf;
    if (fs.existsSync(file) && fs.statSync(file).size > 10000) {
      buf = fs.readFileSync(file); // 斷點續跑：已下載即略過
    } else {
      await sleep(jitter());
      try { buf = await fetchRetry(imgUrl); fs.writeFileSync(file, buf); }
      catch (e) { report.errors.push({ src: 'ctg-img', adid, n, err: e.message }); continue; }
    }
    out[n] = {
      adId: adid, ganzhiRaw: gzSrc, ganzhi: normGz(gzSrc), altGanzhi: normGz(img[3]),
      pageUrl: url, imgUrl,
      imgFile: path.relative(ROOT, file).replace(/\\/g, '/'),
      imgBytes: buf.length, imgSha256: crypto.createHash('sha256').update(buf).digest('hex')
    };
    process.stdout.write('ctg ' + n + ' ok (' + buf.length + 'B)\n');
  }
  return out;
}

// ── 來源B：chance.org.tw ─────────────────────
const CHANCE_HOST = 'http://www.chance.org.tw';
const CHANCE_DIR_ENC = '/%E7%B1%A4%E8%A9%A9%E9%9B%86/%E5%85%AD%E5%8D%81%E7%94%B2%E5%AD%90%E7%B1%A4/';
const JIE_END_MARKERS = ['故事', '籤詩網整理資料'];

function parseChancePage(html) {
  const plain = stripTags(html);
  const rec = { jie: {}, storyTitles: [], storyText: '' };
  // 詩文：標題行【...】
  const t = plain.find(l => /__第\d+籤【.+】/.test(l)) || '';
  const tm = t.match(/__第(\d+)籤【(.+)】/);
  if (tm) {
    rec.n = parseInt(tm[1], 10);
    rec.poem = tm[2].split(/[，,、]/).map(s => s.trim()).filter(Boolean);
  }
  // 干支：所有獨立行【XX】為候選，優先取符合期望序者（audit 欄位；權威=朝天宮+期望序）
  const cands = plain.filter(l => /^【\S{2}】$/.test(l)).map(l => normGz(l.slice(1, 3)));
  rec.ganzhiCandidates = cands;
  if (rec.n) rec.ganzhi = cands.find(c => c === normGz(expectedGanzhi(rec.n))) || cands[0] || null;
  else rec.ganzhi = cands[0] || null;
  // 五行行：屬X利X 宜其XX
  rec.wuxing = plain.find(l => /^屬\S利\S/.test(l)) || null;
  // 籤解：藍色 font 標籤配對（限定 籤解→故事 區段）
  const a = html.indexOf('籤解'), b = html.indexOf('故事', a > 0 ? a : 0);
  if (a > 0 && b > a) {
    const seg = html.slice(a, b);
    for (const m of seg.matchAll(/<font color="#0000FF">([^<]+)<\/font>([\s\S]*?)<br>/gi)) {
      const key = m[1].trim();
      const val = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      if (key && val && key.length <= 4) rec.jie[key] = val;
    }
    // 後備：部分頁無藍色標記（如第7籤），改行式「分項名　斷語」解析
    if (Object.keys(rec.jie).length < 5) {
      for (const line of stripTags(seg)) {
        const m = line.match(/^(\S{2,3})[　\s]+(.{1,60})$/);
        if (m && m[1] !== '籤解' && !m[1].includes('故事')) rec.jie[m[1]] = m[2].trim();
      }
    }
  }
  // 故事標題：故事區的「N.標題」行
  let inStory = false;
  for (const l of plain) {
    if (l === '故事') { inStory = true; continue; }
    if (inStory) {
      if (JIE_END_MARKERS.includes(l) && l !== '故事') break;
      const sm = l.match(/^(\d+)\.(.+)$/);
      if (sm) rec.storyTitles.push(sm[2].trim());
      else if (rec.storyTitles.length) break;
    }
  }
  // 籤詩故事全文：籤詩故事 → 解籤參考/籤詩研究室
  const si = plain.indexOf('籤詩故事');
  if (si >= 0) {
    let end = plain.length;
    for (const stop of ['解籤參考', '籤詩研究室']) {
      const j = plain.indexOf(stop, si + 1);
      if (j > 0) end = Math.min(end, j);
    }
    rec.storyText = plain.slice(si + 1, end).join('\n');
  }
  return rec;
}

async function buildChance(report) {
  const idxBuf = await fetchRetry(CHANCE_HOST + CHANCE_DIR_ENC + encodeURIComponent('籤詩網‧六十甲子籤.htm'));
  const idx = iconv.decode(idxBuf, 'big5');
  const hrefs = [...idx.matchAll(/href="([^"]*__第\d+籤\.htm)"/g)].map(m => m[1]);
  if (hrefs.length !== 60) throw new Error('chance 索引應有 60 連結，實得 ' + hrefs.length);
  const out = {};
  for (const href of hrefs) {
    const n = parseInt(href.match(/__第(\d+)籤\.htm/)[1], 10);
    if (n < FROM || n > TO) continue;
    const url = CHANCE_HOST + CHANCE_DIR_ENC + encodeURIComponent(href);
    let html;
    try { html = await fetchCachedText('chance_' + String(n).padStart(2, '0') + '.html', url, 'big5'); }
    catch (e) { report.errors.push({ src: 'chance', n, err: e.message }); continue; }
    const rec = parseChancePage(html);
    rec.url = url;
    if (rec.n !== n) report.errors.push({ src: 'chance', n, err: 'n mismatch title=' + rec.n });
    out[n] = rec;
    process.stdout.write('chance ' + n + ' ok (poem=' + (rec.poem || []).length + ' jie=' + Object.keys(rec.jie).length + ' story=' + rec.storyTitles.length + ')\n');
  }
  return out;
}

// ── 主流程 ───────────────────────────────────
(async () => {
  const report = { startedAt: new Date().toISOString(), errors: [], checks: {} };
  let ctg = {}, chance = {};
  if (ONLY !== 'chance') ctg = await buildCtg(report);
  if (ONLY !== 'ctg') chance = await buildChance(report);

  const entries = [];
  for (let n = 1; n <= 60; n++) {
    const c = ctg[n] || null, h = chance[n] || null;
    const exp = expectedGanzhi(n);
    entries.push({
      n, ganzhiExpected: exp,
      ganzhi: (c && c.ganzhi) || (h && h.ganzhi) || exp,
      ganzhiMatch: { ctg: c ? c.ganzhi === exp : null, chance: h ? h.ganzhi === exp : null },
      poem: h ? h.poem || [] : [],
      wuxing: h ? h.wuxing : null,
      grade: null, // 等級標籤：chance 無此欄；以官方圖檔校字時回填（D6 決策點）
      jie: h ? h.jie : {},
      storyTitles: h ? h.storyTitles : [],
      storyText: h ? h.storyText : '',
      official: c, textSourceUrl: h ? h.url : null,
      proofread: false
    });
  }

  // 自我驗證
  const done = entries.filter(e => e.official && e.poem.length === 4);
  report.checks.entriesWithOfficialImg = entries.filter(e => e.official).length;
  report.checks.entriesWithPoem4 = entries.filter(e => e.poem.length === 4).length;
  report.checks.entriesWithQiuCai = entries.filter(e => e.jie['求財']).length;
  report.checks.entriesWithStory = entries.filter(e => e.storyTitles.length > 0).length;
  report.checks.ganzhiAllMatchCtg = entries.every(e => e.ganzhiMatch.ctg !== false);
  report.checks.ganzhiAllMatchChance = entries.every(e => e.ganzhiMatch.chance !== false);
  report.checks.poemInBody = null; // 詩文逐句應再現於內文（校字輔助，此處抽查第1籤於報告中人工核）
  report.finishedAt = new Date().toISOString();

  const db = {
    meta: {
      builtAt: report.finishedAt,
      system: '六十甲子籤（北港朝天宮版）',
      officialSource: 'https://www.matsu.org.tw/?act=menuinfo&ml_id=20240116003（60首詳頁掃描圖，正本）',
      textSource: 'http://www.chance.org.tw 籤詩網‧六十甲子籤（Big5，工作副本；衝突以官方圖為準）',
      proofreadPolicy: '逐首以官方圖檔視覺比對回填 grade 並將 proofread 置 true；校字只修抄錄錯誤不改廟方版本',
      counts: report.checks
    },
    entries
  };
  fs.writeFileSync(path.join(LAB, 'qiuqian_db.json'), JSON.stringify(db, null, 1), 'utf8');
  fs.writeFileSync(path.join(LAB, 'qiuqian_build_report.json'), JSON.stringify(report, null, 1), 'utf8');
  console.log('\n=== BUILD SUMMARY ===');
  console.log(JSON.stringify(report.checks, null, 1));
  console.log('errors: ' + report.errors.length);
  for (const e of report.errors.slice(0, 10)) console.log('  ', JSON.stringify(e));
  console.log('complete entries (img+poem4): ' + done.length + '/60');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
