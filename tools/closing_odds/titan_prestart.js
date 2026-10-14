// Titan (data/odds_log.json) bet365 spread close WITHOUT in-play contamination:
// for each start-time slot, read the odds_log version committed just before the slot and take hd.bet365 rows[0] there.
// usage: node titan_prestart.js [every=N]   (every=1 -> all ~665 slots; default 15 = sample)
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const every = +((process.argv.find(a => a.startsWith('every=')) || 'every=15').slice(6));
const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'records_static.json')));
const head = new Map(st.titan.map(r => [String(r.id), r]));
const commits = L.fileCommits('data/odds_log.json').reverse(); // oldest first
const starts = [...new Set(st.titan.map(r => r.startMs))].filter(x => x > 0).sort((a, b) => a - b);
const slots = []; for (const t of starts) { const s = slots[slots.length - 1]; if (s && t - s.last <= 20 * 60e3) { s.last = t; s.times.push(t); } else slots.push({ first: t, last: t, times: [t] }); }
const out = [];
let used = 0;
for (let i = 0; i < slots.length; i += every) {
  const s = slots[i];
  // latest commit at least 1 min before the slot's first start
  let lo = 0, hi = commits.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (commits[m].t <= s.first - 60e3) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) continue;
  const c = commits[k];
  const d = JSON.parse(L.git(['show', `${c.h}:data/odds_log.json`]).toString('utf8')); used++;
  for (const [id, m] of Object.entries(d.matches)) {
    const start = Date.parse(m.startISO); if (m.league !== 'mlb' || !s.times.includes(start)) continue;
    const rows = (m.hd && m.hd.bet365) || []; const r0 = rows[0];
    const hr = head.get(String(id));
    const pre = r0 ? { line: r0.line, home: +(r0.home + 1).toFixed(3), away: +(r0.away + 1).toFixed(3) } : null;
    out.push({ id, startISO: m.startISO, away: L.mlbAbbr(m.awayTeam), home: L.mlbAbbr(m.homeTeam), commitAgeMin: Math.round((start - c.t) / 60e3), pre, preRows: rows.length,
      headRow0: hr && hr.hd ? { line: hr.hd.rawLine, home: hr.hd.home, away: hr.hd.away } : null, headRows: hr ? ((head.get(String(id)) || {}).hdRowsN) : null });
  }
}
fs.writeFileSync(path.join(__dirname, `titan_prestart_every${every}.json`), JSON.stringify(out, null, 0));
const same = out.filter(o => o.pre && o.headRow0 && String(o.pre.line) === String(o.headRow0.line) && o.pre.home === o.headRow0.home && o.pre.away === o.headRow0.away).length;
const pre15 = out.filter(o => o.pre && Math.abs(+o.pre.line) === 1.5).length;
const head15 = out.filter(o => o.headRow0 && Math.abs(+o.headRow0.line) === 1.5).length;
const ages = out.map(o => o.commitAgeMin).sort((a, b) => a - b);
console.log(`versions read ${used}, games ${out.length}; pre-start row0 == HEAD row0: ${same}; pre-start |line|=1.5: ${pre15}; HEAD row0 |line|=1.5: ${head15}; commit age before start min p50=${ages[ages.length >> 1]} p90=${ages[Math.floor(ages.length * 0.9)]} max=${ages[ages.length - 1]}`);
const byMo = {}; for (const o of out) { const mo = o.startISO.slice(0, 7); byMo[mo] ||= { n: 0, same: 0 }; byMo[mo].n++; if (o.pre && o.headRow0 && String(o.pre.line) === String(o.headRow0.line) && o.pre.home === o.headRow0.home) byMo[mo].same++; }
console.log('by month (n, HEAD row0 still equal to pre-start row0):', JSON.stringify(byMo));
