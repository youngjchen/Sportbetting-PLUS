// Extract closing-odds records from single-version sources at REF (no history sampling).
// Output: records_static.json = { sourceName: [record...] }
// record = { src, league, away, home, startMs, ml:{away,home,at}|null, hd:{fav,line,away,home,at,kind}|null }
//   hd.line is the absolute line; hd.fav = side laying the points; odds decimal.
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const REF = L.REF;
const ms = s => (s ? Date.parse(s) : NaN);

function opGame(g, src) { // OddsPortal/BetExplorer Stake-shaped game (archive / summary / data/2026-08.json)
  const lg = String(g.league || '').toUpperCase();
  if (lg !== 'MLB' && lg !== 'NHL') return null;
  const start = ms(g.startISO);
  const away = lg === 'MLB' ? L.mlbAbbr(g.awayTeam) : g.awayTeam, home = lg === 'MLB' ? L.mlbAbbr(g.homeTeam) : g.homeTeam;
  const mk = g.markets || {};
  const pick = (m) => {
    if (!m) return null;
    if (m.close && m.close.home != null) return { ...m.close, kind: 'close' };
    if (m.active && m.active.home != null && ms(m.active.at) <= start) return { ...m.active, kind: 'active-pre' };
    return null;
  };
  const ml = pick(mk.ml);
  let hd = pick(mk.hd);
  const rec = { src, league: lg, away, home, startMs: start, rawAway: g.awayTeam, rawHome: g.homeTeam, id: g.eventId };
  rec.ml = ml ? { away: ml.away, home: ml.home, at: ml.at, kind: ml.kind } : null;
  rec.hd = hd ? { fav: hd.favorite, line: Math.abs(+hd.line), away: hd.away, home: hd.home, at: hd.at, kind: hd.kind } : null;
  if (mk.hd && mk.hd.open && mk.hd.open.home != null) rec.hdOpen = { fav: mk.hd.open.favorite, line: Math.abs(+mk.hd.open.line), away: mk.hd.open.away, home: mk.hd.open.home, at: mk.hd.open.at };
  if (g.bet365 && g.bet365.odds) rec.b365hd = { fav: g.bet365.side, line: Math.abs(+g.bet365.line), away: g.bet365.odds.away, home: g.bet365.odds.home, at: g.bet365.at, ambiguous: g.bet365.ambiguous };
  return rec;
}

const out = {};
// 1) OddsPortal/BetExplorer Stake archives + summary + old monthly file
for (const f of ['data/oddsportal_archive/2026-04.json', 'data/oddsportal_archive/2026-05.json', 'data/oddsportal_archive/2026-06.json',
  'data/oddsportal_archive/2026-07.json', 'data/oddsportal_archive/2026-08.json', 'data/2026-08.json', 'data/oddsportal_summary.json']) {
  const d = L.showJSON(REF, f);
  out[f] = Object.values(d.games).map(g => opGame(g, f)).filter(Boolean);
}
// summary bet365 sub-object as its own source
out['summary.bet365'] = out['data/oddsportal_summary.json'].filter(r => r.b365hd).map(r => ({ ...r, src: 'summary.bet365', ml: null, hd: r.b365hd }));
// oddsportal_bet365.json
{
  const d = L.showJSON(REF, 'data/oddsportal_bet365.json');
  out['data/oddsportal_bet365.json'] = Object.values(d.games).filter(g => g.bet365).map(g => {
    const lg = g.league.toUpperCase(); const b = g.bet365;
    return { src: 'oddsportal_bet365', league: lg, away: lg === 'MLB' ? L.mlbAbbr(g.awayTeam) : g.awayTeam, home: lg === 'MLB' ? L.mlbAbbr(g.homeTeam) : g.homeTeam, startMs: ms(g.startISO), raw: b };
  });
}
// 2) Titan odds_log (bet365): ML decimal, HD Hong Kong (+1 -> decimal); rows[0] = latest; line>0 = home gives
{
  const d = L.showJSON(REF, 'data/odds_log.json');
  const recs = [];
  for (const [id, m] of Object.entries(d.matches)) {
    if (m.league !== 'mlb') continue;
    const start = ms(m.startISO);
    const r = { src: 'titan', league: 'MLB', id, away: L.mlbAbbr(m.awayTeam), home: L.mlbAbbr(m.homeTeam), startMs: start, rawAway: m.awayTeam, rawHome: m.homeTeam, ml: null, hd: null };
    const b = m.ml && m.ml.bet365;
    if (b) {
      const pre = (b.live || []).filter(x => ms(x.ts) <= start);
      const last = pre.length ? pre[pre.length - 1] : null;
      if (last) r.ml = { away: last.away, home: last.home, at: last.ts, kind: 'live-pre' };
      else if (b.open) r.ml = { away: b.open.away, home: b.open.home, at: null, kind: 'open-only' };
    }
    const rows = (m.hd && m.hd.bet365) || [];
    if (rows.length) {
      const withTs = rows.filter(x => x.ts);
      let row = null, kind;
      if (withTs.length) { row = rows.find(x => x.ts && ms(x.ts) <= start); kind = 'row-pre'; }
      else { row = rows[0]; kind = 'row0-nots'; }
      if (row) {
        const ln = +row.line; // + => home gives
        r.hd = { fav: ln > 0 ? 'home' : ln < 0 ? 'away' : null, line: Math.abs(ln), home: +(row.home + 1).toFixed(3), away: +(row.away + 1).toFixed(3), at: row.ts || null, kind, rawLine: row.line };
      }
    }
    recs.push(r);
  }
  out['titan'] = recs;
}
// 3) Titan backfill (bet365 ML close only) Apr 1 - Jun 26
{
  const d = L.showJSON(REF, 'divination_lab/titan_backfill/bf_labeled.json');
  out['bf_labeled'] = d.filter(x => x.league === 'mlb').map(x => ({ src: 'bf_labeled', league: 'MLB', away: L.mlbAbbr(x.away), home: L.mlbAbbr(x.home), startMs: x.startT * 1000,
    ml: x.mlClose && x.mlClose.home ? { away: x.mlClose.away, home: x.mlClose.home, kind: 'mlClose' } : null,
    hd: null, hdSide: x.intlClose, hdLineSigned: x.intlCloseLine, dh: x.dh }));
}
// 4) stake_odds.json (one commit, Aug 2)
{
  const d = L.showJSON(REF, 'data/stake_odds.json');
  out['data/stake_odds.json'] = Object.entries(d.games).filter(([k]) => k.startsWith('mlb')).map(([k, v]) => {
    const [, date, a, h] = k.split('|');
    return { src: 'stake_odds', league: 'MLB', away: L.mlbAbbr(a), home: L.mlbAbbr(h), startMs: L.twMs(date, '12:00'), ml: { away: v.closeAway, home: v.closeHome, at: v.closeAt, kind: 'close' }, hd: null };
  });
}
// 5) raw OddsPortal history jsonl (NHL + MLB): last snapshot per event, list lines available
{
  const recs = [];
  const files = L.git(['ls-tree', '-r', '--name-only', REF, 'data/oddsportal_history/']).toString().trim().split('\n');
  for (const f of files) {
    for (const snap of L.readJsonlGz(L.showBlob(REF, f))) for (const g of snap.games || []) {
      const lg = String(g.league).toUpperCase(); if (lg !== 'MLB' && lg !== 'NHL') continue;
      const lines = ((g.markets && g.markets.hd && g.markets.hd.rows) || []).map(r => r.line);
      recs.push({ src: 'op_history:' + path.basename(f), league: lg, away: lg === 'MLB' ? L.mlbAbbr(g.awayTeam) : g.awayTeam, home: lg === 'MLB' ? L.mlbAbbr(g.homeTeam) : g.homeTeam, startMs: ms(g.startISO), observedAt: snap.observedAt, id: g.eventId, hdLines: lines });
    }
  }
  out['op_history'] = recs;
}
fs.writeFileSync(path.join(__dirname, 'records_static.json'), JSON.stringify(out));
for (const [k, v] of Object.entries(out)) {
  const unk = v.filter(r => r.league === 'MLB' && (!r.away || !r.home));
  console.log(k.padEnd(40), 'records', v.length, 'MLB', v.filter(r => r.league === 'MLB').length, 'NHL', v.filter(r => r.league === 'NHL').length, 'unmappedTeams', unk.length, unk.slice(0, 2).map(r => r.rawAway + '@' + r.rawHome).join(','));
}
