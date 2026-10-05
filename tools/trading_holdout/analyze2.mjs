// Luck vs skill, team concentration, and what the high tier should be, on the 2025-26 holdout.
import { bets, stats, BASE, S, O, board, TIERS } from './analyze.mjs';
const P = (...a) => console.log(...a);
const ll = (p, y) => { p = Math.min(0.995, Math.max(0.005, p)); return y ? -Math.log(p) : -Math.log(1 - p); };

for (const lad of [false, true]) {
  const B = bets({ ...BASE, ladders: lad });
  P(`\n##### ${lad ? 'ML + ladders' : 'ML only'}: base costs, ${B.length} bets`);
  // 1. Season split
  for (const yr of [2025, 2026]) P('season', yr, JSON.stringify(Object.fromEntries(['low', 'medium', 'high'].map(t => [t, stats(B.filter(b => b.season === yr && b.tier === t))]))));
  // 2. Team concentration: profit per team backed (totals have no team)
  for (const t of ['all', 'low', 'medium', 'high']) {
    const X = B.filter(b => (t === 'all' || b.tier === t) && b.team); if (!X.length) continue;
    const by = {}; for (const b of X) { const r = by[b.team] || (by[b.team] = { n: 0, pl: 0, st: 0 }); r.n++; r.pl += b.y - b.cost; r.st += b.cost; }
    const tot = X.reduce((a, b) => a + b.y - b.cost, 0), st = X.reduce((a, b) => a + b.cost, 0);
    const top = Object.entries(by).sort((a, b) => b[1].pl - a[1].pl);
    const loo = Object.keys(by).map(k => (tot - by[k].pl) / (st - by[k].st));
    const top3 = top.slice(0, 3).reduce((a, x) => a + x[1].pl, 0);
    P(`teams[${t}] n=${X.length} teams=${top.length} totalPL=${tot.toFixed(2)} roi=${(tot / st).toFixed(3)} top3=${top.slice(0, 3).map(x => `${x[0]}(${x[1].n}b,${x[1].pl.toFixed(2)})`).join(' ')} top3share=${(top3 / tot).toFixed(2)} ` +
      `roiWithoutTop3=${((tot - top3) / (st - top.slice(0, 3).reduce((a, x) => a + x[1].st, 0))).toFixed(3)} leaveOneTeamOut=[${Math.min(...loo).toFixed(3)}, ${Math.max(...loo).toFixed(3)}] bottom3=${top.slice(-3).map(x => `${x[0]}(${x[1].pl.toFixed(2)})`).join(' ')}`);
  }
  // 3. Who predicted the bets best: raw model, 50/50 fair, or the market?
  for (const t of ['low', 'medium', 'high']) {
    const X = B.filter(b => b.tier === t); if (!X.length) continue;
    const L = k => (X.reduce((a, b) => a + ll(b[k], b.y), 0) / X.length).toFixed(4);
    P(`logloss[${t}] n=${X.length} model=${L('model')} fair=${L('fair')} market=${L('mid')}  hit=${(X.reduce((a, b) => a + b.y, 0) / X.length).toFixed(3)} vs market ${(X.reduce((a, b) => a + b.mid, 0) / X.length).toFixed(3)} model ${(X.reduce((a, b) => a + b.model, 0) / X.length).toFixed(3)}`);
  }
  // 4. Types inside each tier
  for (const t of ['low', 'medium', 'high']) P(`types[${t}]`, JSON.stringify(Object.fromEntries(['ml', 'spread', 'total'].map(k => [k, stats(B.filter(b => b.tier === t && b.type === k))]).filter(x => x[1].n))));
}

// 5. Learned trust per tier, on every contract on the board at the first in-window snap of each game (not only the
//    ones the rule picked, so selection doesn't bias it). Fit on 2025, checked on 2026.
const firstIn = new Map(); S.forEach((s, i) => { if (O[i] && ((s.qtr === 3 && s.secs <= 450) || (s.qtr === 4 && s.secs >= 480)) && !firstIn.has(s.g)) firstIn.set(s.g, i); });
for (const lad of [false, true]) {
  const C = []; for (const [g, i] of firstIn) for (const c of board(S[i], O[i], lad)) if (c.y != null && c.mid > 0.02 && c.mid < 0.98) C.push({ ...c, season: S[i].season, tier: c.mid >= 0.6 ? 'low' : c.mid >= 0.35 ? 'medium' : c.mid >= 0.1 ? 'high' : null });
  for (const t of ['low', 'medium', 'high']) {
    const fit = set => { let bw = 0, bl = Infinity; for (let w = 0; w <= 1.0001; w += 0.05) { const l = set.reduce((a, c) => a + ll(w * c.model + (1 - w) * c.mid, c.y), 0); if (l < bl) { bl = l; bw = +w.toFixed(2); } } return bw; };
    const A = C.filter(c => c.tier === t), a25 = A.filter(c => c.season === 2025), a26 = A.filter(c => c.season === 2026);
    // bootstrap the all-data fit by game
    const gs = [...new Set(A.map(c => c.g))], byG = {}; for (const c of A) (byG[c.g] = byG[c.g] || []).push(c);
    const W = []; for (let k = 0; k < 300; k++) { const s = []; for (let j = 0; j < gs.length; j++) s.push(...byG[gs[(Math.random() * gs.length) | 0]]); W.push(fit(s)); } W.sort((a, b) => a - b);
    P(`trust[${lad ? 'ML+lad' : 'ML'}][${t}] contracts=${A.length} w(all)=${fit(A)} 90%CI=[${W[15]}, ${W[284]}] w(2025)=${fit(a25)} w(2026)=${fit(a26)}`);
  }
}

// 6. How much a record can be luck: 95% range of ROI for a bettor with zero edge, by tier price and number of bets
P('\nzero-edge 95% ROI band (bets at fair price, no fees):');
for (const c of [0.75, 0.47, 0.22]) P(`price ${c}: ` + [25, 50, 100, 200, 500, 1000].map(n => `n=${n} ±${(1.96 * Math.sqrt(c * (1 - c) / n) / c * 100).toFixed(0)}%`).join('  '));
