// The experiments behind the "How it works" page (/ml). Everything here is measured, walk-forward (a season is only ever
// predicted by a model fit on earlier seasons), and written to api/mldata.json.
//   node tools/ap/ml.mjs games.json
// Poll model: feature importance, ablation (remove a group of inputs, refit, re-test), regularization curve, learning
// curve (how much history it needs), and the miss distribution.
// Team ratings: calibration of win probabilities, accuracy by week of the season, the prior's weight, the spread SD,
// and how the rating solver converges.
import fs from 'node:fs';
import { G, FEATS, PRIOR_SHRINK, SIGMA, HFA, Phi, ratings, rebuildPolls, teamsOf, features, samplesFor, stats, fitStats, predictValues, rankFrom, gameLine } from '../../api/apmodel.mjs';
const games = JSON.parse(fs.readFileSync(process.argv[2] || 'games.json', 'utf8'));
const seasons = [...new Set(games.map(g => g[G.season]))].sort();
const t0 = Date.now(), log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);

// ---------- shared: priors, training rows, and every test week, computed once ----------
const priors = {};
for (const s of seasons) { const R = ratings(games.filter(g => g[G.season] === s), { prior: priors[s] || {} }); priors[s + 1] = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v * PRIOR_SHRINK])); }
const S = {}; for (const s of seasons) S[s] = samplesFor(games, s, { prior: priors[s] || {} });
const tests = {}; // season -> [{ X, P, act, observed }]
for (const s of seasons) {
  if (s < 2014) continue;
  const polls = rebuildPolls(games, s), teams = teamsOf(games, s), ws = Object.keys(polls).map(Number).sort((a, b) => a - b); tests[s] = [];
  for (let i = 0; i + 1 < ws.length; i++) {
    const w = ws[i], nx = ws[i + 1]; if (nx !== w + 1 || polls[nx].start.slice(5) >= '10-27') continue;
    const wg = games.filter(g => g[G.season] === s && g[G.week] === w); if (wg.filter(g => g[G.hp] != null).length < 0.9 * wg.length) continue;
    const R = ratings(games.filter(g => g[G.season] === s && g[G.week] <= w), { prior: priors[s] || {} });
    const act = Object.fromEntries(Object.entries(polls[nx].poll).filter(([id]) => polls[nx].observed.has(id)));
    tests[s].push({ w, X: features(games, s, w, polls[w].poll, R, teams), P: polls[w].poll, act });
  }
}
log('prepared', Object.values(S).reduce((a, x) => a + x.length, 0), 'training rows,', Object.values(tests).reduce((a, x) => a + x.length, 0), 'test weeks');

const mask = (rows, drop) => (drop.length ? rows.map(r => ({ ...r, x: r.x.map((v, i) => (drop.includes(i) ? 0 : v)) })) : rows);
const fitRows = (rows, lambda) => fitStats({ R: stats(rows.filter(r => r.ranked)), U: stats(rows.filter(r => !r.ranked)) }, lambda);
// Walk-forward: for each test season, fit on `train(s)` seasons, predict every week. Returns avg miss / top-25 / misses.
function evaluate({ drop = [], lambda = 2, train = s => seasons.filter(t => t < s && t !== 2020), testSeasons = Object.keys(tests).map(Number), keep = false } = {}) {
  let n = 0, abs = 0, inTop = 0, w2 = 0; const misses = [];
  for (const s of testSeasons) {
    const rows = train(s).flatMap(t => S[t]); if (rows.length < 300) continue;
    const model = fitRows(mask(rows, drop), lambda);
    for (const T of tests[s]) {
      const X = drop.length ? Object.fromEntries(Object.entries(T.X).map(([id, x]) => [id, x.map((v, i) => (drop.includes(i) ? 0 : v))])) : T.X;
      const pred = rankFrom(predictValues(model, X, T.P)), top = new Set(Object.entries(pred).filter(([, r]) => r <= 25).map(([id]) => id));
      for (const [id, r] of Object.entries(T.act)) { const p = pred[id] ?? 40, e = p - r; n++; abs += Math.min(15, Math.abs(e)); w2 += Math.abs(e) <= 2; inTop += top.has(id); if (keep) misses.push(Math.max(-15, Math.min(15, e))); }
    }
  }
  return { n, avgMiss: +(abs / n).toFixed(3), within2: +(w2 / n).toFixed(3), top25: +(inTop / n).toFixed(3), misses };
}

const out = { built: new Date().toISOString(), poll: {}, ratings: {} };

// ---------- poll model ----------
const base = evaluate({ keep: true });
out.poll.base = { avgMiss: base.avgMiss, within2: base.within2, top25: base.top25, n: base.n };
// miss distribution: projected spot minus actual spot
const hist = {}; for (const e of base.misses) hist[e] = (hist[e] || 0) + 1;
out.poll.missHist = Array.from({ length: 31 }, (_, i) => ({ e: i - 15, n: hist[i - 15] || 0 }));
log('base', base.avgMiss);

// feature importance: coefficient x the feature's spread in the data (what one typical swing of that input is worth)
const allRows = seasons.filter(s => s !== 2020).flatMap(s => S[s]);
const full = fitRows(allRows, 2);
const sd = set => FEATS.map((_, i) => { const v = set.map(r => r.x[i]), m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); });
const sdR = sd(allRows.filter(r => r.ranked)), sdU = sd(allRows.filter(r => !r.ranked));
out.poll.weights = FEATS.map((f, i) => ({ f, R: +full.R[i].toFixed(3), U: +full.U[i].toFixed(3), sdR: +sdR[i].toFixed(3), sdU: +sdU[i].toFixed(3), impR: +(full.R[i] * sdR[i]).toFixed(3), impU: +(full.U[i] * sdU[i]).toFixed(3) }));
out.poll.rows = allRows.length; out.poll.rowsRanked = allRows.filter(r => r.ranked).length;

// ablation: remove one group of inputs at a time
const ix = names => names.map(n => FEATS.indexOf(n)).filter(i => i >= 0);
const GROUPS = [
  ['Last week\'s rank', ['v0', 'v0sq', 'L*v0', 'B*v0', 'W*v0'], 'Where the team started. Without it the model has to rebuild the whole poll from records.'],
  ['Won, lost or bye', ['W', 'L', 'B'], 'This week\'s result on its own.'],
  ['Who they played', ['W*oppv', 'L*oppv', 'L*oppUnr', 'W*fcs', 'L*fcs'], 'Opponent rank, unranked opponent, FCS opponent.'],
  ['Margin', ['W*mov', 'L*mov'], 'How big the win or loss was.'],
  ['Home or road', ['W*road', 'L*home'], 'Road wins and home losses.'],
  ['Season record', ['wins', 'losses', 'unbeaten'], 'Wins, losses, still unbeaten.'],
  ['Power conference', ['p4'], 'SEC, Big Ten, Big 12, ACC, Notre Dame.'],
  ['Team strength rating', ['rating'], 'Points per game better than average, from scores.'],
];
out.poll.ablation = GROUPS.map(([name, feats, why]) => { const r = evaluate({ drop: ix(feats) }); log('ablation', name, r.avgMiss); return { name, feats, why, avgMiss: r.avgMiss, top25: r.top25, delta: +(r.avgMiss - base.avgMiss).toFixed(3) }; });

// regularization: how hard the weights are pulled toward zero
out.poll.lambda = [0, 0.1, 1, 2, 5, 20, 100, 500, 2000, 10000].map(l => { const r = evaluate({ lambda: l }); log('lambda', l, r.avgMiss); return { lambda: l, avgMiss: r.avgMiss, top25: r.top25 }; });

// learning curve: only the most recent k seasons of history, tested on 2019 onward
const recent = Object.keys(tests).map(Number).filter(s => s >= 2019);
out.poll.learning = [1, 2, 3, 5, 7, 9].map(k => { const r = evaluate({ train: s => seasons.filter(t => t < s && t !== 2020).slice(-k), testSeasons: recent }); log('seasons', k, r.avgMiss); return { seasons: k, rows: k * 1000, avgMiss: r.avgMiss, top25: r.top25 }; });
out.poll.learningAll = evaluate({ testSeasons: recent }).avgMiss;

// ---------- team ratings and win probabilities ----------
// every FBS-vs-FBS game 2014-2025, predicted from games before that week
const preds = [];
for (const s of seasons) { if (s < 2014 || s > 2025) continue; const SG = games.filter(g => g[G.season] === s);
  for (let w = 1; w <= 15; w++) { const R = ratings(SG.filter(g => g[G.week] < w), { prior: priors[s] || {} });
    for (const g of SG) if (g[G.week] === w && g[G.hp] != null && g[G.hp] !== g[G.ap] && g[G.hdiv] === 'fbs' && g[G.adiv] === 'fbs') preds.push({ s, w, m: gameLine(R, g).margin, y: g[G.hp] > g[G.ap] ? 1 : 0, mg: g[G.hp] - g[G.ap] }); } }
const ll = (p, y) => { p = Math.min(0.995, Math.max(0.005, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
// calibration: favorite's probability in 10 bins vs how often the favorite won
const bins = Array.from({ length: 10 }, (_, i) => ({ lo: 0.5 + i * 0.05, hi: 0.55 + i * 0.05, n: 0, p: 0, won: 0 }));
for (const x of preds) { const p = Phi(x.m / SIGMA), fp = Math.max(p, 1 - p), fy = p >= 0.5 ? x.y : 1 - x.y, b = bins[Math.min(9, Math.floor((fp - 0.5) / 0.05))]; b.n++; b.p += fp; b.won += fy; }
out.ratings.calibration = bins.map(b => ({ lo: +b.lo.toFixed(2), hi: +b.hi.toFixed(2), n: b.n, said: b.n ? +(b.p / b.n).toFixed(3) : null, won: b.n ? +(b.won / b.n).toFixed(3) : null }));
out.ratings.games = preds.length;
out.ratings.accuracy = +(preds.filter(x => (x.m > 0) === !!x.y).length / preds.length).toFixed(3);
out.ratings.logloss = +(preds.reduce((a, x) => a + ll(Phi(x.m / SIGMA), x.y), 0) / preds.length).toFixed(4);
out.ratings.coinLogloss = +Math.log(2).toFixed(4);
out.ratings.homeOnly = +(preds.reduce((a, x) => a + ll(Phi(HFA / SIGMA), x.y), 0) / preds.length).toFixed(4);
out.ratings.mae = +(preds.reduce((a, x) => a + Math.abs(x.mg - x.m), 0) / preds.length).toFixed(2);
// by week: early weeks lean on last season (the prior), later weeks on this season's games
out.ratings.byWeek = Array.from({ length: 14 }, (_, i) => i + 1).map(w => { const X = preds.filter(x => x.w === w); return { w, n: X.length, acc: X.length ? +(X.filter(x => (x.m > 0) === !!x.y).length / X.length).toFixed(3) : null, ll: X.length ? +(X.reduce((a, x) => a + ll(Phi(x.m / SIGMA), x.y), 0) / X.length).toFixed(4) : null }; });
// spread SD: how sure to be about a given rating gap
out.ratings.sigma = [9, 10, 11, 12, 12.5, 13, 14, 15, 17, 20].map(sg => ({ sigma: sg, ll: +(preds.reduce((a, x) => a + ll(Phi(x.m / sg), x.y), 0) / preds.length).toFixed(4) }));
log('ratings', out.ratings.accuracy, out.ratings.logloss);
// the prior's weight: how many games' worth of last season each team starts with (2018-2025, weeks 1-14)
out.ratings.priorWeight = [0, 1, 3, 6, 10, 20, 40].map(pw => {
  const pr = {}; let n = 0, L = 0, hit = 0;
  for (const s of seasons) { const SG = games.filter(g => g[G.season] === s);
    if (s >= 2018 && s <= 2025) for (let w = 1; w <= 14; w++) { const R = ratings(SG.filter(g => g[G.week] < w), { prior: pr[s] || {}, priorWeight: pw });
      for (const g of SG) if (g[G.week] === w && g[G.hp] != null && g[G.hp] !== g[G.ap] && g[G.hdiv] === 'fbs' && g[G.adiv] === 'fbs') { const m = gameLine(R, g).margin, y = g[G.hp] > g[G.ap] ? 1 : 0; n++; L += ll(Phi(m / SIGMA), y); hit += (m > 0) === !!y; } }
    const R = ratings(SG, { prior: pr[s] || {}, priorWeight: pw }); pr[s + 1] = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v * PRIOR_SHRINK])); }
  log('priorWeight', pw, (L / n).toFixed(4)); return { pw, ll: +(L / n).toFixed(4), acc: +(hit / n).toFixed(3) };
});
// solver convergence on the latest full season: largest rating change per pass
{ const s = 2025, SG = games.filter(g => g[G.season] === s), steps = [];
  let prev = null; for (const it of [1, 2, 3, 5, 8, 12, 20, 30, 45, 60]) { const R = ratings(SG, { prior: priors[s] || {}, iters: it }); if (prev) { let mx = 0; for (const k of Object.keys(R)) mx = Math.max(mx, Math.abs(R[k] - (prev[k] ?? 0))); steps.push({ it, change: +mx.toFixed(4) }); } prev = R; }
  out.ratings.converge = steps; }

const dest = new URL('../../api/mldata.json', import.meta.url).pathname;
fs.writeFileSync(dest, JSON.stringify(out));
log('wrote', dest, (fs.statSync(dest).size / 1024).toFixed(0) + ' KB');
