// Creative variants of the steady rule, replayed on the 2025-26 holdout. Market = Vegas WP + 1c + PM US taker fee.
import { S, O, stats } from './analyze.mjs';
const fee = p => 0.0695 * p * (1 - p);
const askOf = mid => Math.min(0.99, Math.ceil((mid + 0.01) * 100 - 1e-9) / 100);
const byG = new Map(); S.forEach((s, i) => { if (!byG.has(s.g)) byG.set(s.g, []); byG.get(s.g).push(i); }); // every snap, in order
const R = { lo: 0.6, hi: 0.85, lead: 4, fe: 0 };
// The side that qualifies at snap i (or null)
function qual(i, r = R) {
  const s = S[i], o = O[i]; if (!o || s.qtr < 2 || s.qtr > 4) return null;
  for (const side of [1, -1]) {
    const mid = side === 1 ? s.v : 1 - s.v, model = side === 1 ? o.w : 1 - o.w, ask = askOf(mid), cost = ask + fee(ask), lead = side * (s.nd - s.unc);
    if (cost < r.lo || cost > r.hi || lead < r.lead || (model + mid) / 2 - cost < r.fe) continue;
    return { side, mid, model, cost, fair: (model + mid) / 2 };
  }
  return null;
}
const outcome = (i, side) => { const s = S[i], hm = s.hf - s.af; return side * hm > 0 ? 1 : side * hm < 0 ? 0 : null; };
const settledAt = (idx, k) => k > 0 && (S[idx[k]].nd + S[idx[k]].unc !== S[idx[k - 1]].nd + S[idx[k - 1]].unc || S[idx[k]].qtr !== S[idx[k - 1]].qtr);

// exit: hold to the final, or sell later at the bid (mid - 1c) less the fee when the price hits a target or a stop
function settle(idx, k, q, exit) {
  const y = outcome(idx[k], q.side); if (y == null) return null;
  if (exit) for (let j = k + 1; j < idx.length; j++) {
    const s = S[idx[j]], mid = q.side === 1 ? s.v : 1 - s.v;
    if ((exit.tp && mid >= exit.tp) || (exit.sl && mid <= q.cost - exit.sl) || (exit.at && (s.qtr === 4 && s.secs <= exit.at))) {
      const bid = Math.max(0.01, Math.floor((mid - 0.01) * 100 + 1e-9) / 100); return { y: bid - fee(bid), sold: 1 };
    }
  }
  return { y, sold: 0 };
}
function run({ settled = false, confirm = false, perGame = 1, exit = null, r = R, gap = 20 } = {}) {
  const out = [];
  for (const [g, idx] of byG) {
    let taken = 0, last = -1e9;
    for (let k = 0; k < idx.length && taken < perGame; k++) {
      const q = qual(idx[k], r); if (!q) continue;
      if (settled && !settledAt(idx, k)) continue;
      if (confirm) { let p = k - 1; while (p >= 0 && !O[idx[p]]) p--; if (p < 0 || !qual(idx[p], r) || qual(idx[p], r).side !== q.side) continue; }
      if (k - last < gap) continue; // a second bet must come at least `gap` plays later
      const st = settle(idx, k, q, exit); if (!st) continue;
      out.push({ g, season: S[idx[k]].season, week: S[idx[k]].week, y: st.y, sold: st.sold, cost: q.cost, mid: q.mid, model: q.model, fair: q.fair, tier: 'low' });
      taken++; last = k;
    }
  }
  return out;
}
const f = B => { const x = stats(B); const sd = Math.sqrt(B.reduce((a, b) => a + ((b.y - b.cost) / b.cost - x.roi) ** 2, 0) / B.length);
  return `n=${String(x.n).padStart(3)} hit=${x.hit} cost=${x.cost} roi=${(x.roi * 100).toFixed(1)}% [${(x.lo * 100).toFixed(0)}%, ${(x.hi * 100).toFixed(0)}%] sdPerBet=${sd.toFixed(2)} ` +
    `2025=${(stats(B.filter(b => b.season === 2025)).roi * 100).toFixed(1)}% 2026=${(stats(B.filter(b => b.season === 2026)).roi * 100).toFixed(1)}%`; };
const show = (lab, o) => console.log(lab.padEnd(44), f(run(o)));
show('A. steady as live (first qualifying snap)', {});
show('B. only right after a score / new quarter', { settled: true });
show('C. qualify on two reads in a row', { confirm: true });
show('D. up to 2 bets a game, 20+ plays apart', { perGame: 2 });
show('E. up to 3 bets a game, 15+ plays apart', { perGame: 3, gap: 15 });
for (const tp of [0.9, 0.95, 0.97]) show(`F. sell when price reaches ${tp}`, { exit: { tp } });
for (const sl of [0.2, 0.3]) show(`G. sell if price drops ${sl * 100}c`, { exit: { sl } });
show('H. sell at Q4 2:00 whatever the price', { exit: { at: 120 } });
show('I. lead 7+ instead of 4+', { r: { ...R, lead: 7 } });
show('J. model must beat price by 1c', { r: { ...R, fe: 0.01 } });
show('K. price 65-85c', { r: { ...R, lo: 0.65 } });
show('L. 2 bets/game + sell at 0.95', { perGame: 2, exit: { tp: 0.95 } });

// Bankroll: chronological, $100 start, flat 5% vs quarter-Kelly on the fair probability, capped at 10%
const seq = run({ perGame: 2 }).sort((a, b) => a.season - b.season || a.week - b.week);
for (const [lab, size] of [['flat 5% of start', () => 5], ['quarter Kelly, max 10%', (b, bank) => Math.min(0.1, 0.25 * Math.max(0, (b.fair - b.cost) / (1 - b.cost))) * bank]]) {
  let bank = 100, peak = 100, dd = 0;
  // bets in the same week are sized from the bankroll at the start of that week
  const weeks = [...new Set(seq.map(b => b.season * 100 + b.week))];
  for (const w of weeks) { const start = bank; for (const b of seq.filter(x => x.season * 100 + x.week === w)) { const st = size(b, start); bank += st * (b.y - b.cost) / b.cost; }
    peak = Math.max(peak, bank); dd = Math.max(dd, (peak - bank) / peak); }
  console.log(`bankroll ${lab.padEnd(24)} end $${bank.toFixed(0)}  worst drawdown ${(dd * 100).toFixed(0)}%  over ${seq.length} bets`);
}
console.log('\n--- combined ---');
for (const lo of [0.6, 0.65]) for (const tp of [null, 0.9, 0.92]) show(`price ${lo}-0.85${tp ? `, cash out at ${tp}` : ''}`, { r: { ...R, lo }, exit: tp ? { tp } : null });
// how often does the price hit 90c before the end, and how long after entry (in plays)?
const cash = run({ r: { ...R, lo: 0.65 }, exit: { tp: 0.9 } }); console.log('share cashed out early', (cash.filter(b => b.sold).length / cash.length).toFixed(2));
