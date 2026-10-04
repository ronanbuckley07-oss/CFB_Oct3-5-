// Paper picks. While the server is simulating a game (someone is watching it), every finished set of sims is compared
// with the Kalshi and Polymarket prices for that game. When the model's probability beats the price you would pay by a
// clear margin, that bet is logged once, at that price. Picks settle when ESPN marks the game final, and the record
// (wins, losses, profit per $1 contract) is what the home page shows. Nothing here places a bet.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { simulateFill, TAKER_THETA } from './pmus.mjs';

const PAPER_STAKE = +process.env.PAPER_STAKE || 10; // dollars per bet in the realistic record

const MIN_EDGE_ML = 0.05;    // moneyline: model probability at least 5 points above the ask
const MIN_EDGE_LINE = 0.06;  // spread/total ladders only give a midpoint, so ask for a little more
const LINE_COST = 0.015;     // assumed half-spread on ladder prices
const MAX_OPEN_PER_GAME = 4;
const MAX_EDGE = 0.20;       // a bigger gap than this is almost always a stale or mismatched market price, not an edge

// When in a game to take the one automatic bet. From replaying 2023-25 NFL games against Vegas win probability
// (10,478 snaps, tools/timing.mjs): model-vs-market gaps were best calibrated and most profitable from the middle of the
// 3rd quarter to 8:00 left in the 4th (269 bets, 57.5% hit vs 58.2% predicted, +9% return). Earlier, the model is
// overconfident when it disagrees; in the last minutes, prices are extreme and swing on single plays.
export const WINDOW = { label: 'Q3 7:30 to Q4 8:00', from: { qtr: 3, secs: 450 }, to: { qtr: 4, secs: 480 } };
export const inWindow = S => (S.qtr === 3 && S.secs <= WINDOW.from.secs) || (S.qtr === 4 && S.secs >= WINDOW.to.secs);
export const pastWindow = S => S.qtr > 4 || (S.qtr === 4 && S.secs < WINDOW.to.secs);
export function phaseOf(S) {
  if (S.qtr < 4) return `Q${S.qtr} ${S.secs > 450 ? 'early' : 'late'}`;
  return S.secs > 480 ? 'Q4 15:00-8:00' : S.secs > 180 ? 'Q4 8:00-3:00' : 'Q4 last 3:00';
}

// Grade one bet against a final score (sc: team id -> points). Shared with real trades.
export function gradeBet(p, sc) {
  const ids = Object.keys(sc), total = sc[ids[0]] + sc[ids[1]];
  if (p.type === 'total') return total === p.line ? 'push' : (total > p.line) === p.over ? 'won' : 'lost';
  const mine = sc[String(p.teamId)], theirs = sc[ids.find(i => i !== String(p.teamId))], m = mine - theirs;
  if (p.type === 'moneyline') return m === 0 ? 'push' : m > 0 ? 'won' : 'lost';
  return m === p.by ? 'push' : m > p.by ? 'won' : 'lost';
}

export function createPicks({ api, dir }) {
  const file = path.join(dir, 'picks.json');
  let db = { picks: [] };
  try { db = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(db.picks)) db.picks = [];
  if (!db.auto || typeof db.auto !== 'object') db.auto = {}; // league:event -> { status: 'bet' | 'pass', at }
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
    const usFee = p => TAKER_THETA * p * (1 - p);
    const us = mk.pmus;
    if (us && us.found) {
      const V = 'Polymarket US', url = us.url;
      for (const side of ['away', 'home']) {
        const m = us[side]; if (!m || m.ask == null) continue;
        const slot = slotOf(side), p = slot === 'ND' ? wA : 1 - wA, cost = m.ask + usFee(m.ask);
        out.push({ venue: V, url, type: 'moneyline', sel: `${name(slot)} to win`, slot, team: name(slot), teamId: g.slotId[slot], cost, model: p, edge: p - cost, mid: m.p, ask: m.ask, trade: m.trade });
      }
      for (const sp of us.spreads || []) {
        const slot = slotOf(sp.side), p = marginP(A, slot === 'ND', sp.by); if (p == null) continue;
        const other = slot === 'ND' ? 'UNC' : 'ND', lbl = (t, by) => `${name(t)} ${by > 0 ? '−' + by : '+' + (-by)}`;
        if (sp.ask != null) { const c = sp.ask + usFee(sp.ask);
          out.push({ venue: V, url, type: 'spread', sel: lbl(slot, sp.by), slot, team: name(slot), teamId: g.slotId[slot], by: sp.by, cost: c, model: p, edge: p - c, mid: sp.p, ask: sp.ask, trade: { slug: sp.slug, outcome: 'YES' } }); }
        if (sp.bid != null) { const a = 1 - sp.bid, c = a + usFee(a);
          out.push({ venue: V, url, type: 'spread', sel: lbl(other, -sp.by), slot: other, team: name(other), teamId: g.slotId[other], by: -sp.by, cost: c, model: 1 - p, edge: (1 - p) - c, mid: 1 - sp.p, ask: a, trade: { slug: sp.slug, outcome: 'NO' } }); }
      }
      for (const t of us.totals || []) {
        const pOver = overP(A, t.line); if (pOver == null) continue;
        const yesP = t.yesOver ? pOver : 1 - pOver;
        if (t.ask != null) { const c = t.ask + usFee(t.ask);
          out.push({ venue: V, url, type: 'total', sel: `${t.yesOver ? 'Over' : 'Under'} ${t.line}`, over: t.yesOver, line: t.line, cost: c, model: yesP, edge: yesP - c, mid: t.yesOver ? t.p : 1 - t.p, ask: t.ask, trade: { slug: t.slug, outcome: 'YES' } }); }
        if (t.bid != null) { const a = 1 - t.bid, c = a + usFee(a);
          out.push({ venue: V, url, type: 'total', sel: `${t.yesOver ? 'Under' : 'Over'} ${t.line}`, over: !t.yesOver, line: t.line, cost: c, model: 1 - yesP, edge: (1 - yesP) - c, mid: t.yesOver ? 1 - t.p : t.p, ask: a, trade: { slug: t.slug, outcome: 'NO' } }); }
      }
    }
    for (const [venue, src] of [['Kalshi', mk.kalshi], ['Polymarket', mk.poly]]) {
      if (!src || !src.found) continue;
      for (const side of ['away', 'home']) {
        const m = src[side]; if (!m || m.implied) continue;
        const slot = slotOf(side), p = slot === 'ND' ? wA : 1 - wA;
        const cost = m.ask != null ? m.ask : m.p + 0.01;
        out.push({ venue, url: src.url, type: 'moneyline', sel: `${name(slot)} to win`, slot, team: name(slot), teamId: g.slotId[slot], cost, model: p, edge: p - cost, mid: m.p });
      }
      for (const s of src.spreads || []) {
        const slot = slotOf(s.side), p = marginP(A, slot === 'ND', s.by); if (p == null) continue;
        const other = slot === 'ND' ? 'UNC' : 'ND', lbl = (t, by) => `${name(t)} ${by > 0 ? '−' + by : '+' + (-by)}`;
        out.push({ venue, url: src.url, type: 'spread', sel: lbl(slot, s.by), slot, team: name(slot), teamId: g.slotId[slot], by: s.by, cost: s.p + LINE_COST, model: p, edge: p - s.p - LINE_COST, mid: s.p });
        out.push({ venue, url: src.url, type: 'spread', sel: lbl(other, -s.by), slot: other, team: name(other), teamId: g.slotId[other], by: -s.by, cost: 1 - s.p + LINE_COST, model: 1 - p, edge: (1 - p) - (1 - s.p) - LINE_COST, mid: 1 - s.p });
      }
      for (const t of src.totals || []) {
        const p = overP(A, t.line); if (p == null) continue;
        out.push({ venue, url: src.url, type: 'total', sel: `Over ${t.line}`, over: true, line: t.line, cost: t.p + LINE_COST, model: p, edge: p - t.p - LINE_COST, mid: t.p });
        out.push({ venue, url: src.url, type: 'total', sel: `Under ${t.line}`, over: false, line: t.line, cost: 1 - t.p + LINE_COST, model: 1 - p, edge: (1 - p) - (1 - t.p) - LINE_COST, mid: 1 - t.p });
      }
    }
    return out.filter(e => e.cost > 0.05 && e.cost < 0.95 && e.model > 0.03 && e.model < 0.97 && e.edge >= (e.type === 'moneyline' ? MIN_EDGE_ML : MIN_EDGE_LINE) && e.edge <= MAX_EDGE)
      .sort((a, b) => b.edge - a.edge);
  }

  // Log the qualifying bets once each (best venue at that moment), at most a few per game
  const why = (g, A, S, e) => {
    let t = 0; A.totH.forEach((c, i) => t += c * i);
    const med = h => { let c = 0; for (let i = 0; i < h.length; i++) { c += h[i]; if (c >= A.n / 2) return i; } return 0; };
    return { state: { qtr: S.qtr, secs: S.secs, nd: S.nd, unc: S.unc, poss: g.abbr[S.poss], down: S.down, dist: S.dist, pos: S.pos },
      abbr: g.abbr, sims: A.n, winA: +(A.win / A.n).toFixed(3), avgMargin: +(A.marSum / A.n).toFixed(1), avgTotal: +(t / A.n).toFixed(1),
      median: [med(A.ndH), med(A.ucH)], start: g.pregame || null, mid: e.mid ?? null };
  };
  const logPick = (g, A, S, e, extra) => {
    const key = `${g.league}:${g.event}:${e.type}:${e.sel}${extra && extra.auto ? ':auto' : ''}`;
    if (db.picks.some(p => p.key === key)) return null;
    const clock = `Q${S.qtr} ${Math.floor(S.secs / 60)}:${String(S.secs % 60).padStart(2, '0')}`;
    const pick = Object.assign({ key, league: g.league, event: g.event, matchup: g.title, venue: e.venue, url: e.url, type: e.type, sel: e.sel, team: e.team || null,
      teamId: e.slot ? g.slotId[e.slot] : null, by: e.by ?? null, line: e.line ?? null, over: e.over ?? null,
      price: +e.cost.toFixed(3), model: +e.model.toFixed(3), edge: +e.edge.toFixed(3), clock, score: `${g.abbr.ND} ${S.nd}, ${g.abbr.UNC} ${S.unc}`,
      phase: phaseOf(S), why: why(g, A, S, e), at: new Date().toISOString(), status: 'open' }, extra || {});
    db.picks.push(pick); dirty = true;
    if (e.trade) fillPaper(pick, e.trade);
    return pick;
  };
  // What $PAPER_STAKE would actually have bought on the Polymarket US order book at that moment, fees included
  async function fillPaper(pick, trade) {
    try {
      const bk = await api[pick.league].pmusBook(trade.slug);
      const f = simulateFill(bk, trade.outcome, PAPER_STAKE);
      pick.trade = trade; pick.fill = { stake: PAPER_STAKE, qty: f.qty, avg: f.avg && +f.avg.toFixed(4), fee: f.fee, cost: f.cost, full: f.full, at: new Date().toISOString() };
    } catch (e) { pick.fill = { error: String(e.message || e) }; }
    dirty = true;
  }
  // The one automatic bet per game: the best qualifying edge once the game is inside the window
  function autoPick(g, A, mk, S) {
    const id = `${g.league}:${g.event}`;
    if (db.auto[id]) return null;
    if (pastWindow(S)) { db.auto[id] = { status: 'pass', at: new Date().toISOString(), matchup: g.title }; dirty = true; return null; }
    if (!inWindow(S)) return null;
    const list = edges(g, A, mk), best = list.find(e => e.venue === 'Polymarket US') || list[0]; if (!best) return null;
    const pick = logPick(g, A, S, best, { auto: true });
    db.auto[id] = { status: 'bet', at: new Date().toISOString(), key: pick && pick.key, matchup: g.title }; dirty = true;
    return pick;
  }
  function consider(g, A, mk, S) {
    const list = edges(g, A, mk);
    const open = db.picks.filter(p => p.event === g.event && p.league === g.league && !p.auto);
    for (const e of list) {
      if (open.length >= MAX_OPEN_PER_GAME) break;
      // One bet per market type per game. Four spread lines on the same team are one opinion, not four, and
      // counting them separately would make the record look far more certain than it is.
      if (open.some(p => p.type === e.type)) continue;
      const pick = logPick(g, A, S, e); if (pick) open.push(pick);
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
          const res = gradeBet(p, sc);
          p.status = res; p.final = `${sm.comps.map(c => `${c.abbr} ${c.score}`).join(', ')}`; p.settledAt = new Date().toISOString();
          // one $1 contract bought at the logged price
          p.pl = res === 'won' ? +(1 - p.price).toFixed(3) : res === 'lost' ? -p.price : 0;
          if (p.fill && p.fill.qty > 0) p.fill.pl = +(res === 'won' ? p.fill.qty - p.fill.cost : res === 'lost' ? -p.fill.cost : 0).toFixed(2);
          dirty = true;
        }
      } catch {}
    }
  }
  setInterval(settle, 5 * 60000).unref(); setTimeout(settle, 15000).unref();

  function summarize(ps) {
    const done = ps.filter(p => p.status === 'won' || p.status === 'lost');
    const w = done.filter(p => p.status === 'won').length, cost = done.reduce((a, p) => a + p.price, 0), pl = done.reduce((a, p) => a + (p.pl || 0), 0);
    return { w, l: done.length - w, push: ps.filter(p => p.status === 'push').length, pct: done.length ? w / done.length : null, pl: +pl.toFixed(2), roi: cost ? pl / cost : null,
      expected: done.length ? +(done.reduce((a, p) => a + p.model, 0) / done.length).toFixed(3) : null };
  }
  function report(league) {
    const ps = db.picks.filter(p => !league || league === 'all' || p.league === league);
    const phases = {}; for (const p of ps) if (p.phase) (phases[p.phase] = phases[p.phase] || []).push(p);
    const passes = Object.entries(db.auto).filter(([k, v]) => v.status === 'pass' && (!league || league === 'all' || k.startsWith(league + ':'))).length;
    const real = ps.filter(p => p.fill && p.fill.qty > 0 && p.status !== 'open' && p.status !== 'push');
    const rStake = real.reduce((a, p) => a + p.fill.cost, 0), rPl = real.reduce((a, p) => a + (p.fill.pl || 0), 0), rW = real.filter(p => p.status === 'won').length;
    const extra = { realistic: { n: real.length, w: rW, l: real.length - rW, staked: +rStake.toFixed(2), pl: +rPl.toFixed(2), roi: rStake ? rPl / rStake : null, stake: PAPER_STAKE,
        open: ps.filter(p => p.fill && p.fill.qty > 0 && p.status === 'open').length, unfillable: ps.filter(p => p.fill && p.fill.qty === 0).length }, auto: summarize(ps.filter(p => p.auto)), autoOpen: ps.filter(p => p.auto && p.status === 'open').length, passes, window: WINDOW.label,
      byPhase: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, summarize(v)])) };
    const done = ps.filter(p => p.status === 'won' || p.status === 'lost');
    const w = done.filter(p => p.status === 'won').length, l = done.length - w;
    const cost = done.reduce((a, p) => a + p.price, 0), pl = done.reduce((a, p) => a + (p.pl || 0), 0);
    const byType = {}; for (const p of done) { const t = byType[p.type] || (byType[p.type] = { w: 0, l: 0, pl: 0 }); t[p.status === 'won' ? 'w' : 'l']++; t.pl += p.pl || 0; }
    return { ...extra, record: { w, l, push: ps.filter(p => p.status === 'push').length, pct: done.length ? w / done.length : null, pl: +pl.toFixed(2), roi: cost ? pl / cost : null,
        expected: done.length ? +(done.reduce((a, p) => a + p.model, 0) / done.length).toFixed(3) : null, avgPrice: done.length ? +(cost / done.length).toFixed(3) : null }, byType,
      open: ps.filter(p => p.status === 'open').slice(-500).reverse(), settled: ps.filter(p => p.status !== 'open').slice(-500).reverse() };
  }
  const forEvent = (league, event) => db.picks.filter(p => p.league === league && p.event === String(event));
  const autoDone = (league, event) => !!db.auto[`${league}:${event}`];
  return { edges, consider, autoPick, autoDone, settle, report, forEvent, flush: () => { dirty = true; save(); } };
}
