// Autopilot for Polymarket US.
//
// You write a sentence ("spend up to $100 on the NFL today, low risk, stop if I'm down $30"), the server turns it into
// settings you check before starting, and then it places bets on its own inside the time window you set.
//
// The learning part: every settled bet the site has logged (paper and real) is evidence about how far to trust the
// model versus the market. For each risk tier it estimates a trust weight w, with
//     probability = w x model + (1 - w) x market,
// fit by maximum likelihood on settled results with a prior centered on 0.5 (the 2025 replay's best blend). With few
// results it stays near 0.5; as results pile up it moves toward whatever the evidence supports, per tier.
//
// Sizing is fractional Kelly on that learned probability: for a contract costing c (fees included) that wins with
// probability p, the Kelly fraction is (p - c) / (1 - c). Risk level sets how much of Kelly to bet and which tiers.
//
// Stops: end of the window, budget used up, loss limit hit, kill switch, or repeated errors. Live mode also obeys
// every manual-trading cap in Render (MAX_ORDER_USD, MAX_DAILY_USD, MAX_OPEN_BETS) and needs AUTOPILOT_LIVE=true.
import { simulateFill, takerFee, readFills } from './pmus.mjs';
import { tierActive, STEADY } from './picks.mjs';

const RISK = {
  low:    { tiers: ['low'], kelly: 0.15, label: 'Low risk: favorites only' },
  medium: { tiers: ['low', 'medium'], kelly: 0.25, label: 'Medium: favorites and coin flips' },
  // The underdog tier is paused (see TIERS in picks.mjs), so the most aggressive setting sizes up favorites and coin flips only
  high:   { tiers: ['low', 'medium'], kelly: 0.40, label: 'Aggressive: favorites, coin flips and small edges (underdog tier paused)' },
};
const PRIOR_W = 0.5, PRIOR_STRENGTH = 40; // the prior counts like 40 settled bets at w = 0.5
// Guard rails, the same ones the logged model bets use, plus one position per game:
const MAX_GAP = 0.10;        // model minus market over 10 points is almost always something the market knows
const MAX_PRICE_AGE = 30000; // the order-book check behind a bet must be under 30 seconds old
const PICK_FRESH = 120000;   // a logged pick is copied within 2 minutes of being logged, never chased later
const GAME_SHARE = 0.25;     // at most a quarter of the budget in any one game
const PER_TICK = 3;          // up to 3 buys per check (checks every 15 seconds)
// A bet's "side" in a game: spreads and moneylines are on a team, totals are over or under. Two bets in one game
// conflict when they're on different sides (CAR +1.5 with DET +1.5, or Over with Under); same-side bets don't.
const sideOf = t => t.type === 'total' ? `total:${t.over ? 'over' : 'under'}` : `team:${t.teamId}`;
const conflicts = (a, b) => (a.type === 'total') === (b.type === 'total') && sideOf(a) !== sideOf(b);

// ---------- turning a sentence into settings ----------
function ruleParse(text, now = new Date()) {
  const t = String(text || '').toLowerCase(), money = [...t.matchAll(/\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:dollars|bucks|usd)/g)].map(m => +(m[1] || m[2]));
  const near = (re) => { const m = t.match(re); return m ? +m[1] : null; };
  const cfg = {
    budget: near(/(?:spend|budget|use|put in|risk|up to|total of)\D{0,12}\$?\s?(\d+(?:\.\d+)?)/) ?? money[0] ?? 50,
    maxPerBet: near(/(?:per bet|each bet|a bet|max(?:imum)? bet|bets? of)\D{0,10}\$?\s?(\d+(?:\.\d+)?)/) ?? near(/\$?\s?(\d+(?:\.\d+)?)\s?(?:per|a|each) bet/),
    stopLoss: near(/(?:stop|quit|pause)[^.]{0,30}?(?:down|lose|lost|loss of)\D{0,6}\$?\s?(\d+(?:\.\d+)?)/) ?? near(/(?:max(?:imum)? loss|loss limit)\D{0,8}\$?\s?(\d+(?:\.\d+)?)/),
    risk: /high|aggress|underdog|long ?shot|big payout|yolo/.test(t) ? 'high' : /low|safe|conservative|careful|favorite/.test(t) ? 'low' : 'medium',
    leagues: /nfl|pro football/.test(t) && !/college|cfb|ncaa/.test(t) ? ['nfl'] : /college|cfb|ncaa/.test(t) && !/nfl/.test(t) ? ['cfb'] : ['cfb', 'nfl'],
    takeProfit: near(/(?:take profit|sell|cash out)[^.]{0,25}?(?:up|above|over|at|gain(?:s|ing)?)\D{0,6}(\d+(?:\.\d+)?)\s?%/) ?? near(/(?:take profit|profit target)\D{0,8}(\d+(?:\.\d+)?)\s?%/),
    stopLossPct: near(/(?:sell|get out|cut)[^.]{0,25}?(?:down|below|loses?|losing)\D{0,6}(\d+(?:\.\d+)?)\s?%/) ?? near(/stop[- ]?loss\D{0,8}(\d+(?:\.\d+)?)\s?%/),
    oneGame: /\b(one|1|single)\s+game\b/.test(t),
  };
  let start = new Date(now), end = null;
  const hrs = t.match(/(?:next|for)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/), until = t.match(/until\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (hrs) end = new Date(now.getTime() + +hrs[1] * 3600000);
  else if (until) { let h = +until[1] % 12; if (until[3] === 'pm' || (!until[3] && h < 9)) h += 12; end = new Date(now); end.setHours(h, +(until[2] || 0), 0, 0); if (end <= now) end.setDate(end.getDate() + 1); }
  else if (/weekend/.test(t)) { end = new Date(now); end.setDate(end.getDate() + ((7 - end.getDay()) % 7) + 1); end.setHours(0, 0, 0, 0); }
  else { end = new Date(now); end.setHours(23, 59, 0, 0); } // default: rest of today
  cfg.start = start.toISOString(); cfg.end = end.toISOString();
  if (cfg.maxPerBet == null) cfg.maxPerBet = Math.max(1, Math.round(cfg.budget / 4)); // each bet uses this amount
  if (cfg.stopLoss == null) cfg.stopLoss = Math.round(cfg.budget * 0.5);
  return cfg;
}
async function claudeParse(text, now) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const sys = `Turn the user's instructions for a sports-betting autopilot into JSON only, no prose. Fields: budget (dollars total), maxPerBet (dollars), stopLoss (dollars of loss that stops the run), risk ("low"|"medium"|"high"), leagues (array of "cfb","nfl"), takeProfit (percent return at which to sell a position, or null), stopLossPct (percent loss at which to sell a position, or null), oneGame (true to bet on one game only), start and end (ISO 8601 with timezone; now is ${now.toISOString()}, the user is in US Eastern time). If something isn't said, use: maxPerBet = budget/8, stopLoss = budget/2, risk "medium", both leagues, start now, end 11:59pm Eastern today.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 400, system: sys, messages: [{ role: 'user', content: String(text).slice(0, 1000) }] }) });
    const j = await r.json(); const out = (j.content || []).map(c => c.text || '').join('');
    return JSON.parse(out.replace(/```json|```/g, '').trim());
  } catch { return null; }
}
export function clampConfig(c, limits, live) {
  const n = (v, d) => (isFinite(+v) && +v > 0 ? +v : d);
  const out = { budget: Math.min(n(c.budget, 50), 100000), maxPerBet: n(c.maxPerBet, 5), stopLoss: n(c.stopLoss, 25),
    risk: RISK[c.risk] ? c.risk : 'medium', leagues: (Array.isArray(c.leagues) ? c.leagues : ['cfb', 'nfl']).filter(l => l === 'cfb' || l === 'nfl'),
    start: new Date(c.start || Date.now()).toISOString(), end: new Date(c.end || Date.now() + 3 * 3600000).toISOString(), mode: c.mode === 'live' ? 'live' : 'paper',
    // exits, per position: sell when its return reaches +takeProfit% or falls to -stopLossPct% (null = hold to the final)
    takeProfit: +c.takeProfit > 0 ? Math.min(500, +c.takeProfit) : null, stopLossPct: +c.stopLossPct > 0 ? Math.min(99, +c.stopLossPct) : null, oneGame: !!c.oneGame,
    // steady picks only: the one rule that held up on the replay; on by default for live money
    steadyOnly: c.steadyOnly != null ? !!c.steadyOnly : c.mode === 'live' };
  if (!out.leagues.length) out.leagues = ['cfb', 'nfl'];
  if (out.mode === 'live') { out.maxPerBet = Math.min(out.maxPerBet, limits.maxOrder); out.budget = Math.min(out.budget, limits.maxDaily); }
  out.maxPerBet = Math.min(out.maxPerBet, out.budget); out.stopLoss = Math.min(out.stopLoss, out.budget);
  if (new Date(out.end) <= new Date(out.start)) out.end = new Date(new Date(out.start).getTime() + 3 * 3600000).toISOString();
  if (new Date(out.end) - new Date(out.start) > 7 * 86400000) out.end = new Date(new Date(out.start).getTime() + 7 * 86400000).toISOString();
  return out;
}
export const describe = c => `${c.mode === 'live' ? 'LIVE money' : 'PAPER (no real orders)'}: up to $${c.budget} total, $${c.maxPerBet} a bet, `
  + `${RISK[c.risk].label}, ${c.leagues.map(l => l === 'nfl' ? 'NFL' : 'college').join(' and ')}, from ${new Date(c.start).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' })} `
  + `to ${new Date(c.end).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' })} ET, stop after losing $${c.stopLoss}.`
  + `${c.oneGame ? ' One game only.' : ''}${c.steadyOnly ? ' Steady picks only.' : ''} Sell a position ${c.takeProfit || c.stopLossPct ? [c.takeProfit ? `when it's up ${c.takeProfit}%` : '', c.stopLossPct ? `when it's down ${c.stopLossPct}%` : ''].filter(Boolean).join(' or ') : 'only at the final'}${' (steady picks also at 90¢)'}.`;

// ---------- learning how much to trust the model ----------
export function learnTrust(picks) {
  const out = {};
  for (const tier of ['low', 'medium', 'high']) {
    const S = picks.filter(p => p.tier === tier && (p.status === 'won' || p.status === 'lost') && p.why && p.why.mid != null && p.model != null);
    let best = PRIOR_W, bestLL = -Infinity;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      let ll = -PRIOR_STRENGTH * 2 * (w - PRIOR_W) ** 2; // Gaussian-ish prior around 0.5
      for (const p of S) { const q = Math.min(0.995, Math.max(0.005, w * p.model + (1 - w) * p.why.mid)); ll += p.status === 'won' ? Math.log(q) : Math.log(1 - q); }
      if (ll > bestLL) { bestLL = ll; best = +w.toFixed(2); }
    }
    out[tier] = { w: best, n: S.length };
  }
  return out;
}

export function createAutopilot({ db, save, trader, api, limits, enabledLive, leading, liveChecks }) {
  db.autopilot = db.autopilot || null; db.portfolio = db.portfolio || { real: [], paper: [] };
  const log = (msg) => { if (!db.autopilot) return; db.autopilot.log.unshift({ at: new Date().toISOString(), msg }); db.autopilot.log = db.autopilot.log.slice(0, 120); };
  const runTrades = () => db.autopilot ? db.trades.filter(t => t.run === db.autopilot.id) : [];
  function stats() {
    const T = runTrades().filter(t => t.qty > 0 && t.status !== 'void'), spent = T.reduce((a, t) => a + t.cost, 0);
    const settled = T.filter(t => t.status === 'won' || t.status === 'lost' || t.status === 'push' || t.status === 'cashed'), pl = settled.reduce((a, t) => a + (t.pl || 0), 0);
    const openCost = T.filter(t => t.status === 'open').reduce((a, t) => a + t.cost, 0);
    return { bets: T.length, spent: +spent.toFixed(2), realized: +pl.toFixed(2), openCost: +openCost.toFixed(2), won: settled.filter(t => t.status === 'won' || (t.status === 'cashed' && t.pl > 0)).length, cashed: settled.filter(t => t.status === 'cashed').length, lost: settled.filter(t => t.status === 'lost').length };
  }
  // What selling `qty` of a position would bring right now: walk the side we'd sell into. YES positions sell into YES
  // bids; NO positions (held as short YES) close by buying YES from the offers, worth 1 - price per share to us.
  function sellFill(bk, outcome, qty) {
    const levels = outcome === 'YES' ? bk.bids.map(l => ({ px: l.px, qty: l.qty })) : bk.offers.map(l => ({ px: 1 - l.px, qty: l.qty }));
    let left = qty, gross = 0, worst = null;
    for (const l of levels) { if (left <= 0) break; const take = Math.min(left, l.qty); gross += take * l.px; left -= take; worst = l.px; }
    if (left > 0) return null; // not enough on the book to sell the whole position at once: wait
    const fee = takerFee(qty, gross / qty);
    return { proceeds: +(gross - fee).toFixed(2), avg: gross / qty, worst, fee };
  }
  // Exits, checked for every open position of this run on every tick:
  //   steady picks: sold when their side's price reaches 90c (the rule);
  //   any position: sold when its return (what selling now brings, fees out, vs. what it cost) reaches +takeProfit%
  //   or falls to -stopLossPct%, if you set them.
  // Paper mode records the sale at the book. Live mode sends a limit order, immediate-or-cancel, at the worst level the
  // sale needs minus the slippage allowance, so it can't fill worse than that. The close order is the reverse of the
  // buy (sell YES / buy back YES); if the exchange ever treated it as a new position instead, holding both sides of one
  // market locks in the same value until settlement, so it still can't add risk.
  async function exits(A) {
    const c = A.config;
    for (const t of db.trades.filter(t => t.run === A.id && t.status === 'open' && t.qty > 0)) {
      try {
        const bk = await api.book(t.league, t.slug), s = sellFill(bk, t.outcome, t.qty); if (!s) continue;
        const bid = t.outcome === 'YES' ? bk.bids[0]?.px : bk.offers[0] ? 1 - bk.offers[0].px : null, ask = t.outcome === 'YES' ? bk.offers[0]?.px : bk.bids[0] ? 1 - bk.bids[0].px : null;
        const ret = (s.proceeds - t.cost) / t.cost, mid = bid != null && ask != null ? (bid + ask) / 2 : null;
        const why = t.steady && mid != null && mid >= STEADY.cashOut ? 'steady pick reached 90¢'
          : c.takeProfit != null && ret * 100 >= c.takeProfit ? `up ${(ret * 100).toFixed(0)}% (take profit at +${c.takeProfit}%)`
          : c.stopLossPct != null && ret * 100 <= -c.stopLossPct ? `down ${(-ret * 100).toFixed(0)}% (stop loss at -${c.stopLossPct}%)` : null;
        if (!why) continue;
        if (t.mode === 'paper') { closeAs(t, t.qty, s.proceeds, s.avg, why); continue; }
        if (t.exitTriedAt && Date.now() - Date.parse(t.exitTriedAt) < 30000) continue; // one live attempt per 30s per position
        t.exitTriedAt = new Date().toISOString();
        // the exchange's close-position order: sells this whole position, within 3% of the current YES price
        const yesMid = bk.bids[0] && bk.offers[0] ? (bk.bids[0].px + bk.offers[0].px) / 2 : bk.bids[0]?.px ?? null;
        let r; try { r = await trader.closePosition({ slug: t.slug, currentYesPx: yesMid, slippageBips: 300 }); } catch (e) { log(`Couldn't sell ${t.sel}: ${e.message || e}. Will retry.`); save(); continue; }
        const F = await readFills(trader, r);
        if (!F.qty) { log(`Tried to sell ${t.sel} (${why}): no fill${F.reject ? ` (${F.reject})` : ''}. Will retry.`); save(); continue; }
        closeAs(t, Math.min(F.qty, t.qty), +(F.notional - F.fee).toFixed(2), F.avgYes, why);
      } catch (e) { /* one position's book failing must not stop the others */ }
    }
  }
  // Record a sale of q shares of trade t for `proceeds`. A partial sale splits the trade: the sold part is closed, the
  // rest stays open with its share of the cost.
  function closeAs(t, q, proceeds, avg, why) {
    const part = q / t.qty, cost = +(t.cost * part).toFixed(2), now = new Date().toISOString();
    if (q < t.qty) {
      db.trades.push({ ...t, qty: q, cost, status: 'cashed', pl: +(proceeds - cost).toFixed(2), cashedAt: now, cashBid: +avg.toFixed(4), exit: why, splitFrom: t.orderId || t.at });
      t.qty -= q; t.cost = +(t.cost - cost).toFixed(2);
    } else Object.assign(t, { status: 'cashed', pl: +(proceeds - t.cost).toFixed(2), cashedAt: now, cashBid: +avg.toFixed(4), exit: why });
    log(`Sold ${q} ${t.sel} (${t.matchup}) @ ${Math.round(avg * 100)}¢: ${why}. ${proceeds - cost >= 0 ? '+' : '−'}$${Math.abs(proceeds - cost).toFixed(2)}.`); save();
  }
  let busy = false, errors = 0; const skipNoted = new Set();
  async function tick() {
    const A = db.autopilot; if (!A || A.status !== 'running' || busy) return;
    busy = true;
    try {
      const now = Date.now(), c = A.config, st = stats();
      if (now > Date.parse(c.end)) return stop('time window ended');
      if (now < Date.parse(c.start)) return;
      if (db.killed) return stop('kill switch');
      if (-st.realized >= c.stopLoss) return stop(`loss limit hit (down $${(-st.realized).toFixed(2)})`);
      let room = c.budget - st.spent; if (room < 1) return stop('budget used');
      if (c.mode === 'live' && !enabledLive()) return stop('live trading switched off in Render');
      if (c.mode === 'live' && !trader) return stop('no Polymarket US keys in Render');
      const trust = learnTrust(api.picksAll());
      const tiers = RISK[c.risk].tiers;
      await exits(A);
      // one game only: after the first fill, only that game; once its bets are all closed or graded, the run is done
      if (c.oneGame && A.lockedEvent) {
        const mine = runTrades().filter(t => t.event === A.lockedEvent && t.qty > 0 && t.status !== 'void');
        if (mine.length && !mine.some(t => t.status === 'open') && (mine.some(t => t.status === 'won' || t.status === 'lost' || t.status === 'push')
            || Date.now() - Math.max(...mine.map(t => Date.parse(t.cashedAt || t.at))) > 30 * 60000)) return stop(`one game done (${A.lockedMatchup})`);
      }
      // Candidates: steady picks first (the rule that held up on the replay), then the model's tier bets
      // Candidates: every pick the model logs (steady picks, tier bets; small edges too on the High setting), copied
      // within 2 minutes on Polymarket US at no more than the logged price
      const kindOf = p => p.steady ? 'steady' : p.lean ? 'lean' : 'model';
      const cands = api.picksAll().filter(p => p.status === 'open' && !p.cashOut && p.venue === 'Polymarket US' && p.trade && p.trade.slug && c.leagues.includes(p.league)
          && Date.now() - Date.parse(p.at) < PICK_FRESH && (p.steady || (!c.steadyOnly && (p.lean ? c.risk === 'high' : tiers.includes(p.tier) && tierActive(p.tier)))))
        .map(p => ({ src: kindOf(p), league: p.league, event: p.event, matchup: p.matchup, sel: p.sel, type: p.type, teamId: p.teamId, by: p.by, line: p.line, over: p.over,
          tier: p.steady ? 'low' : p.tier, model: p.model, mid: p.why && p.why.mid != null ? p.why.mid : p.price, fair: p.fair, logged: p.price, trade: p.trade, key: p.key }))
        .filter(b => b.model - b.mid <= MAX_GAP)                                     // big gaps are information the model lacks
        .filter(b => !(c.oneGame && A.lockedEvent) || b.event === A.lockedEvent)     // one game only: stay on it
        .filter(b => { if (c.mode !== 'live' || b.trade.outcome === 'YES') return true;      // live: YES contracts only (see pmus.mjs)
          const k = `no-side|${b.key}`; if (!skipNoted.has(k)) { skipNoted.add(k); log(`Skipped ${b.sel}: it's a No-side contract, which isn't placed through the API yet.`); } return false; })
        .filter(b => !runTrades().some(t => t.pick === b.key || (t.qty > 0 && t.slug === b.trade.slug)))  // each pick and market once
        .sort((a, b) => (a.src === 'steady' ? 0 : a.src === 'model' ? 1 : 2) - (b.src === 'steady' ? 0 : b.src === 'model' ? 1 : 2));
      let bought = 0;
      const inGame = ev => db.trades.filter(t => t.qty > 0 && t.event === ev && (t.status === 'open' || t.run === A.id));
      for (const b of cands) {
        if (bought >= PER_TICK || room < 1) break;
        if (c.oneGame && A.lockedEvent && b.event !== A.lockedEvent) continue;
        try {
        const held = inGame(b.event);
        if (held.some(t => t.status === 'open' && conflicts(t, b))) continue;           // never the other side of an open bet
        const gameRoom = (c.oneGame ? 1 : GAME_SHARE) * c.budget - held.filter(t => t.status === 'open').reduce((a, t) => a + t.cost, 0); // one-game runs put the whole budget on that game
        if (gameRoom < 1) continue;                                                       // this game already has its share
        const w = b.src === 'steady' ? 0.5 : trust[b.tier].w, p = w * b.model + (1 - w) * b.mid;
        const bk = await api.book(b.league, b.trade.slug);
        const probe = simulateFill(bk, b.trade.outcome, Math.min(c.maxPerBet, room));
        if (!probe.qty) continue;
        const cost1 = probe.cost / probe.qty, edge = p - cost1;
        if (cost1 > b.logged + 0.01) continue; // the price moved past what the pick was logged at: don't chase it
        if (b.src === 'steady') { // the steady rule itself: 65-85c, fair at or above the price
          if (cost1 < STEADY.min || cost1 > STEADY.max || edge < 0) continue;
        } else if (edge < 0.01) continue; // after the learned trust, still at least 1 point of value per contract
        // Flat stake: every bet uses your per-bet amount (the steady rule's own advice: the same amount every time), limited
        // by what's left of the budget and of this game's share
        const stake = Math.min(c.maxPerBet, room, gameRoom);
        if (stake < 1) continue;
        const f = simulateFill(bk, b.trade.outcome, stake); if (!f.qty) continue;
        const limitSide = Math.min(0.99, +(f.worst + limits.slip).toFixed(2));
        let qty = f.qty; while (qty > 1 && qty * limitSide + takerFee(qty, limitSide) > stake + 0.01) qty--;
        const plan = { slug: b.trade.slug, outcome: b.trade.outcome, qty, limitSide, limitYesPx: b.trade.outcome === 'YES' ? limitSide : +(1 - limitSide).toFixed(2),
          maxCost: +(qty * limitSide + takerFee(qty, limitSide)).toFixed(2), league: b.league, event: b.event, matchup: b.matchup, sel: b.sel, type: b.type,
          teamId: b.teamId, by: b.by, line: b.line, over: b.over, model: b.model, fair: +p.toFixed(3), tier: b.tier, trust: w, src: b.src, steady: b.src === 'steady', pick: b.key };
        let t;
        if (c.mode === 'paper') {
          t = { ...plan, at: new Date().toISOString(), day: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), mode: 'paper', run: A.id,
            qty: f.qty, avg: +f.avg.toFixed(4), fee: f.fee, cost: f.cost, status: 'open' };
        } else {
          const bad = liveChecks(plan).filter(x => !x.ok); if (bad.length) { log(`Skipped ${b.sel}: ${bad.map(x => x.msg).join('; ')}`); continue; }
          let r, err = null; try { r = await trader.place({ ...plan, auto: true }); } catch (e) { err = String(e.message || e); }
          const F = r ? await readFills(trader, r) : { qty: 0, notional: 0, fee: 0, reject: null }; // confirmed from the exchange
          const q = F.qty, notional = F.notional, fee = F.fee; if (!err && !q && F.reject) err = `rejected: ${F.reject}`;
          t = { ...plan, at: new Date().toISOString(), day: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), mode: 'live', run: A.id, orderId: r && r.id || null, error: err,
            qty: q, avg: q ? +(notional / q).toFixed(4) : null, fee: +fee.toFixed(2), cost: +(notional + fee).toFixed(2), status: q > 0 ? 'open' : 'unfilled' };
          if (err) { log(`Order for ${b.sel} failed: ${err}`); errors++; if (errors >= 3) { db.trades.push(t); return stop(`3 order errors in a row (${err})`); } } else errors = 0;
        }
        db.trades.push(t);
        log(`${t.qty > 0 ? 'Bought' : 'Tried'} ${b.sel} (${b.matchup}): ${t.qty} @ ${t.avg != null ? Math.round(t.avg * 100) + '¢' : '–'}, $${t.cost} total. Model ${(b.model * 100).toFixed(1)}%, market ${(b.mid * 100).toFixed(1)}%, trust ${Math.round(w * 100)}% model, so ${(p * 100).toFixed(1)}% vs ${Math.round(cost1 * 100)}¢.`);
        if (t.qty > 0 && c.oneGame && !A.lockedEvent) { A.lockedEvent = b.event; A.lockedMatchup = b.matchup; log(`One game only: ${b.matchup}.`); }
        save(); bought++; if (t.qty > 0) room -= t.cost; // up to PER_TICK buys per check; each walks its own fresh order book
        } catch (e) { const k = `${b.key}|${e.message}`; if (!skipNoted.has(k)) { skipNoted.add(k); log(`Skipped ${b.sel}: ${e.message || e}`); } } // one bad book or order mustn't stop the rest (logged once)
      }
    } catch (e) { log(`Error: ${e.message || e}`); }
    finally { busy = false; }
  }
  function stop(reason) { if (db.autopilot && db.autopilot.status === 'running') { db.autopilot.status = 'stopped'; db.autopilot.endedAt = new Date().toISOString(); db.autopilot.reason = reason; log(`Stopped: ${reason}`); save(); } busy = false; }

  // ---------- portfolio history: account value every 5 minutes, plus the autopilot's paper bankroll ----------
  async function snapshot() {
    const t = new Date().toISOString();
    if (trader) try { const b = (await trader.balances()).balances?.[0]; if (b) db.portfolio.real.push({ t, cash: +(b.currentBalance || 0), positions: +(b.assetNotional || 0), total: +((+b.currentBalance || 0) + (+b.assetNotional || 0)).toFixed(2) }); } catch {}
    const P = db.trades.filter(x => x.mode === 'paper' && x.qty > 0);
    if (P.length) {
      // paper value: what was put in, minus open cost, plus settled payouts, plus open positions marked to the order book
      let mark = 0;
      for (const x of P.filter(x => x.status === 'open').slice(0, 20)) { try { const bk = await api.book(x.league, x.slug); const bid = bk.bids[0]?.px, ask = bk.offers[0]?.px;
        const yes = bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? null; mark += x.qty * (yes == null ? x.avg : x.outcome === 'YES' ? yes : 1 - yes); } catch { mark += x.cost; } }
      const realized = P.filter(x => x.status !== 'open').reduce((a, x) => a + (x.pl || 0), 0), openCost = P.filter(x => x.status === 'open').reduce((a, x) => a + x.cost, 0);
      db.portfolio.paper.push({ t, pl: +(realized + mark - openCost).toFixed(2), open: +mark.toFixed(2) });
    }
    for (const k of ['real', 'paper']) { const a = db.portfolio[k]; if (a.length > 6000) db.portfolio[k] = a.filter((_, i) => i % 2 === 0 || i > a.length - 2000); }
    save();
  }
  setInterval(tick, 15000).unref(); setInterval(snapshot, +process.env.PORTFOLIO_MS || 5 * 60000).unref(); setTimeout(snapshot, 20000).unref();

  return {
    async parse(text) { const now = new Date(); const ai = await claudeParse(text, now); return { config: ai || ruleParse(text, now), source: ai ? 'claude' : 'rules' }; },
    start(cfg) {
      if (db.autopilot && db.autopilot.status === 'running') throw new Error('An autopilot run is already going. Stop it first.');
      db.autopilot = { id: `run-${Date.now()}`, status: 'running', config: cfg, summary: describe(cfg), startedAt: new Date().toISOString(), log: [] };
      log(`Started. ${describe(cfg)}`); save(); setTimeout(tick, 1000); return db.autopilot;
    },
    stop: () => stop('stopped by you'),
    state: () => ({ run: db.autopilot ? { ...db.autopilot, stats: stats() } : null, trust: learnTrust(api.picksAll()), portfolio: db.portfolio, risk: RISK }),
  };
}
