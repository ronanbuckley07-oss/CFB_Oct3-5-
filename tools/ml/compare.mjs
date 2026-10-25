// Monte Carlo vs machine learning vs the market, scored on the same plays the models never trained on.
//   node tools/ml/compare.mjs nfl <holdout_snaps.json> <holdout_out.json> <wpml_nfl_test.json>
//   node tools/ml/compare.mjs cfb <cfb_snaps_2025.json> <mc_cfb_2025.json> <wpml_cfb_test.json>
// Prints a summary and writes api/mlcompare_<league>.json for the site.
// Bet replay (NFL only: Vegas win probability stands in for a tradable price; ESPN's college number isn't one):
// moneylines, ask = mid + 1 cent rounded up, plus the Polymarket US taker fee, one bet per game at the first play that
// qualifies, held to the final.
import fs from 'node:fs';
import { wpAll } from '../../api/wpml.mjs';
const [, , lg, snapsF, mcF, modelF] = process.argv;
const S = JSON.parse(fs.readFileSync(snapsF, 'utf8')), MC = JSON.parse(fs.readFileSync(mcF, 'utf8')), M = JSON.parse(fs.readFileSync(modelF, 'utf8'));
const mcOf = i => { const o = MC[i]; return o == null ? null : typeof o === 'number' ? o : o.w; };
const rows = [];
S.forEach((s, i) => {
  const mc = mcOf(i); if (mc == null) return;
  const st = s.st || { diff: s.nd - s.unc, tl: (4 - s.qtr) * 900 + s.secs, posH: s.poss === 'ND' ? 1 : -1, ytg: 100 - s.pos, down: s.down, dist: s.dist, toH: s.toND, toA: s.toUNC, spread: s.spread, total: s.totalLine, h2: s.qtr <= 2 ? (s.half2Recv === 'ND' ? 1 : -1) : 0 };
  const y = s.y ?? (s.hf > s.af ? 1 : s.hf < s.af ? 0 : null); if (y == null || s.v == null) return;
  const p = wpAll(M, st);
  rows.push({ g: s.g, i, y, st, mc, ml: p.ml, trees: p.trees, lr: p.lr, mkt: s.v, qtr: s.qtr ?? (st.tl > 2700 ? 1 : st.tl > 1800 ? 2 : st.tl > 900 ? 3 : 4), secs: s.secs, lead: st.diff });
});
const cl = p => Math.min(0.995, Math.max(0.005, p));
const LL = (k, R = rows) => R.reduce((a, r) => a - (r.y ? Math.log(cl(r[k])) : Math.log(1 - cl(r[k]))), 0) / R.length;
const BR = (k, R = rows) => R.reduce((a, r) => a + (r[k] - r.y) ** 2, 0) / R.length;
for (const r of rows) { r.mcml = (r.mc + r.ml) / 2; r.mcmkt = (r.mc + r.mkt) / 2; r.mlmkt = (r.ml + r.mkt) / 2; r.all3 = (r.mc + r.ml + r.mkt) / 3; }
// ---------- stacking: learn how much to trust each forecaster, and how that changes through the game ----------
// Logistic regression on the log-odds of Monte Carlo, ML and the market, each also times "share of the game played".
// Scored out-of-fold: games split into 5 groups, each group predicted by weights fit on the other 4.
const lo = p => Math.log(cl(p) / (1 - cl(p)));
const stackX = r => { const late = 1 - r.st.tl / 3600, a = lo(r.mc), b = lo(r.ml), c = lo(r.mkt); return [1, a, b, c, a * late, b * late, c * late]; };
export function fitLogit(X, y, l2 = 1) { // Newton's method
  const k = X[0].length; let w = new Array(k).fill(0); w[3] = 1;
  for (let it = 0; it < 30; it++) {
    const g = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) { const x = X[i]; let z = 0; for (let j = 0; j < k; j++) z += w[j] * x[j]; const p = 1 / (1 + Math.exp(-z)), q = p * (1 - p);
      for (let j = 0; j < k; j++) { g[j] += (p - y[i]) * x[j]; for (let m = 0; m < k; m++) H[j][m] += q * x[j] * x[m]; } }
    for (let j = 1; j < k; j++) { g[j] += l2 * w[j]; H[j][j] += l2; }
    const M = H.map((r, i) => [...r, g[i]]);
    for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; } }
    const step = M.map((r, i) => r[k] / r[i]); let mx = 0; for (let j = 0; j < k; j++) { w[j] -= step[j]; mx = Math.max(mx, Math.abs(step[j])); } if (mx < 1e-7) break;
  }
  return w;
}
{ const gs = [...new Set(rows.map(r => r.g))], fold = Object.fromEntries(gs.map((g, i) => [g, i % 5]));
  for (let f = 0; f < 5; f++) { const tr = rows.filter(r => fold[r.g] !== f), w = fitLogit(tr.map(stackX), tr.map(r => r.y));
    for (const r of rows) if (fold[r.g] === f) { const x = stackX(r); let z = 0; for (let j = 0; j < x.length; j++) z += w[j] * x[j]; r.stack = 1 / (1 + Math.exp(-z)); } } }
const stackW = fitLogit(rows.map(stackX), rows.map(r => r.y));
const MODELS = [['stack', 'Stacked: learned mix of all three'], ['mc', 'Monte Carlo'], ['ml', 'ML (trees + logistic)'], ['trees', 'ML: trees only'], ['lr', 'ML: logistic only'], ['mkt', lg === 'nfl' ? 'Vegas market' : 'ESPN win probability'],
  ['mcmkt', 'Monte Carlo + market (fair price today)'], ['mlmkt', 'ML + market'], ['mcml', 'Monte Carlo + ML'], ['all3', 'All three averaged']];
// game-level bootstrap for "how sure": share of resamples where ML beats Monte Carlo on log loss
const games = [...new Set(rows.map(r => r.g))], byG = {}; for (const r of rows) (byG[r.g] ||= []).push(r);
// mulberry32: the old (seed * 1103515245 + 12345) overflowed double precision and could cycle through a few hundred values
let seed = 9; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const boot = (a, b, n = 400) => { let w = 0; for (let k = 0; k < n; k++) { let sa = 0, sb = 0; for (let j = 0; j < games.length; j++) for (const r of byG[games[(rnd() * games.length) | 0]]) { sa += -(r.y ? Math.log(cl(r[a])) : Math.log(1 - cl(r[a]))); sb += -(r.y ? Math.log(cl(r[b])) : Math.log(1 - cl(r[b]))); } if (sa < sb) w++; } return +(w / n).toFixed(3); };
const out = { league: lg, plays: rows.length, games: games.length, built: new Date().toISOString(),
  models: MODELS.map(([k, name]) => ({ k, name, ll: +LL(k).toFixed(4), brier: +BR(k).toFixed(4) })),
  stackW: stackW.map(v => +v.toFixed(4)), stackBeatsFair: 0, mlBeatsMc: boot('ml', 'mc'), blendBeatsMkt: boot('mcml', 'mkt'), allBeatsMkt: boot('all3', 'mkt') };
// by phase
const PH = [['Q1', r => r.qtr === 1], ['Q2', r => r.qtr === 2], ['Q3', r => r.qtr === 3], ['Q4, before the last 5 min', r => r.qtr === 4 && r.secs > 300], ['Last 5 min', r => r.qtr === 4 && r.secs <= 300]];
out.phase = PH.map(([name, f]) => { const R = rows.filter(f); return { name, n: R.length, mc: +LL('mc', R).toFixed(4), ml: +LL('ml', R).toFixed(4), mkt: +LL('mkt', R).toFixed(4), mcml: +LL('mcml', R).toFixed(4) }; });
// calibration
out.calib = ['mc', 'ml', 'mkt'].map(k => ({ k, bins: Array.from({ length: 10 }, (_, b) => { const R = rows.filter(r => Math.min(9, Math.floor(r[k] * 10)) === b); return { b, n: R.length, said: R.length ? +(R.reduce((a, r) => a + r[k], 0) / R.length).toFixed(3) : null, won: R.length ? +(R.reduce((a, r) => a + r.y, 0) / R.length).toFixed(3) : null }; }) }));
// when they disagree
out.disagree = [0.05, 0.1, 0.15, 0.2].map(t => { const R = rows.filter(r => Math.abs(r.mc - r.ml) >= t); if (!R.length) return { t, n: 0 };
  const mlCloser = R.filter(r => Math.abs(r.ml - r.y) < Math.abs(r.mc - r.y)).length; return { t, n: R.length, share: +(R.length / rows.length).toFixed(3), mc: +LL('mc', R).toFixed(4), ml: +LL('ml', R).toFixed(4), mkt: +LL('mkt', R).toFixed(4), mlCloser: +(mlCloser / R.length).toFixed(3) }; });
// importance: which inputs the trees use (from the eval file if it's next to the model)
// ---------- bet replay (NFL) ----------
if (lg === 'nfl') {
  const fee = p => 0.0695 * p * (1 - p), askOf = mid => Math.min(0.99, Math.ceil((mid + 0.01) * 100 - 1e-9) / 100);
  const inWin = r => (r.qtr === 3 && r.secs <= 450) || (r.qtr === 4 && r.secs >= 480), q24 = r => r.qtr >= 2;
  const FAIR = { stack: r => [r.stack, 1 - r.stack], mc: r => [r.mcmkt, 1 - r.mcmkt], ml: r => [r.mlmkt, 1 - r.mlmkt], all3: r => [r.all3, 1 - r.all3], mcml: r => [r.mcml, 1 - r.mcml] };
  function replay({ fair, both = false, when = inWin, steady = false }) {
    const bets = [];
    for (const g of games) for (const r of byG[g]) {
      if (!when(r)) continue; let took = null;
      for (const side of [0, 1]) {
        const mid = side ? 1 - r.mkt : r.mkt, cost = askOf(mid) + fee(askOf(mid)), lead = side ? -r.lead : r.lead;
        if (cost < 0.35 || cost > 0.85) continue;
        if (steady && (cost < 0.65 || lead < 4)) continue;
        const bar = steady ? 0 : cost >= 0.6 ? 0.025 : 0.03, ok = k => FAIR[k](r)[side] - cost >= bar;
        // the live sanity check: a model more than 10 points from the market is assumed to be missing something
        const near = k => steady || Math.abs((side ? 1 - r[k] : r[k]) - mid) <= 0.10, used = both || fair === 'all3' || fair === 'mcml' || fair === 'stack' ? ['mc', 'ml'] : [fair];
        if (!used.every(near)) continue;
        if (both ? (ok('mc') && ok('ml')) : ok(fair)) { took = { y: side ? 1 - r.y : r.y, cost }; break; }
      }
      if (took) { bets.push({ g, ...took }); break; }
    }
    const n = bets.length, st = bets.reduce((a, b) => a + b.cost, 0), pl = bets.reduce((a, b) => a + b.y - b.cost, 0);
    // bootstrap the return by game
    const R = []; for (let k = 0; k < 2000; k++) { let p = 0, c = 0; for (let j = 0; j < n; j++) { const b = bets[(rnd() * n) | 0]; p += b.y - b.cost; c += b.cost; } R.push(c ? p / c : 0); } R.sort((a, b) => a - b);
    return { n, hit: n ? +(bets.reduce((a, b) => a + b.y, 0) / n).toFixed(3) : null, roi: n ? +(pl / st).toFixed(3) : null, lo: n ? +R[100].toFixed(3) : null, hi: n ? +R[1899].toFixed(3) : null };
  }
  out.bets = [
    ['Monte Carlo + market (today\'s rule)', { fair: 'mc' }], ['ML + market', { fair: 'ml' }], ['Monte Carlo + ML + market', { fair: 'all3' }], ['Stacked mix', { fair: 'stack' }], ['Both must agree (MC and ML)', { both: true }],
    ['Steady rule, Monte Carlo', { fair: 'mc', steady: true, when: q24 }], ['Steady rule, ML', { fair: 'ml', steady: true, when: q24 }], ['Steady rule, both must agree', { both: true, steady: true, when: q24 }], ['Steady rule, stacked mix', { fair: 'stack', steady: true, when: q24 }], ['Steady rule, three-way fair', { fair: 'all3', steady: true, when: q24 }],
  ].map(([name, o]) => ({ name, ...replay(o) }));
}
out.stackBeatsFair = boot('stack', 'mcmkt');
const dest = new URL(`../../api/mlcompare_${lg}.json`, import.meta.url).pathname; fs.writeFileSync(dest, JSON.stringify(out));
console.log(`${lg}: ${rows.length} plays, ${games.length} games`);
for (const m of out.models) console.log(m.name.padEnd(42), 'log loss', m.ll, 'brier', m.brier);
console.log('stack weights [1, mc, ml, mkt, mc*late, ml*late, mkt*late]', out.stackW.join(' '), '| stack beats today\'s fair price in', pct(out.stackBeatsFair), 'of resamples');
console.log('ML beats Monte Carlo in', pct(out.mlBeatsMc), 'of game resamples; MC+ML beats market in', pct(out.blendBeatsMkt), '; all three beat market in', pct(out.allBeatsMkt));
for (const p of out.phase) console.log(p.name.padEnd(26), 'n', p.n, 'mc', p.mc, 'ml', p.ml, 'mkt', p.mkt, 'mc+ml', p.mcml);
for (const d of out.disagree) console.log('disagree by', d.t, JSON.stringify(d));
if (out.bets) for (const b of out.bets) console.log('bets', b.name.padEnd(38), JSON.stringify(b));
function pct(v) { return Math.round(v * 100) + '%'; }
