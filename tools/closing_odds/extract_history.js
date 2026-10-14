// Sample git history of rolling odds files and keep, per game, the LATEST PRE-START snapshot of each market.
// usage: node extract_history.js [only=<name>] ; env HOURS_<name>=n overrides the sampling interval.
// Output merged into records_history.json  { name: [record...] } (same record shape as extract_static.js)
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const ms = s => (typeof s === 'number' ? s : s ? Date.parse(s) : NaN);
const ok = o => o && o.home > 1 && o.away > 1;

// each extractor yields snapshots {league, away, home, startMs, at, ml?, hd?} for one file version
const outcomes = (mk) => { const o = {}; for (const x of (mk && mk.outcomes) || []) o[x.side] = x.odds; return o; };
const EXTRACT = {
  // Stake official NHL (games keyed by slug); history[] entries {at, ml, hd}; markets.ml.open/active/close
  stake_api_odds: { file: 'data/stake_api_odds.json', hours: 3, * snaps(d) {
    for (const g of Object.values(d.games || {})) {
      const start = ms(g.startISO || g.startTime); const base = { league: 'NHL', away: g.awayTeam, home: g.homeTeam, startMs: start, id: g.slug };
      const ents = [...(g.history || []), { at: g.lastPregameAt, ml: g.ml, hd: g.hd }];
      for (const e of ents) {
        if (!e || !e.at) continue; const ml = outcomes(e.ml), hd = outcomes(e.hd);
        yield { ...base, at: ms(e.at), ml: ok(ml) ? ml : null, hd: e.hd && ok(hd) ? { fav: e.hd.favSide, line: Math.abs(+e.hd.line), ...hd } : null };
      }
      for (const k of ['close', 'active']) { const m = g.markets || {}; const a = m.ml && m.ml[k], h = m.hd && m.hd[k];
        if (a && a.at) yield { ...base, at: ms(a.at), ml: ok(a) ? { home: a.home, away: a.away } : null, hd: h && ok(h) && h.at === a.at ? { fav: h.favorite, line: Math.abs(+h.line), home: h.home, away: h.away } : null, tag: k }; }
    }
  } },
  // bet365 official NHL; games keyed startMs|away|home; history newest-first [{at, ml, hd}]
  nhl_bet365_odds: { file: 'data/nhl_bet365_odds.json', hours: 3, * snaps(d) {
    for (const g of Object.values(d.games || {})) {
      const base = { league: 'NHL', away: g.awayZh, home: g.homeZh, startMs: ms(g.startTime) };
      for (const e of [...(g.history || []), { at: null, ml: g.ml, hd: g.hd }]) {
        if (!e || !e.at) continue; const ml = outcomes(e.ml), hd = outcomes(e.hd);
        yield { ...base, at: ms(e.at), ml: ok(ml) ? ml : null, hd: e.hd && ok(hd) ? { fav: e.hd.favSide, line: Math.abs(+e.hd.line), ...hd } : null };
      }
    }
  } },
  // OddsPortal Stake NHL (5 commits)
  nhl_oddsportal_stake: { file: 'data/nhl_oddsportal_stake.json', hours: 0, * snaps(d) {
    for (const g of Object.values(d.games || {})) yield* opSnaps(g, 'NHL');
  } },
  // Stake official baseball (officialId keyed); history[] {observedAt, favorite, canonicalLine, handicapOdds, moneyline}
  baseball_stake_odds: { file: 'data/baseball_stake_odds.json', hours: 6, * snaps(d) {
    for (const g of Object.values(d.matches || {})) {
      if (g.league !== 'MLB') continue; const [, , teams, tm] = g.officialId.split('_'); const [a, h] = teams.split('@');
      const base = { league: 'MLB', away: L.mlbAbbr(a), home: L.mlbAbbr(h), startMs: ms(g.scheduledStart), id: g.officialId };
      for (const e of [...(g.history || []), g]) {
        if (!e.observedAt) continue;
        yield { ...base, at: ms(e.observedAt), ml: ok(e.moneyline) ? e.moneyline : null,
          hd: ok(e.handicapOdds) && e.favorite ? { fav: e.favorite, line: e.canonicalLine, rawLine: e.rawLine, hsrc: e.sources && e.sources.handicapOdds, ...e.handicapOdds } : null };
      }
    }
  } },
  // bet365 official baseball; markets.{ml,hd}; history / providerHistories
  baseball_bet365_odds: { file: 'data/baseball_bet365_odds.json', hours: 6, * snaps(d) {
    for (const g of Object.values(d.matches || {})) {
      if (g.league !== 'MLB') continue; const [, , teams] = g.officialId.split('_'); const [a, h] = teams.split('@');
      const base = { league: 'MLB', away: L.mlbAbbr(a), home: L.mlbAbbr(h), startMs: ms(g.scheduledStart), id: g.officialId };
      const ents = [g, ...(g.history || [])]; for (const arr of Object.values(g.providerHistories || {})) ents.push(...arr);
      for (const e of ents) {
        const m = e.markets || {}; if (!e.observedAt) continue;
        yield { ...base, at: ms(e.observedAt), prov: e.provider, ml: ok(m.ml) ? { home: m.ml.home, away: m.ml.away } : null,
          hd: ok(m.hd) && m.hd.favorite ? { fav: m.hd.favorite, line: Math.abs(+m.hd.line), home: m.hd.home, away: m.hd.away } : null };
      }
    }
  } },
  // OddsPortal/BetExplorer Stake summary (MLB, Aug 1+): close/active/open snapshots
  oddsportal_summary: { file: 'data/oddsportal_summary.json', hours: 12, * snaps(d) {
    for (const g of Object.values(d.games || {})) { const lg = String(g.league).toUpperCase(); if (lg === 'MLB' || lg === 'NHL') yield* opSnaps(g, lg); }
  } },
};
function* opSnaps(g, lg) {
  const start = ms(g.startISO); const base = { league: lg, away: lg === 'MLB' ? L.mlbAbbr(g.awayTeam) : g.awayTeam, home: lg === 'MLB' ? L.mlbAbbr(g.homeTeam) : g.homeTeam, startMs: start, id: g.eventId };
  const mk = g.markets || {};
  for (const k of ['open', 'active', 'close']) {
    const a = mk.ml && mk.ml[k], h = mk.hd && mk.hd[k];
    // close snapshots are by definition the pre-start closing price (their .at is the last movement time)
    if (a && a.at) yield { ...base, at: ms(a.at), tag: k, final: k === 'close', ml: ok(a) ? { home: a.home, away: a.away } : null, hd: null };
    if (h && h.at) yield { ...base, at: ms(h.at), tag: k, final: k === 'close', ml: null, hd: ok(h) ? { fav: h.favorite, line: Math.abs(+h.line), home: h.home, away: h.away } : null };
  }
}

function run(name) {
  const X = EXTRACT[name]; const hours = +(process.env['HOURS_' + name] || X.hours);
  const commits = L.sampleCommits(X.file, hours);
  const best = new Map(); // gameKey -> {base, ml:{..,at,gapMin}, hd, hd15}
  let n = 0;
  for (const c of commits) {
    let d; try { d = JSON.parse(L.git(['show', `${c.h}:${X.file}`]).toString('utf8')); } catch (e) { continue; }
    n++;
    for (const s of X.snaps(d)) {
      if (!s.away || !s.home || !(s.startMs > 0)) continue;
      // pre-start only (OddsPortal 'close' may carry a timestamp == start; allow +2 min)
      if (!(s.at <= s.startMs + 2 * 60e3)) continue;
      const k = s.league + '|' + s.away + '|' + s.home + '|' + s.startMs;
      const b = best.get(k) || { src: name, league: s.league, away: s.away, home: s.home, startMs: s.startMs, id: s.id, ml: null, hd: null, hd15: null, seenIn: 0 };
      const better = (cur, at, fin) => !cur || (fin && !cur.final) || (!!fin === !!cur.final && at > cur.atMs);
      if (s.ml && better(b.ml, s.at, s.final)) b.ml = { ...s.ml, at: new Date(s.at).toISOString(), atMs: s.at, final: !!s.final, gapMin: Math.round((s.startMs - s.at) / 60e3) };
      if (s.hd && better(b.hd, s.at, s.final)) b.hd = { ...s.hd, at: new Date(s.at).toISOString(), atMs: s.at, final: !!s.final, gapMin: Math.round((s.startMs - s.at) / 60e3) };
      if (s.hd && s.hd.line === 1.5 && better(b.hd15, s.at, s.final)) b.hd15 = { ...s.hd, at: new Date(s.at).toISOString(), atMs: s.at, final: !!s.final, gapMin: Math.round((s.startMs - s.at) / 60e3) };
      best.set(k, b);
    }
  }
  console.log(`${name}: sampled ${n}/${commits.length} versions every ${hours}h (${commits[0] && new Date(commits[0].t).toISOString()} .. ${commits.length && new Date(commits[commits.length - 1].t).toISOString()}), games ${best.size}`);
  return [...best.values()];
}

const only = (process.argv.find(a => a.startsWith('only=')) || '').slice(5);
const outFile = path.join(__dirname, 'records_history.json');
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile)) : {};
for (const name of Object.keys(EXTRACT)) {
  if (only && !only.split(',').includes(name)) continue;
  const recs = run(name);
  out['hist:' + name] = recs;
  // variant using the ±1.5 snapshot as the spread record
  out['hist:' + name + ':hd15'] = recs.map(r => ({ ...r, src: name + ':hd15', hd: r.hd15 }));
  fs.writeFileSync(outFile, JSON.stringify(out));
}
