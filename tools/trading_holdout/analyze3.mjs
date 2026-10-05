// Timing mismatch between the game state the model sees and the market quote it is compared with.
//   staleQuote L: model on the current snap, quote from L snaps ago (the scanner refreshes markets every 3 min, ~4-5 snaps).
//                 The bet is logged at the old quote, but an order placed now pays the current price.
//   lateFeed  L: market current, model on the snap L plays ago (ESPN's feed trails the exchange).
import { S, O, board, qualify, stats, BASE } from './analyze.mjs';
const inWindow = s => (s.qtr === 3 && s.secs <= 450) || (s.qtr === 4 && s.secs >= 480);
const byG = new Map(); S.forEach((s, i) => { if (O[i]) { if (!byG.has(s.g)) byG.set(s.g, []); byG.get(s.g).push(i); } });
function run(mode, L, ladders) {
  const logged = [], real = [];
  for (const [g, idx] of byG) {
    const done = {};
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], s = S[i]; if (!inWindow(s) || k - L < 0) continue;
      const j = idx[k - L];
      // stale quote: market from snap j, model from i. late feed: market from i, model from j.
      const mkS = mode === 'staleQuote' ? S[j] : s, mdO = mode === 'staleQuote' ? O[i] : O[j];
      const seen = board({ ...s, v: mkS.v, nd: s.nd, unc: s.unc }, mdO, ladders);
      const now = board(s, O[i], ladders);
      const list = seen.map((c, n) => { const q = qualify(c, BASE); return q && { q, cur: now[n] }; }).filter(Boolean).sort((a, b) => b.q.fairEdge - a.q.fairEdge);
      for (const t of ['low', 'medium', 'high']) {
        if (done[t]) continue; const b = list.find(e => e.q.tier === t); if (!b) continue; done[t] = 1;
        logged.push({ ...b.q, g });
        // what the order really pays: the current ask for the same contract
        const c = b.cur, ask = Math.min(0.99, Math.ceil((c.mid + (c.type === 'ml' ? BASE.hML : BASE.hLad)) * 100 - 1e-9) / 100), cost = ask + 0.0695 * ask * (1 - ask);
        real.push({ ...b.q, mid: c.mid, cost, g, fair: b.q.fair });
      }
    }
  }
  const f = B => Object.fromEntries(['all', 'low', 'medium', 'high'].map(t => { const x = stats(t === 'all' ? B : B.filter(b => b.tier === t)); return [t, `n=${x.n} hit=${x.hit} cost=${x.cost} roi=${x.roi} [${x.lo},${x.hi}]`]; }));
  console.log(`${mode} L=${L} ${ladders ? 'ML+lad' : 'ML'}\n  logged price: ${JSON.stringify(f(logged))}\n  real price:   ${JSON.stringify(f(real))}`);
}
for (const lad of [false, true]) { run('staleQuote', 0, lad); for (const L of [1, 2, 4]) run('staleQuote', L, lad); for (const L of [1, 2]) run('lateFeed', L, lad); }
