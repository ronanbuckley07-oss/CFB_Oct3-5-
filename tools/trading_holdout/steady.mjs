// Search for a simple low-risk rule ("steady picks"): favorites priced 60c+, one bet per game, first snap that qualifies.
// Rules are scored on 2025 games and then checked on 2026 games they were not chosen on. Moneyline only (real market proxy).
import { S, O, stats } from './analyze.mjs';
const fee = p => 0.0695 * p * (1 - p);
const byG = new Map(); S.forEach((s, i) => { if (O[i]) { if (!byG.has(s.g)) byG.set(s.g, []); byG.get(s.g).push(i); } });
const tl = s => (4 - Math.min(4, s.qtr)) * 900 + s.secs;
const PH = { 'Q1-Q2': s => s.qtr <= 2, 'Q3': s => s.qtr === 3, 'Q3 7:30-Q4 8:00': s => (s.qtr === 3 && s.secs <= 450) || (s.qtr === 4 && s.secs >= 480), 'Q4 8:00-3:00': s => s.qtr === 4 && s.secs < 480 && s.secs >= 180, 'any Q2-Q4': s => s.qtr >= 2 };
function run(rule, half = 0.01, slip = 0) {
  const out = [];
  for (const [g, idx] of byG) for (const i of idx) {
    const s = S[i], o = O[i]; if (!PH[rule.ph](s)) continue;
    const hm = s.hf - s.af; let took = false;
    for (const side of [1, -1]) {
      const mid = side === 1 ? s.v : 1 - s.v, model = side === 1 ? o.w : 1 - o.w, y = side * hm > 0 ? 1 : side * hm < 0 ? 0 : null;
      if (y == null) continue;
      const ask = Math.min(0.99, Math.ceil((mid + half + slip) * 100 - 1e-9) / 100), cost = ask + fee(ask);
      const lead = side * (s.nd - s.unc);
      if (cost < rule.lo || cost > rule.hi) continue;
      if ((model + mid) / 2 - cost < rule.fe) continue;
      if (rule.lead != null && lead < rule.lead) continue;
      out.push({ g, season: s.season, y, cost, mid, model, fair: (model + mid) / 2, team: side === 1 ? s.home : s.away, tier: 'low' }); took = true; break;
    }
    if (took) break;
  }
  return out;
}
const rules = [];
for (const ph of Object.keys(PH)) for (const [lo, hi] of [[0.6, 0.75], [0.6, 0.85], [0.7, 0.85], [0.75, 0.9], [0.6, 0.9]]) for (const fe of [0, 0.01, 0.02, 0.03]) for (const lead of [null, 1, 4, 8])
  rules.push({ ph, lo, hi, fe, lead });
const res = rules.map(r => { const B = run(r); return { r, fit: stats(B.filter(b => b.season === 2025)), test: stats(B.filter(b => b.season === 2026)), all: stats(B) }; })
  .filter(x => x.fit.n >= 40);
res.sort((a, b) => b.fit.lo - a.fit.lo);
const f = x => `n=${x.n} hit=${x.hit} cost=${x.cost} roi=${x.roi} [${x.lo},${x.hi}]`;
console.log('rules tried', rules.length, 'with 40+ bets in 2025', res.length);
console.log('\nTop 12 by 2025 worst-case (5th pct) return, and how each did on 2026:');
for (const x of res.slice(0, 12)) console.log(JSON.stringify(x.r), '\n   2025', f(x.fit), '\n   2026', f(x.test));
const pos = res.filter(x => x.fit.roi > 0), both = pos.filter(x => x.test.roi > 0);
console.log(`\n${pos.length} rules were profitable on 2025; ${both.length} of those were also profitable on 2026.`);
// The plain baseline: every favorite at 60-85c in the window, no model at all
console.log('\nBaseline, no model (fe=-1):', f(stats(run({ ph: 'Q3 7:30-Q4 8:00', lo: 0.6, hi: 0.85, fe: -1, lead: null }))));
if (process.env.RULE) { const r = JSON.parse(process.env.RULE); for (const sl of [0, 0.01, 0.02]) console.log('chosen rule, slip', sl, f(stats(run(r, 0.01, sl)))); }
