// 變體：ML 取最優一組；±1.5 讓分保留「每個讓分方向各一組」（Stake 優先、A 級優先），
// 因為 Stake 封存常存另開盤（熱門 +1.5），bet365 存主盤（冷門 +1.5），兩組都是真價、對應不同推薦。
// 輸出 closing_multi.json = { targetKey: { ml:{away,home,book,q,src}|null, spreads:[{line,favorite,away,home,book,q,src}] } }
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f)));
const st = rd('records_static.json'); const hi = rd('records_history.json');
const tp = rd('titan_prestart_every1.json');
const titanML = new Map(st.titan.map((r) => [String(r.id), r.ml]));
const titanPre = tp.map((o) => { const ln = +(o.pre && o.pre.line); return { league: 'MLB', away: o.away, home: o.home, startMs: Date.parse(o.startISO),
  ml: titanML.get(String(o.id)) && titanML.get(String(o.id)).kind === 'live-pre' ? titanML.get(String(o.id)) : null,
  hd: o.pre ? { fav: ln > 0 ? 'home' : ln < 0 ? 'away' : null, line: Math.abs(ln), home: o.pre.home, away: o.pre.away, gapMin: o.commitAgeMin } : null }; });
const T = L.loadTargets();
const ok = (o) => o && o.home > 1 && o.away > 1;
const gapOf = (x, r) => (x.gapMin != null ? x.gapMin : x.at ? Math.round((r.startMs - Date.parse(x.at)) / 60e3) : null);
const qual = (x, r) => { if (x.final || x.kind === 'close' || x.kind === 'mlClose') return 'A'; const g = gapOf(x, r); return g == null ? 'C' : g < -2 ? 'X' : g <= 60 ? 'A' : g <= 720 ? 'B' : 'C'; };
const SRC = [
  ['stake:op_archive', 'stake', [].concat(...['04', '05', '06', '07', '08'].map((m) => st[`data/oddsportal_archive/2026-${m}.json`]), st['data/2026-08.json'])],
  ['stake:baseball_stake_odds', 'stake', hi['hist:baseball_stake_odds:hd15']],
  ['stake:op_summary_hist', 'stake', hi['hist:oddsportal_summary:hd15']],
  ['stake:stake_api_odds', 'stake', hi['hist:stake_api_odds:hd15']],
  ['stake:stake_odds.json', 'stake', st['data/stake_odds.json']],
  ['b365:baseball_bet365_odds', 'bet365', hi['hist:baseball_bet365_odds:hd15']],
  ['b365:nhl_bet365_odds', 'bet365', hi['hist:nhl_bet365_odds:hd15']],
  ['b365:titan_prestart', 'bet365', titanPre],
  ['b365:bf_labeled', 'bet365', st.bf_labeled],
];
const matched = SRC.map(([name, book, recs]) => {
  const m = L.matchRecords(T, (recs || []).filter((r) => r.away && r.home));
  const owner = new Map(); for (const [k, x] of m) { const o = owner.get(x.r); if (!o || x.dt < o.dt) owner.set(x.r, { k, dt: x.dt }); }
  for (const [k, x] of [...m]) if (owner.get(x.r).k !== k) m.delete(k);
  return { name, book, m };
});
const out = {}; const stat = { ml: 0, spreadGames: 0, twoSides: 0, q: {} };
for (const t of T) {
  const res = { ml: null, spreads: [] };
  for (const allowQ of [['A'], ['A', 'B']]) {
    for (const { name, book, m } of matched) {
      const x = m.get(t.key); if (!x) continue; const r = x.r;
      const flip = (o) => (x.swapped ? { ...o, home: o.away, away: o.home, fav: o.fav === 'home' ? 'away' : o.fav === 'away' ? 'home' : o.fav } : o);
      if (!res.ml && ok(r.ml)) { const q = qual(r.ml, r); if (allowQ.includes(q)) res.ml = { ...flip({ away: r.ml.away, home: r.ml.home }), book, q, src: name }; }
      const hd = r.hd;
      if (ok(hd) && hd.line === 1.5 && (hd.fav === 'home' || hd.fav === 'away')) {
        const q = qual(hd, r); if (!allowQ.includes(q)) continue;
        const f = flip({ fav: hd.fav, away: hd.away, home: hd.home });
        if (!res.spreads.some((s) => s.favorite === f.fav)) res.spreads.push({ line: 1.5, favorite: f.fav, away: f.away, home: f.home, book, q, src: name });
      }
    }
  }
  out[t.key] = res;
  if (res.ml) stat.ml++; if (res.spreads.length) stat.spreadGames++; if (res.spreads.length > 1) stat.twoSides++;
  for (const s of [res.ml, ...res.spreads].filter(Boolean)) stat.q[`${s.book}/${s.q}`] = (stat.q[`${s.book}/${s.q}`] || 0) + 1;
}
fs.writeFileSync(path.join(__dirname, 'closing_multi.json'), JSON.stringify(out));
console.log(JSON.stringify({ targets: T.length, ...stat }));
