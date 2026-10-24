// Walk-forward backtest of the AP poll projection: for each season, fit only on earlier seasons, then project every
// week's next poll from the current poll and that week's results. Compared with two simple baselines.
//   node tools/ap/backtest.mjs games.json
import fs from 'node:fs';
import { G, stats, addStats, fitStats, ratings, rebuildPolls, teamsOf, features, fit, samplesFor, predictValues, rankFrom } from '../../api/apmodel.mjs';
const games = JSON.parse(fs.readFileSync(process.argv[2] || 'games.json', 'utf8'));
const seasons = [...new Set(games.map(g => g[G.season]))].sort();
const priors = {}; // season -> prior ratings (last season's final ratings, shrunk)
for (const s of seasons) { const p = priors[s] || {}; const R = ratings(games.filter(g => g[G.season] === s), { prior: p });
  priors[s + 1] = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v * 0.6])); }
const S = {}; for (const s of seasons) S[s] = samplesFor(games, s, { prior: priors[s] || {} });
const val = r => (r ? 26 - r : 0);
const agg = () => ({ n: 0, abs: 0, w2: 0, exact: 0, inTop: 0, top: 0 });
const add = (a, pred, actual, observed) => {
  const predTop = new Set(Object.entries(pred).filter(([, r]) => r <= 25).map(([id]) => id));
  for (const [id, r] of Object.entries(actual)) { if (!observed.has(id)) continue; const p = pred[id] ?? 40;
    a.n++; a.abs += Math.min(Math.abs(p - r), 15); a.w2 += Math.abs(p - r) <= 2; a.exact += p === r; a.top++; a.inTop += predTop.has(id); }
};
const fmt = a => `teams=${a.n} avgMiss=${(a.abs / a.n).toFixed(2)} spots  within2=${(a.w2 / a.n * 100).toFixed(0)}%  exact=${(a.exact / a.n * 100).toFixed(0)}%  top25 match=${(a.inTop / a.top * 100).toFixed(1)}%`;
const LW = +(process.env.LIVE_WEIGHT ?? 1);
const KC = +(process.env.CARRY ?? 0); // share of last week's miss (actual - projected value) carried into this week // weight on this season's earlier weeks (the live learning)
const latest = []; // the newest season, week by week: projected vs actual top 25
const tot = { model: agg(), same: agg(), simple: agg(), learn: agg() }, bySeason = {}, byWeek = {};
for (const s of seasons) {
  if (s < 2014) continue;
  const train = seasons.filter(t => t < s).flatMap(t => S[t]); if (train.length < 500) continue;
  const model = fit(train);
  const polls = rebuildPolls(games, s), teams = teamsOf(games, s), weeks = Object.keys(polls).map(Number).sort((a, b) => a - b);
  const A = { model: agg(), same: agg(), simple: agg(), learn: agg() };
  let carry = {}; // team -> last week's miss in rank-value units
  const base = { R: stats(train.filter(x => x.ranked)), U: stats(train.filter(x => !x.ranked)) };
  for (let i = 0; i + 1 < weeks.length; i++) {
    const w = weeks[i], nx = weeks[i + 1]; if (nx !== w + 1 || polls[nx].start.slice(5) >= '10-27') continue;
    const R = ratings(games.filter(g => g[G.season] === s && g[G.week] <= w), { prior: priors[s] || {} });
    const X = features(games, s, w, polls[w].poll, R, teams), P = polls[w].poll;
    const pred = rankFrom(predictValues(model, X, P));
    const cur = S[s].filter(x => x.week < w), learned = cur.length ? fitStats({ R: addStats(base.R, stats(cur.filter(x => x.ranked)), LW), U: addStats(base.U, stats(cur.filter(x => !x.ranked)), LW) }) : model;
    const vals = predictValues(learned, X, P), vC = Object.fromEntries(Object.entries(vals).map(([id, v]) => [id, v + KC * (carry[id] || 0)]));
    const predL = rankFrom(vC);
    // what was missed this week, for teams seen in the next poll (ranked) or surely unranked
    const nextC = {}; for (const id of Object.keys(vals)) { const r1 = polls[nx].poll[id]; if (r1 && !polls[nx].observed.has(id)) continue; const y = r1 ? 26 - r1 : 0; if (!r1 && vals[id] < 0) continue; nextC[id] = y - vals[id]; }
    carry = nextC;
    // baseline 1: nothing changes. baseline 2: losers drop 8 spots, everyone re-sorted
    const same = { ...P };
    const simple = rankFrom(Object.fromEntries(Object.keys(P).map(id => [id, val(P[id]) - (X[id][3] ? 8 : 0)])));
    const act = Object.fromEntries(Object.entries(polls[nx].poll).filter(([id]) => polls[nx].observed.has(id)));
    for (const [k, p] of [['learn', predL], ['model', pred], ['same', same], ['simple', simple]]) { add(A[k], p, act, polls[nx].observed); add(tot[k], p, act, polls[nx].observed); }
    const bw = byWeek[w] || (byWeek[w] = agg()); add(bw, pred, act, polls[nx].observed);
    if (s === seasons[seasons.length - 1]) { const a = agg(); add(a, predL, act, polls[nx].observed);
      latest.push({ week: nx, avgMiss: +(a.abs / a.n).toFixed(2), top25: +(a.inTop / a.top).toFixed(3), n: a.n,
        rows: Object.entries(act).sort((x, y) => x[1] - y[1]).map(([id, r]) => ({ id, name: teams[id] ? teams[id].name : id, actual: r, proj: predL[id] ?? null, prev: P[id] || null })) }); }
  }
  bySeason[s] = A; console.log(s, 'model:', fmt(A.model), '| learning:', (A.learn.abs / A.learn.n).toFixed(2), '| unchanged:', (A.same.abs / A.same.n).toFixed(2), '| losers-drop-8:', (A.simple.abs / A.simple.n).toFixed(2));
}
console.log('\nALL  model    ', fmt(tot.model)); console.log('ALL  +learning', fmt(tot.learn)); console.log('ALL  unchanged', fmt(tot.same)); console.log('ALL  drop-8   ', fmt(tot.simple));
for (const [w, a] of Object.entries(byWeek)) console.log(' after week', w, fmt(a));
const full = fit(seasons.flatMap(t => S[t]));
console.log('\nweights (ranked):', Object.fromEntries((await import('../../api/apmodel.mjs')).FEATS.map((f, i) => [f, +full.R[i].toFixed(2)])));
console.log('weights (unranked):', Object.fromEntries((await import('../../api/apmodel.mjs')).FEATS.map((f, i) => [f, +full.U[i].toFixed(2)])));
console.log('sd', full.sdR.toFixed(2), full.sdU.toFixed(2));
const sm = a => ({ n: a.n, avgMiss: +(a.abs / a.n).toFixed(2), within2: +(a.w2 / a.n).toFixed(3), exact: +(a.exact / a.n).toFixed(3), top25: +(a.inTop / a.top).toFixed(3) });
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ seasons: [Math.min(...Object.keys(bySeason).map(Number)), Math.max(...Object.keys(bySeason).map(Number))],
  all: { model: sm(tot.learn), unchanged: sm(tot.same), drop8: sm(tot.simple) }, bySeason: Object.fromEntries(Object.entries(bySeason).map(([k, a]) => [k, { model: sm(a.learn), unchanged: sm(a.same) }])),
  byWeek: Object.fromEntries(Object.entries(byWeek).map(([k, a]) => [k, sm(a)])), latest }));
