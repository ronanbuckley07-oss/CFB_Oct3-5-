// Other algorithms, tested the same walk-forward way as the live models, for the "Model zoo" on /ml.
// Also writes public/mllab.json: what the in-browser Model lab needs to refit and backtest the poll model itself.
//   node tools/ap/zoo.mjs games.json
import fs from 'node:fs';
import { G, FEATS, PRIOR_SHRINK, SIGMA, HFA, Phi, gbmFit, gbmPredict, ridgeValue, ratings, rebuildPolls, teamsOf, features, samplesFor, stats, fitStats, predictValues, rankFrom, gameLine } from '../../api/apmodel.mjs';
const games = JSON.parse(fs.readFileSync(process.argv[2] || 'games.json', 'utf8'));
const seasons = [...new Set(games.map(g => g[G.season]))].sort();
const t0 = Date.now(), log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);
const priors = {};
for (const s of seasons) { const R = ratings(games.filter(g => g[G.season] === s), { prior: priors[s] || {} }); priors[s + 1] = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v * PRIOR_SHRINK])); }
const S = {}; for (const s of seasons) S[s] = samplesFor(games, s, { prior: priors[s] || {} });
const tests = {};
for (const s of seasons) {
  if (s < 2014) continue;
  const polls = rebuildPolls(games, s), teams = teamsOf(games, s), ws = Object.keys(polls).map(Number).sort((a, b) => a - b); tests[s] = [];
  for (let i = 0; i + 1 < ws.length; i++) {
    const w = ws[i], nx = ws[i + 1]; if (nx !== w + 1 || polls[nx].start.slice(5) >= '10-27') continue;
    const wg = games.filter(g => g[G.season] === s && g[G.week] === w); if (wg.filter(g => g[G.hp] != null).length < 0.9 * wg.length) continue;
    const R = ratings(games.filter(g => g[G.season] === s && g[G.week] <= w), { prior: priors[s] || {} });
    tests[s].push({ s, w, X: features(games, s, w, polls[w].poll, R, teams), P: polls[w].poll, act: Object.fromEntries(Object.entries(polls[nx].poll).filter(([id]) => polls[nx].observed.has(id))) });
  }
}
const train = s => seasons.filter(t => t < s && t !== 2020);
function score(predict) { // predict(T, s) -> {id: value}
  let n = 0, abs = 0, top = 0; const bySeason = {};
  for (const s of Object.keys(tests).map(Number)) { let sn = 0, sa = 0;
    for (const T of tests[s]) { const pr = rankFrom(predict(T, s)), tp = new Set(Object.entries(pr).filter(([, r]) => r <= 25).map(([id]) => id));
      for (const [id, r] of Object.entries(T.act)) { const e = Math.min(15, Math.abs((pr[id] ?? 40) - r)); n++; abs += e; sn++; sa += e; top += tp.has(id); } }
    bySeason[s] = +(sa / sn).toFixed(3); }
  return { avgMiss: +(abs / n).toFixed(3), top25: +(top / n).toFixed(3), bySeason };
}
const out = { built: new Date().toISOString(), poll: [], games: [] };

// ---------- poll: baselines, ridge (live), ridge without interaction terms, gradient-boosted trees, average ----------
const ridgeBy = {}; for (const s of Object.keys(tests).map(Number)) { const rows = train(s).flatMap(t => S[t]); ridgeBy[s] = fitStats({ R: stats(rows.filter(r => r.ranked)), U: stats(rows.filter(r => !r.ranked)) }); }
const ridge = (T, s) => Object.fromEntries(Object.entries(T.X).map(([id, x]) => [id, ridgeValue(ridgeBy[s], x, !!T.P[id])]));
const MAIN = ['1', 'v0', 'W', 'L', 'B', 'wins', 'losses', 'unbeaten', 'p4', 'rating'].map(f => FEATS.indexOf(f));
const mainBy = {}; for (const s of Object.keys(tests).map(Number)) { const rows = train(s).flatMap(t => S[t]).map(r => ({ ...r, x: r.x.map((v, i) => (MAIN.includes(i) ? v : 0)) })); mainBy[s] = fitStats({ R: stats(rows.filter(r => r.ranked)), U: stats(rows.filter(r => !r.ranked)) }); }
const mainOnly = (T, s) => predictValues({ R: mainBy[s].R, U: mainBy[s].U }, Object.fromEntries(Object.entries(T.X).map(([id, x]) => [id, x.map((v, i) => (MAIN.includes(i) ? v : 0))])), T.P);

// Gradient-boosted regression trees: gbmFit / gbmPredict in api/apmodel.mjs (the same code that runs live)
const gbmBy = {}; for (const s of Object.keys(tests).map(Number)) { gbmBy[s] = gbmFit(train(s).flatMap(t => S[t])); log('gbm fit for', s); }
const gbm = (T, s) => Object.fromEntries(Object.entries(T.X).map(([id, x]) => [id, gbmPredict(gbmBy[s], x, T.P[id] ? 1 : 0)]));
const avg2 = (T, s) => { const a = ridge(T, s), b = gbm(T, s); return Object.fromEntries(Object.keys(a).map(id => [id, (a[id] + b[id]) / 2])); };
const unchanged = T => Object.fromEntries(Object.keys(T.X).map(id => [id, T.P[id] ? 26 - T.P[id] : -1]));
const drop8 = T => Object.fromEntries(Object.keys(T.X).map(id => [id, T.P[id] ? 26 - T.P[id] - (T.X[id][FEATS.indexOf('L')] ? 8 : 0) : -1]));
for (const [name, f, what, live] of [
  ['Poll unchanged', unchanged, 'Baseline: next week\'s poll = this week\'s.'],
  ['Losers drop 8', drop8, 'Baseline: every loser falls 8 spots, everyone else re-sorted.'],
  ['Linear, no interactions', mainOnly, 'Ridge on the 9 main inputs only (rank, result, record, conference, rating), no "lost × opponent rank" style terms.'],
  ['Ridge with interactions', ridge, 'Ridge on all 22 inputs, including interaction terms. The explainable half of the live model.'],
  ['Gradient-boosted trees', gbm, '160 depth-3 trees, learning rate 0.08: finds its own interactions and thresholds.'],
  ['Average of ridge and trees', avg2, 'A two-model ensemble: the mean of both scores. The live model.', true],
]) { const r = score(f); out.poll.push({ name, what, live: !!live, ...r }); log('poll', name, r.avgMiss); }

// ---------- games: who wins, 2014-2025 FBS vs FBS, everything from games before that week ----------
const ll = (p, y) => { p = Math.min(0.995, Math.max(0.005, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
const gl = []; // {s, w, m(ratings margin), y, elo diff}
// Elo: 1500 start, regress 1/3 to the mean each offseason, 55-point home edge, margin-of-victory multiplier (FiveThirtyEight style)
const elo = {}; let lastS = null; const E = id => elo[id] ?? 1500;
for (const s of seasons) {
  if (lastS != null) for (const k of Object.keys(elo)) elo[k] = 1500 + (elo[k] - 1500) * (2 / 3); lastS = s;
  const SG = games.filter(g => g[G.season] === s).sort((a, b) => a[G.week] - b[G.week]);
  for (let w = 1; w <= 16; w++) {
    const wk = SG.filter(g => g[G.week] === w && g[G.hp] != null && g[G.hp] !== g[G.ap]);
    const R = s >= 2014 && s <= 2025 && w <= 15 ? ratings(SG.filter(g => g[G.week] < w), { prior: priors[s] || {} }) : null;
    for (const g of wk) {
      const key = (id, div) => (div === 'fbs' ? String(id) : 'FCS'), h = key(g[G.hid], g[G.hdiv]), a = key(g[G.aid], g[G.adiv]), hfa = g[G.neutral] ? 0 : 55, d = E(h) - E(a) + hfa;
      if (R && g[G.hdiv] === 'fbs' && g[G.adiv] === 'fbs') gl.push({ s, w, m: gameLine(R, g).margin, eloP: 1 / (1 + 10 ** (-d / 400)), y: g[G.hp] > g[G.ap] ? 1 : 0 });
      const y = g[G.hp] > g[G.ap] ? 1 : 0, mv = Math.abs(g[G.hp] - g[G.ap]), mult = Math.log(mv + 1) * 2.2 / ((y ? d : -d) * 0.001 + 2.2), p = 1 / (1 + 10 ** (-d / 400)), k = 25 * mult * (y - p);
      elo[h] = E(h) + k; elo[a] = E(a) - k;
    }
  }
}
const gScore = (f, name, what, live) => { const L = gl.reduce((a, x) => a + ll(f(x), x.y), 0) / gl.length, acc = gl.filter(x => (f(x) > 0.5) === !!x.y).length / gl.length; out.games.push({ name, what, live: !!live, ll: +L.toFixed(4), acc: +acc.toFixed(3) }); log('games', name, L.toFixed(4), acc.toFixed(3)); };
gScore(() => 0.5, 'Coin flip', 'Baseline: 50/50 every game.');
gScore(() => Phi(HFA / SIGMA), 'Home team', 'Baseline: the home team, at its historical rate.');
gScore(x => x.eloP, 'Elo', 'Classic Elo: 1500 start, a third regressed each offseason, 55-point home edge, margin multiplier.');
gScore(x => Phi(x.m / SIGMA), 'Ridge ratings (live)', 'Point ratings fit to every margin, last season as a prior worth 3 games.', true);
gScore(x => (Phi(x.m / SIGMA) + x.eloP) / 2, 'Average of ratings and Elo', 'A two-model ensemble.');
out.gamesN = gl.length;

fs.writeFileSync(new URL('../../api/zoodata.json', import.meta.url).pathname, JSON.stringify(out));
// ---------- the Model lab's data: per-season sufficient statistics + every test week's candidate teams ----------
const r4 = v => +v.toFixed(4), sstat = rows => { const t = stats(rows); return { A: t.A.map(r => r.map(r4)), b: t.b.map(r4), yy: r4(t.yy), n: t.n }; };
const lab = { feats: FEATS, seasons: {}, weeks: [] };
for (const s of seasons) if (S[s].length) lab.seasons[s] = { R: sstat(S[s].filter(r => r.ranked)), U: sstat(S[s].filter(r => !r.ranked)) };
for (const s of Object.keys(tests).map(Number)) for (const T of tests[s]) {
  // candidates: ranked going in, ranked coming out, or the live model's top 45 that week (everyone else can't reach the top 25)
  const pr = rankFrom(ridge(T, s)), ids = Object.keys(T.X).filter(id => T.P[id] || T.act[id] || pr[id] <= 45);
  lab.weeks.push({ s, w: T.w, t: ids.map(id => [T.P[id] ? 1 : 0, T.act[id] || 0, ...T.X[id].map(v => +v.toFixed(3))]) });
}
const dest = new URL('../../public/mllab.json', import.meta.url).pathname; fs.writeFileSync(dest, JSON.stringify(lab));
log('wrote zoodata.json and', dest, (fs.statSync(dest).size / 1024).toFixed(0) + ' KB');
