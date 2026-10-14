// Shared helpers for the closing-odds survey (read-only against git; caches blobs in ./cache).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const REPO = 'D:/Sportbetting-PLUS';
const HERE = __dirname;
const CACHE = path.join(HERE, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const REF = process.env.REF || 'dfc32f1838';

function git(args, opts = {}) {
  return execFileSync('git', ['-C', REPO, ...args], { maxBuffer: 1 << 30, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts });
}
function showBlob(rev, file) {
  const key = path.join(CACHE, (rev + '_' + file).replace(/[\\/:]/g, '_'));
  if (fs.existsSync(key)) return fs.readFileSync(key);
  const buf = git(['show', `${rev}:${file}`]);
  fs.writeFileSync(key, buf);
  return buf;
}
function showJSON(rev, file) { return JSON.parse(showBlob(rev, file).toString('utf8')); }
function fileCommits(file) { // newest first: [{h, t(ms)}]
  return git(['log', REF, '--format=%H %ct', '--', file]).toString().trim().split('\n').filter(Boolean)
    .map(l => { const [h, t] = l.split(' '); return { h, t: +t * 1000 }; });
}
function sampleCommits(file, everyHours, fromMs = 0) {
  const all = fileCommits(file).reverse(); // oldest first
  const out = []; let last = -Infinity;
  for (const c of all) { if (c.t < fromMs) continue; if (c.t - last >= everyHours * 3600e3) { out.push(c); last = c.t; } }
  if (all.length && out[out.length - 1] !== all[all.length - 1]) out.push(all[all.length - 1]);
  return out;
}

// --- team maps ---
const ZH_ID = { 天使: 108, 響尾蛇: 109, 金鶯: 110, 紅襪: 111, 小熊: 112, 紅人: 113, 守護者: 114, 印地安人: 114, 印第安人: 114,
  落磯: 115, 老虎: 116, 太空人: 117, 皇家: 118, 道奇: 119, 國民: 120, 大都會: 121, 運動家: 133, 海盜: 134,
  教士: 135, 水手: 136, 巨人: 137, 紅雀: 138, 光芒: 139, 遊騎兵: 140, 藍鳥: 141, 雙城: 142, 費城人: 143,
  勇士: 144, 白襪: 145, 馬林魚: 146, 洋基: 147, 釀酒人: 158 };
const ID_ABBR = { 108: 'LAA', 109: 'AZ', 110: 'BAL', 111: 'BOS', 112: 'CHC', 113: 'CIN', 114: 'CLE', 115: 'COL', 116: 'DET',
  117: 'HOU', 118: 'KC', 119: 'LAD', 120: 'WSH', 121: 'NYM', 133: 'ATH', 134: 'PIT', 135: 'SD', 136: 'SEA', 137: 'SF',
  138: 'STL', 139: 'TB', 140: 'TEX', 141: 'TOR', 142: 'MIN', 143: 'PHI', 144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL' };
const ABBR_ALIAS = { ARI: 'AZ', OAK: 'ATH', CHW: 'CWS', WSN: 'WSH', WAS: 'WSH', KCR: 'KC', SDP: 'SD', SFG: 'SF', TBR: 'TB', LA: 'LAD' };
function mlbAbbr(name) {
  if (!name) return null; const n = String(name).trim();
  if (ID_ABBR[ZH_ID[n]]) return ID_ABBR[ZH_ID[n]];
  for (const [zh, id] of Object.entries(ZH_ID)) if (n.endsWith(zh)) return ID_ABBR[id]; // e.g. 迈亚密馬林魚
  const u = n.toUpperCase(); if (Object.values(ID_ABBR).includes(u)) return u; if (ABBR_ALIAS[u]) return ABBR_ALIAS[u];
  return null;
}
const twMs = (date, time) => Date.parse(`${date}T${(time || '00:00').slice(0, 5)}:00+08:00`);

// --- targets ---
function loadTargets() {
  const h = showJSON(REF, 'data/analyst_history.json');
  const out = [];
  for (const [key, g] of Object.entries(h.games)) {
    out.push({ key, league: g.league, away: g.away, home: g.home, startMs: twMs(g.date, g.time), usDate: g.usDate, date: g.date, time: g.time, phase: g.phase, final: g.final });
  }
  return out;
}

// Match odds records (league, away, home, startMs) to targets: same teams (or swapped), |dt| <= tolH hours, closest wins.
function matchRecords(targets, records, tolH = 4) {
  const idx = new Map();
  for (const r of records) { const k = r.league + '|' + r.away + '|' + r.home; (idx.get(k) || idx.set(k, []).get(k)).push(r); }
  const res = new Map();
  for (const t of targets) {
    let best = null;
    for (const [a, b, sw] of [[t.away, t.home, false], [t.home, t.away, true]]) {
      for (const r of idx.get(t.league + '|' + a + '|' + b) || []) {
        const dt = Math.abs(r.startMs - t.startMs);
        if (dt <= tolH * 3600e3 && (!best || dt < best.dt || (dt === best.dt && !sw && best.swapped))) best = { r, dt, swapped: sw };
      }
    }
    if (best) res.set(t.key, best);
  }
  return res;
}

function readJsonlGz(buf) { return zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }

module.exports = { REPO, REF, CACHE, git, showBlob, showJSON, fileCommits, sampleCommits, mlbAbbr, twMs, loadTargets, matchRecords, readJsonlGz, ZH_ID, ID_ABBR };
