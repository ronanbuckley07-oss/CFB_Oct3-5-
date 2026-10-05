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
const MAX_OPEN_PER_GAME = 4;
// A bet is only logged against a quote fetched in the last 30 seconds. Older quotes trail the game: the model sees the
// latest play and the price doesn't yet, so the "edge" is the play, the logged price is one nobody can still get, and
// the paper record looks better than real trading would.
const QUOTE_MAX_AGE = +process.env.QUOTE_MAX_AGE_MS || 30000;
const BUYABLE = 'Polymarket US';
const quoteAge = g => (g.mkFetched ? Date.now() - g.mkFetched : Infinity);
const MAX_EDGE = 0.20;
// The model's number and the market's number, averaged. In a replay of the 2025 NFL season with tables built only from
// 2024 and earlier, a 50/50 average of the model and Vegas win probability beat both on their own (Brier 0.15785 vs.
// 0.15816 Vegas, 0.15829 model; better than Vegas in 74% of game resamples). Season-fitted reweightings did worse out
// of sample. So bets are judged on this "fair" probability, which roughly halves the raw gap and keeps only bets where
// even half the model's disagreement still beats the price.
export const TIERS = {
  low:    { label: 'Low risk',  desc: 'favorites, 60¢ and up: small payouts, hit most of the time', min: 0.60, max: 0.95, fairEdge: 0.025 },
  medium: { label: 'Medium',    desc: 'near coin flips, 35¢ to 60¢', min: 0.35, max: 0.60, fairEdge: 0.03 },
  high:   { label: 'High risk', desc: 'underdogs, 10¢ to 35¢: lose more often, pay 2x to 9x', min: 0.10, max: 0.35, fairEdge: 0.04, paused: true },
};
// High risk is paused: no new bets are logged, shown on the trade desk, or bought by the autopilot. Past bets stay in the
// record. Replaying the 2025-26 NFL seasons (tables built from 1999-2024 only, tools/trading_holdout): against an honest
// in-game price the model almost never finds an underdog worth buying (0 bets in 343 games), the best trust in the model
// for underdog moneylines fit to results is 0% in both seasons, and the underdog bets that do appear come from the model
// and the price being a play apart (ESPN's feed one play behind the exchange: 20% hit at 24-cent prices, -18%).
export const tierActive = t => !!TIERS[t] && !TIERS[t].paused;

// Steady picks: a narrow low-risk rule, the one that held up when replayed on games the model never saw.
// Moneyline only, Q2 through Q4, on a team priced 65 to 85 cents (fees in) that already leads by 4+, and only when the
// model at least agrees: the fair price (model and market averaged) is at or above what you pay. Then cash out (sell)
// once that team's price reaches 90 cents, instead of riding every bet to the final whistle.
// Replay, 2025 + 2026 weeks 1-4 NFL, one per game (tools/trading_holdout/strat.mjs): 64 bets, 86% won or cashed out,
// +12.9% (90% range +3% to +21%), +13% in 2025 and +12% in 2026, and a third less swing per bet than holding to the end.
// 61% reached the cash-out price. Ideas that did worse: a second or third bet per game, stop-losses, selling at the
// two-minute warning, a 7-point lead minimum. The same spots without the model's agreement lost 5%. These rules were
// picked on this same replay, so the real edge is likely smaller. It only works when the price and the game state
// describe the same play: one play apart, the rule lost 4-6%. So a steady pick is logged only after the play has been
// settled on ESPN for 40 seconds and with a quote fetched after that (after scores, timeouts, reviews, quarter breaks).
export const STEADY = { label: 'Steady picks', min: 0.65, max: 0.85, lead: 4, fromQtr: 2, settleMs: 40000, cashOut: 0.90,
  replay: { n: 64, hitOrCash: 0.861, avgPrice: 0.762, roi: 0.129, roiLo: 0.03, roiHi: 0.21, cashedShare: 0.61 },
  desc: 'favorites priced 65¢ to 85¢ that already lead by 4+, from the 2nd quarter on, when the model agrees with the price; cash out at 90¢' };
export const tierOf = cost => cost >= TIERS.low.min ? 'low' : cost >= TIERS.medium.min ? 'medium' : cost >= TIERS.high.min ? 'high' : null;       // a bigger gap than this is almost always a stale or mismatched market price, not an edge

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
  function contracts(g, A, mk) {
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
        out.push({ venue: V, url, type: 'moneyline', sel: `${name(slot)} to win`, slot, team: name(slot), teamId: g.slotId[slot], cost, model: p, edge: p - cost, mid: m.p, ask: m.ask, bid: m.bid ?? null, trade: m.trade });
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
    // Every price is the ask you would actually pay right now, plus that venue's taker fee. No midpoint estimates:
    // a line without a real ask is skipped. Kalshi's fee is about 7% x p x (1 - p); international Polymarket is shown
    // for comparison only (US residents can't trade it) and is priced without a fee.
    const FEE = { Kalshi: p => 0.07 * p * (1 - p), Polymarket: () => 0 };
    const usable = (ask, bid) => ask != null && ask > 0 && ask < 1 && (bid == null || ask - bid <= 0.08);
    for (const [venue, src] of [['Kalshi', mk.kalshi], ['Polymarket', mk.poly]]) {
      if (!src || !src.found) continue;
      const fee = FEE[venue], push = (o, ask, mid) => { const cost = ask + fee(ask); out.push({ venue, url: src.url, ...o, ask, cost, edge: o.model - cost, mid }); };
      for (const side of ['away', 'home']) {
        const m = src[side]; if (!m || m.implied || !usable(m.ask, m.bid)) continue;
        const slot = slotOf(side), p = slot === 'ND' ? wA : 1 - wA;
        push({ type: 'moneyline', sel: `${name(slot)} to win`, slot, team: name(slot), teamId: g.slotId[slot], model: p, bid: m.bid ?? null }, m.ask, m.p);
      }
      for (const s of src.spreads || []) {
        const slot = slotOf(s.side), p = marginP(A, slot === 'ND', s.by); if (p == null) continue;
        const other = slot === 'ND' ? 'UNC' : 'ND', lbl = (t, by) => `${name(t)} ${by > 0 ? '−' + by : '+' + (-by)}`;
        const askOther = s.askOther ?? (s.bid != null ? 1 - s.bid : null);
        if (usable(s.ask, s.bid)) push({ type: 'spread', sel: lbl(slot, s.by), slot, team: name(slot), teamId: g.slotId[slot], by: s.by, model: p }, s.ask, s.p);
        if (usable(askOther, s.ask != null ? 1 - s.ask : null)) push({ type: 'spread', sel: lbl(other, -s.by), slot: other, team: name(other), teamId: g.slotId[other], by: -s.by, model: 1 - p }, askOther, 1 - s.p);
      }
      for (const t of src.totals || []) {
        const p = overP(A, t.line); if (p == null) continue;
        const askUnder = t.askOther ?? (t.bid != null ? 1 - t.bid : null);
        if (usable(t.ask, t.bid)) push({ type: 'total', sel: `Over ${t.line}`, over: true, line: t.line, model: p }, t.ask, t.p);
        if (usable(askUnder, t.ask != null ? 1 - t.ask : null)) push({ type: 'total', sel: `Under ${t.line}`, over: false, line: t.line, model: 1 - p }, askUnder, 1 - t.p);
      }
    }
    for (const e of out) { const mkt = e.mid != null ? e.mid : e.cost; e.fair = (e.model + mkt) / 2; e.fairEdge = e.fair - e.cost; e.tier = tierOf(e.cost); }
    return out;
  }
  // Bets are only ever Polymarket US contracts: it's the venue US residents can trade and the only one whose order
  // book the server reads. Kalshi and international Polymarket prices stay on the page for comparison, never as bets.
  const passes = e => tierActive(e.tier) && e.cost < 0.95 && e.model > 0.03 && e.model < 0.97 && e.edge <= MAX_EDGE && e.fairEdge >= TIERS[e.tier].fairEdge;
  const edges = (g, A, mk) => contracts(g, A, mk).filter(e => e.venue === BUYABLE && e.trade && passes(e)).sort((a, b) => b.fairEdge - a.fairEdge);
  // What PAPER_STAKE dollars buys on the live order book right now. The price becomes the average fill, fee included,
  // so a bet is shown and logged at a price you can actually get. Too thin to fill the stake: not a bet.
  async function verify(g, e) {
    if (!e || e.venue !== BUYABLE || !e.trade) return null;
    const bk = await api[g.league].pmusBook(e.trade.slug), f = simulateFill(bk, e.trade.outcome, PAPER_STAKE);
    if (!f.qty || !f.full) return null;
    const cost = f.cost / f.qty;
    return { ...e, cost, ask: f.avg, edge: e.model - cost, fairEdge: e.fair - cost, tier: tierOf(cost),
      book: { avg: +f.avg.toFixed(4), qty: f.qty, cost: f.cost, stake: PAPER_STAKE, at: Date.now() } };
  }
  async function verifyList(g, list, n = 6, ok = passes) {
    const out = await Promise.all(list.slice(0, n).map(e => verify(g, e).catch(() => null)));
    return out.filter(e => e && ok(e)).sort((a, b) => b.fairEdge - a.fairEdge);
  }
  // Current buy price (per contract, fee in) for open picks, so the page can say whether a logged price is still there
  async function nowPrices(g, ps) {
    return Promise.all(ps.map(async p => {
      if (p.status !== 'open' || p.venue !== BUYABLE || !p.trade) return { key: p.key, now: null, why: p.venue !== BUYABLE ? 'not on Polymarket US' : null };
      try { const f = simulateFill(await api[g.league].pmusBook(p.trade.slug), p.trade.outcome, PAPER_STAKE);
        return { key: p.key, now: f.qty && f.full ? +(f.cost / f.qty).toFixed(4) : null, why: f.qty && f.full ? null : 'no depth', at: Date.now() }; }
      catch { return { key: p.key, now: null, why: 'book unavailable' }; }
    }));
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
    const key = `${g.league}:${g.event}:${e.type}:${e.sel}${extra && extra.auto ? ':auto:' + e.tier : ''}${extra && extra.steady ? ':steady' : ''}`;
    if (db.picks.some(p => p.key === key)) return null;
    const clock = `Q${S.qtr} ${Math.floor(S.secs / 60)}:${String(S.secs % 60).padStart(2, '0')}`;
    const pick = Object.assign({ key, league: g.league, event: g.event, matchup: g.title, venue: e.venue, url: e.url, type: e.type, sel: e.sel, team: e.team || null,
      teamId: e.slot ? g.slotId[e.slot] : null, by: e.by ?? null, line: e.line ?? null, over: e.over ?? null,
      price: +e.cost.toFixed(3), ask: e.ask != null ? +e.ask.toFixed(3) : null, model: +e.model.toFixed(3), edge: +e.edge.toFixed(3), fair: +e.fair.toFixed(3), fairEdge: +e.fairEdge.toFixed(3), tier: e.tier, clock, score: `${g.abbr.ND} ${S.nd}, ${g.abbr.UNC} ${S.unc}`,
      phase: phaseOf(S), why: why(g, A, S, e), at: new Date().toISOString(), quoteAge: Math.round(quoteAge(g) / 1000), book: e.book || null, trade: e.trade || null, status: 'open' }, extra || {});
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
  // Game bets: inside the window, the best qualifying bet in each risk tier, at most one per tier per game
  // Async: candidates are checked on the order book first. busy guards stop a second call logging the same bet meanwhile.
  const busy = new Set();
  async function autoPick(g, A, mk, S) {
    const active = Object.keys(TIERS).filter(tierActive), done = t => db.auto[`${g.league}:${g.event}:${t}`];
    if (active.every(done)) return null;
    if (pastWindow(S)) { for (const t of active) if (!done(t)) db.auto[`${g.league}:${g.event}:${t}`] = { status: 'pass', at: new Date().toISOString(), matchup: g.title }; dirty = true; return null; }
    if (!inWindow(S) || !A || !mk || quoteAge(g) > QUOTE_MAX_AGE) return null; // stale quote: keep looking
    const id = `auto:${g.league}:${g.event}`; if (busy.has(id)) return null; busy.add(id);
    try {
      const list = await verifyList(g, edges(g, A, mk), 10), picked = [];
      for (const t of active) {
        if (done(t)) continue;
        const best = list.find(e => e.tier === t); if (!best) continue; // keep looking until the window closes
        const pick = logPick(g, A, S, best, { auto: true });
        db.auto[`${g.league}:${g.event}:${t}`] = { status: 'bet', at: new Date().toISOString(), key: pick && pick.key, matchup: g.title }; dirty = true; picked.push(pick);
      }
      return picked;
    } finally { busy.delete(id); }
  }
  // Returns the bets that are buyable right now (checked on the book); logs the new ones
  async function consider(g, A, mk, S) {
    const list = await verifyList(g, edges(g, A, mk), 8);
    if (quoteAge(g) > QUOTE_MAX_AGE) return list; // shown, not logged
    const id = `watch:${g.league}:${g.event}`; if (busy.has(id)) return list; busy.add(id);
    try {
      const open = db.picks.filter(p => p.event === g.event && p.league === g.league && !p.auto && !p.steady);
      for (const e of list) {
        if (open.length >= MAX_OPEN_PER_GAME) break;
        // One bet per market type per game. Four spread lines on the same team are one opinion, not four, and
        // counting them separately would make the record look far more certain than it is.
        if (open.some(p => p.type === e.type)) continue;
        const pick = logPick(g, A, S, e); if (pick) open.push(pick);
      }
    } finally { busy.delete(id); }
    return list;
  }

  // ---------- steady picks ----------
  if (!db.steady || typeof db.steady !== 'object') db.steady = {}; // league:event -> { key, at }
  const steadyLive = new Map(); // league:event -> what qualifies right now, for the live list
  function steadyList(g, A, mk, S) {
    if (!A || !mk || !(S.qtr >= STEADY.fromQtr && S.qtr <= 4)) return [];
    const lead = slot => slot === 'ND' ? S.nd - S.unc : S.unc - S.nd;
    return contracts(g, A, mk).filter(e => e.type === 'moneyline' && e.venue === BUYABLE && e.trade && steadyOk(e) && lead(e.slot) >= STEADY.lead).sort((a, b) => b.fairEdge - a.fairEdge);
  }
  const steadyOk = e => e.cost >= STEADY.min && e.cost <= STEADY.max && e.fairEdge >= 0 && e.edge <= MAX_EDGE && e.model < 0.97;
  const steadyDone = (league, event) => !!db.steady[`${league}:${event}`];
  // settled: ms the current play has been on ESPN. Logged once per game, only on a settled play with a quote fetched after it.
  const steadyChecked = new Map(); // league:event -> last book check, so watched games don't hit the book every second
  async function steadyPick(g, A, mk, S, settled) {
    const id = `${g.league}:${g.event}`, now = Date.now();
    if (now - (steadyChecked.get(id) || 0) < 5000 || busy.has('steady:' + id)) return null;
    steadyChecked.set(id, now); busy.add('steady:' + id);
    try {
      const list = await verifyList(g, steadyList(g, A, mk, S), 2, steadyOk);
      if (list.length) steadyLive.set(id, { at: Date.now(), league: g.league, event: g.event, matchup: g.title, clock: `Q${S.qtr} ${Math.floor(S.secs / 60)}:${String(S.secs % 60).padStart(2, '0')}`,
        score: `${g.abbr.ND} ${S.nd}, ${g.abbr.UNC} ${S.unc}`, logged: steadyDone(g.league, g.event), bets: list.map(e => ({ sel: e.sel, venue: e.venue, url: e.url, price: +e.cost.toFixed(3),
          model: +e.model.toFixed(3), fair: +e.fair.toFixed(3), fairEdge: +e.fairEdge.toFixed(3), team: e.team, book: e.book })) });
      else steadyLive.delete(id);
      if (steadyDone(g.league, g.event) || !list.length || !(settled >= STEADY.settleMs) || quoteAge(g) > Math.min(QUOTE_MAX_AGE, settled - STEADY.settleMs)) return null;
      const pick = logPick(g, A, S, list[0], { steady: true });
      db.steady[id] = { key: pick && pick.key, at: new Date().toISOString(), matchup: g.title }; dirty = true;
      return pick;
    } finally { busy.delete('steady:' + id); }
  }
  const dropSteadyLive = (league, event) => steadyLive.delete(`${league}:${event}`);
  // Cash out: an open steady pick whose team's price (midpoint) has reached 90 cents is sold at the bid, fees out.
  // The pick keeps its final result too, but the steady record counts the cash-out, which is what the rule says to do.
  const sellFee = { 'Polymarket US': p => TAKER_THETA * p * (1 - p), Kalshi: p => 0.07 * p * (1 - p) };
  function cashOuts(g, mk) {
    if (!mk || quoteAge(g) > QUOTE_MAX_AGE) return [];
    const open = db.picks.filter(p => p.steady && p.status === 'open' && !p.cashOut && p.league === g.league && p.event === g.event);
    if (!open.length) return [];
    const aIsAway = String(mk.awayId) === String(g.slotId.ND), done = [];
    for (const p of open) {
      const slot = String(p.teamId) === String(g.slotId.ND) ? 'ND' : 'UNC', side = (slot === 'ND') === aIsAway ? 'away' : 'home';
      const src = p.venue === 'Kalshi' ? mk.kalshi : mk.pmus, q = src && src.found && src[side];
      if (!q || q.bid == null || q.p == null || q.p < STEADY.cashOut) continue;
      const fee = (sellFee[p.venue] || sellFee['Polymarket US'])(q.bid), proceeds = +(q.bid - fee).toFixed(4);
      p.cashOut = { at: new Date().toISOString(), bid: q.bid, mid: q.p, proceeds, pl: +(proceeds - p.price).toFixed(3) };
      if (p.fill && p.fill.qty > 0) p.fill.cashPl = +(p.fill.qty * proceeds - p.fill.cost).toFixed(2);
      dirty = true; done.push(p);
    }
    return done;
  }
  const steadyHeld = (league, event) => db.picks.some(p => p.steady && p.status === 'open' && !p.cashOut && p.league === league && p.event === event);
  // Steady record: a cashed-out pick counts as a win at its cash-out profit, whatever happened after
  function steadySummary(sp) {
    const done = sp.filter(p => p.cashOut || p.status === 'won' || p.status === 'lost');
    const pl = x => x.cashOut ? x.cashOut.pl : x.pl || 0, w = done.filter(x => pl(x) > 0).length, cost = done.reduce((a, x) => a + x.price, 0), tot = done.reduce((a, x) => a + pl(x), 0);
    const real = sp.filter(x => x.fill && x.fill.qty > 0 && (x.cashOut || x.status === 'won' || x.status === 'lost')), rpl = x => x.fill.cashPl ?? x.fill.pl ?? 0;
    const rs = real.reduce((a, x) => a + x.fill.cost, 0), rp = real.reduce((a, x) => a + rpl(x), 0);
    return { w, l: done.length - w, cashed: done.filter(x => x.cashOut).length, heldWouldHave: { w: done.filter(x => x.status === 'won').length, l: done.filter(x => x.status === 'lost').length },
      pct: done.length ? w / done.length : null, pl: +tot.toFixed(2), roi: cost ? tot / cost : null,
      realistic: { n: real.length, w: real.filter(x => rpl(x) > 0).length, l: real.filter(x => rpl(x) <= 0).length, staked: +rs.toFixed(2), pl: +rp.toFixed(2), roi: rs ? rp / rs : null } };
  }

  const steadyNow = league => { const now = Date.now(), out = [];
    for (const [k, v] of steadyLive) { if (now - v.at > 60000) { steadyLive.delete(k); continue; } if (league === 'all' || v.league === league) out.push(v); }
    // open steady picks, with a cash-out flag once the price has reached 90 cents
    const held = db.picks.filter(p => p.steady && p.status === 'open' && (league === 'all' || p.league === league)).map(p => ({ event: p.event, league: p.league, matchup: p.matchup, sel: p.sel,
      venue: p.venue, url: p.url, price: p.price, clock: p.clock, cashOut: p.cashOut || null }));
    return { updated: new Date().toISOString(), rule: STEADY, games: out.sort((a, b) => b.bets[0].fairEdge - a.bets[0].fairEdge), held }; };

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
    const mine = db.picks.filter(p => !league || league === 'all' || p.league === league), ps = mine.filter(p => !p.steady), sp = mine.filter(p => p.steady);
    const phases = {}; for (const p of ps) if (p.phase) (phases[p.phase] = phases[p.phase] || []).push(p);
    const passes = Object.entries(db.auto).filter(([k, v]) => v.status === 'pass' && (!league || league === 'all' || k.startsWith(league + ':'))).length;
    const real = ps.filter(p => p.fill && p.fill.qty > 0 && p.status !== 'open' && p.status !== 'push');
    const rStake = real.reduce((a, p) => a + p.fill.cost, 0), rPl = real.reduce((a, p) => a + (p.fill.pl || 0), 0), rW = real.filter(p => p.status === 'won').length;
    const realOf = list => { const r = list.filter(p => p.fill && p.fill.qty > 0 && p.status !== 'open' && p.status !== 'push');
      const st = r.reduce((a, p) => a + p.fill.cost, 0), pl = r.reduce((a, p) => a + (p.fill.pl || 0), 0);
      // how much more each contract really cost on the order book than the price the paper record logged
      const f = list.filter(p => p.fill && p.fill.qty > 0), slip = f.length ? f.reduce((a, p) => a + p.fill.cost / p.fill.qty - p.price, 0) / f.length : null;
      return { n: r.length, w: r.filter(p => p.status === 'won').length, l: r.filter(p => p.status === 'lost').length, staked: +st.toFixed(2), pl: +pl.toFixed(2), roi: st ? pl / st : null,
        slip: slip == null ? null : +slip.toFixed(4) }; };
    const tiers = Object.fromEntries(Object.entries(TIERS).map(([k, t]) => { const tp = ps.filter(p => p.tier === k);
      return [k, { label: t.label, desc: t.desc, minFairEdge: t.fairEdge, paused: !!t.paused, paper: summarize(tp), auto: summarize(tp.filter(p => p.auto)), realistic: realOf(tp), open: tp.filter(p => p.status === 'open').length,
        passes: Object.entries(db.auto).filter(([id, v]) => v.status === 'pass' && id.endsWith(':' + k) && (!league || league === 'all' || id.startsWith(league + ':'))).length }]; }));
    const extra = { tiers, realistic: { n: real.length, w: rW, l: real.length - rW, staked: +rStake.toFixed(2), pl: +rPl.toFixed(2), roi: rStake ? rPl / rStake : null, stake: PAPER_STAKE,
        open: ps.filter(p => p.fill && p.fill.qty > 0 && p.status === 'open').length, unfillable: ps.filter(p => p.fill && p.fill.qty === 0).length }, auto: summarize(ps.filter(p => p.auto)), autoOpen: ps.filter(p => p.auto && p.status === 'open').length, passes, window: WINDOW.label,
      byPhase: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, summarize(v)])) };
    const done = ps.filter(p => p.status === 'won' || p.status === 'lost');
    const w = done.filter(p => p.status === 'won').length, l = done.length - w;
    const cost = done.reduce((a, p) => a + p.price, 0), pl = done.reduce((a, p) => a + (p.pl || 0), 0);
    const byType = {}; for (const p of done) { const t = byType[p.type] || (byType[p.type] = { w: 0, l: 0, pl: 0 }); t[p.status === 'won' ? 'w' : 'l']++; t.pl += p.pl || 0; }
    return { ...extra, record: { w, l, push: ps.filter(p => p.status === 'push').length, pct: done.length ? w / done.length : null, pl: +pl.toFixed(2), roi: cost ? pl / cost : null,
        expected: done.length ? +(done.reduce((a, p) => a + p.model, 0) / done.length).toFixed(3) : null, avgPrice: done.length ? +(cost / done.length).toFixed(3) : null }, byType,
      open: ps.filter(p => p.status === 'open').reverse(), settled: ps.filter(p => p.status !== 'open').reverse(),
      steady: { rule: STEADY, paper: steadySummary(sp), realistic: steadySummary(sp).realistic, open: sp.filter(p => p.status === 'open').reverse(), settled: sp.filter(p => p.status !== 'open').reverse() } };
  }
  const forEvent = (league, event) => db.picks.filter(p => p.league === league && p.event === String(event));
  const autoDone = (league, event) => Object.keys(TIERS).filter(tierActive).every(t => db.auto[`${league}:${event}:${t}`]) || !!db.auto[`${league}:${event}`];
  return { all: () => db.picks, edges, verifyList, nowPrices, consider, autoPick, autoDone, steadyPick, steadyDone, steadyHeld, steadyNow, dropSteadyLive, cashOuts, settle, report, forEvent, flush: () => { dirty = true; save(); } };
}
