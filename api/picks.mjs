// Paper picks. While the server is simulating a game (someone is watching it), every finished set of sims is compared
// with the Kalshi and Polymarket prices for that game. When the model's probability beats the price you would pay by a
// clear margin, that bet is logged once, at that price. Picks settle when ESPN marks the game final, and the record
// (wins, losses, profit per $1 contract) is what the home page shows. Nothing here places a bet.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

const MIN_EDGE_ML = 0.05;    // moneyline: model probability at least 5 points above the ask
const MIN_EDGE_LINE = 0.06;  // spread/total ladders only give a midpoint, so ask for a little more
const LINE_COST = 0.015;     // assumed half-spread on ladder prices
const MAX_OPEN_PER_GAME = 4;
const MAX_EDGE = 0.20;       // a bigger gap than this is almost always a stale or mismatched market price, not an edge

export function createPicks({ api, dir }) {
  const file = path.join(dir, 'picks.json');
  let db = { picks: [] };
  try { db = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(db.picks)) db.picks = [];
  let dirty = false;
  const save = () => {
    if (!dirty) return; dirty = false;
    try { mkdirSync(dir, { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(db)); renameSync(file + '.tmp', file); }
    catch (e) { console.error('picks: save failed', e.message); }
  };
  setInterval(save, 5000).unref();

  // ---------- model probabilities from the sim aggregate (slot A = 'ND' in engine terms) ----------
  const marginP = (A, sideIsA, by) => { let n = 0, c = 0; A.marH.forEach((v, i) => { const m = (i - 60) * (sideIsA ? 1 : -1); if (m > by) c += v; if (m !== by) n += v; }); return n ? c / n : null; };
  const overP = (A, line) => { let n = 0, c = 0; A.totH.forEach((v, i) => { if (i > line) c += v; if (i !== line) n += v; }); return n ? c / n : null; };

  // Every bet the model would make right now on this game, best edge first
  function edges(g, A, mk) {
    if (!A || !mk) return [];
    const out = [], wA = A.win / A.n;
    const aIsAway = String(mk.awayId) === String(g.slotId.ND);
    const slotOf = side => (side === 'away') === aIsAway ? 'ND' : 'UNC';
    const name = slot => g.abbr[slot];
    for (const [venue, src] of [['Kalshi', mk.kalshi], ['Polymarket', mk.poly]]) {
      if (!src || !src.found) continue;
      for (const side of ['away', 'home']) {
        const m = src[side]; if (!m || m.implied) continue;
        const slot = slotOf(side), p = slot === 'ND' ? wA : 1 - wA;
        const cost = m.ask != null ? m.ask : m.p + 0.01;
        out.push({ venue, url: src.url, type: 'moneyline', sel: `${name(slot)} to win`, slot, cost, model: p, edge: p - cost });
      }
      for (const s of src.spreads || []) {
        const slot = slotOf(s.side), p = marginP(A, slot === 'ND', s.by); if (p == null) continue;
        const other = slot === 'ND' ? 'UNC' : 'ND', lbl = (t, by) => `${name(t)} ${by > 0 ? '−' + by : '+' + (-by)}`;
        out.push({ venue, url: src.url, type: 'spread', sel: lbl(slot, s.by), slot, by: s.by, cost: s.p + LINE_COST, model: p, edge: p - s.p - LINE_COST });
        out.push({ venue, url: src.url, type: 'spread', sel: lbl(other, -s.by), slot: other, by: -s.by, cost: 1 - s.p + LINE_COST, model: 1 - p, edge: (1 - p) - (1 - s.p) - LINE_COST });
      }
      for (const t of src.totals || []) {
        const p = overP(A, t.line); if (p == null) continue;
        out.push({ venue, url: src.url, type: 'total', sel: `Over ${t.line}`, over: true, line: t.line, cost: t.p + LINE_COST, model: p, edge: p - t.p - LINE_COST });
        out.push({ venue, url: src.url, type: 'total', sel: `Under ${t.line}`, over: false, line: t.line, cost: 1 - t.p + LINE_COST, model: 1 - p, edge: (1 - p) - (1 - t.p) - LINE_COST });
      }
    }
    return out.filter(e => e.cost > 0.05 && e.cost < 0.95 && e.model > 0.03 && e.model < 0.97 && e.edge >= (e.type === 'moneyline' ? MIN_EDGE_ML : MIN_EDGE_LINE) && e.edge <= MAX_EDGE)
      .sort((a, b) => b.edge - a.edge);
  }

  // Log the qualifying bets once each (best venue at that moment), at most a few per game
  function consider(g, A, mk, S) {
    const list = edges(g, A, mk);
    const open = db.picks.filter(p => p.event === g.event && p.league === g.league);
    const clock = `Q${S.qtr} ${Math.floor(S.secs / 60)}:${String(S.secs % 60).padStart(2, '0')}`;
    const score = `${g.abbr.ND} ${S.nd}, ${g.abbr.UNC} ${S.unc}`;
    for (const e of list) {
      if (open.length >= MAX_OPEN_PER_GAME) break;
      const key = `${g.league}:${g.event}:${e.type}:${e.sel}`;
      if (db.picks.some(p => p.key === key)) continue;
      const pick = { key, league: g.league, event: g.event, matchup: g.title, venue: e.venue, url: e.url, type: e.type, sel: e.sel,
        teamId: e.slot ? g.slotId[e.slot] : null, by: e.by ?? null, line: e.line ?? null, over: e.over ?? null,
        price: +e.cost.toFixed(3), model: +e.model.toFixed(3), edge: +e.edge.toFixed(3), clock, score, at: new Date().toISOString(), status: 'open' };
      db.picks.push(pick); open.push(pick); dirty = true;
    }
    return list.slice(0, 8);
  }

  // Settle open picks whose games are final
  async function settle() {
    const open = db.picks.filter(p => p.status === 'open');
    const events = [...new Set(open.map(p => `${p.league}:${p.event}`))];
    for (const ev of events) {
      const [league, event] = ev.split(':');
      try {
        const sm = await api[league](new Request(`http://local/api?kind=summary&event=${event}`)).then(r => r.json());
        if (sm.state !== 'post') continue;
        const sc = Object.fromEntries((sm.comps || []).map(c => [String(c.id), +c.score || 0]));
        const ids = Object.keys(sc); if (ids.length !== 2) continue;
        const total = sc[ids[0]] + sc[ids[1]];
        for (const p of open.filter(x => x.league === league && x.event === event)) {
          let res;
          if (p.type === 'total') res = total === p.line ? 'push' : (total > p.line) === p.over ? 'won' : 'lost';
          else {
            const mine = sc[p.teamId], theirs = sc[ids.find(i => i !== String(p.teamId))], m = mine - theirs;
            if (p.type === 'moneyline') res = m === 0 ? 'push' : m > 0 ? 'won' : 'lost';
            else res = m === p.by ? 'push' : m > p.by ? 'won' : 'lost';
          }
          p.status = res; p.final = `${sm.comps.map(c => `${c.abbr} ${c.score}`).join(', ')}`; p.settledAt = new Date().toISOString();
          // one $1 contract bought at the logged price
          p.pl = res === 'won' ? +(1 - p.price).toFixed(3) : res === 'lost' ? -p.price : 0;
          dirty = true;
        }
      } catch {}
    }
  }
  setInterval(settle, 5 * 60000).unref(); setTimeout(settle, 15000).unref();

  function report(league) {
    const ps = db.picks.filter(p => !league || league === 'all' || p.league === league);
    const done = ps.filter(p => p.status === 'won' || p.status === 'lost');
    const w = done.filter(p => p.status === 'won').length, l = done.length - w;
    const cost = done.reduce((a, p) => a + p.price, 0), pl = done.reduce((a, p) => a + (p.pl || 0), 0);
    const byType = {}; for (const p of done) { const t = byType[p.type] || (byType[p.type] = { w: 0, l: 0, pl: 0 }); t[p.status === 'won' ? 'w' : 'l']++; t.pl += p.pl || 0; }
    return { record: { w, l, push: ps.filter(p => p.status === 'push').length, pct: done.length ? w / done.length : null, pl: +pl.toFixed(2), roi: cost ? pl / cost : null,
        expected: done.length ? +(done.reduce((a, p) => a + p.model, 0) / done.length).toFixed(3) : null, avgPrice: done.length ? +(cost / done.length).toFixed(3) : null }, byType,
      open: ps.filter(p => p.status === 'open').slice(-40).reverse(), settled: ps.filter(p => p.status !== 'open').slice(-40).reverse() };
  }
  const forEvent = (league, event) => db.picks.filter(p => p.league === league && p.event === String(event));
  return { edges, consider, settle, report, forEvent, flush: () => { dirty = true; save(); } };
}
