// AP poll projection and season simulation. Pure functions shared by the server (api/ap.mjs) and the backtest
// (tools/ap/backtest.mjs), so what gets backtested is exactly what runs live.
//
// Games are compact rows: [season, week, date, homeId, home, homeConf, homeDiv, awayId, away, awayConf, awayDiv,
//                          homePts|null, awayPts|null, neutral, homeRank|null, awayRank|null, gameId]
export const G = { season: 0, week: 1, date: 2, hid: 3, home: 4, hconf: 5, hdiv: 6, aid: 7, away: 8, aconf: 9, adiv: 10, hp: 11, ap: 12, neutral: 13, hr: 14, ar: 15, id: 16 };
export const P4 = new Set(['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12']);
export const p4Of = (conf, season, name) => (P4.has(conf) && !(conf === 'Pac-12' && season >= 2024)) || name === 'Notre Dame';
const val = r => (r ? 26 - r : 0); // #1 = 25 ... #25 = 1, unranked = 0

// ---------- team ratings: points-per-game margin, ridge-regressed toward a prior ----------
// Every FBS team gets a rating r so that a game's expected margin is r_home - r_away + HFA (0 on a neutral field).
// FCS opponents share one rating. The prior (last season's rating, shrunk) keeps September from being noise.
// Backtested 2014-2025 (tools/ap/calib_games.mjs): ratings from earlier games pick 72.5% of FBS winners; a 12.5-point
// spread SD gives the best-calibrated win probabilities, with last season's ratings x0.9 as the prior, worth 3 games (tools/ap/ml.mjs: 3 beat 0, 1, 6, 10, 20, 40).
export const HFA = 2.5, SIGMA = 12.5, FCS = 'FCS', PRIOR_SHRINK = 0.9;
export function ratings(games, { prior = {}, priorWeight = 3, iters = 60, cap = 28 } = {}) {
  const done = games.filter(g => g[G.hp] != null && g[G.ap] != null);
  const key = (id, div) => (div === 'fbs' ? String(id) : FCS);
  const R = {}, n = {};
  for (const g of done) for (const [id, div] of [[g[G.hid], g[G.hdiv]], [g[G.aid], g[G.adiv]]]) { const k = key(id, div); R[k] = prior[k] ?? (k === FCS ? -22 : 0); n[k] = (n[k] || 0) + 1; }
  for (const k of Object.keys(prior)) if (R[k] == null) R[k] = prior[k];
  // Gauss-Seidel on: sum over games of (margin - (r_i - r_j + h)) = priorWeight * (r_i - prior_i)
  for (let it = 0; it < iters; it++) {
    const num = {}, den = {};
    for (const g of done) {
      const h = key(g[G.hid], g[G.hdiv]), a = key(g[G.aid], g[G.adiv]), hfa = g[G.neutral] ? 0 : HFA;
      const m = Math.max(-cap, Math.min(cap, g[G.hp] - g[G.ap]));
      num[h] = (num[h] || 0) + m - hfa + R[a]; den[h] = (den[h] || 0) + 1;
      num[a] = (num[a] || 0) - m + hfa + R[h]; den[a] = (den[a] || 0) + 1;
    }
    // FCS opponents share one rating, estimated from their games like a team's (it used to sit at last season's value x0.9
    // and shrink toward zero year after year)
    for (const k of Object.keys(num)) { const p = k === FCS ? (prior[k] ?? -22) : (prior[k] ?? 0); R[k] = (num[k] + priorWeight * p) / (den[k] + priorWeight); }
    // keep the FBS average at zero, over teams that played (a team only in the prior, e.g. one that left FBS, keeps its
    // prior and stays out of the average; re-centering it every pass used to make it drift)
    const ks = Object.keys(num).filter(k => k !== FCS), mu = ks.reduce((a, k) => a + R[k], 0) / (ks.length || 1);
    for (const k of ks) R[k] -= mu;
  }
  return R;
}
export const Phi = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
export const iPhi = p => { let lo = -8, hi = 8; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
export function rateOf(R, id, div) { return div === 'fbs' || div == null ? (R[String(id)] ?? 0) : (R[FCS] ?? -22); }
// Expected home margin and home win probability for a game from ratings
export function gameLine(R, g, sigma = SIGMA) {
  const m = rateOf(R, g[G.hid], g[G.hdiv]) - rateOf(R, g[G.aid], g[G.adiv]) + (g[G.neutral] ? 0 : HFA);
  return { margin: m, p: Phi(m / sigma) };
}

// ---------- polls rebuilt from game-time ranks ----------
// ESPN stamps each game with both teams' rank in the poll that was current at kickoff. A team on a bye that week is
// missing, so empty slots are filled with the teams whose last known rank is closest (in order).
export function rebuildPolls(games, season) {
  const S = games.filter(g => g[G.season] === season);
  const weeks = [...new Set(S.map(g => g[G.week]))].sort((a, b) => a - b), polls = {}, last = {};
  // Games scheduled for later weeks carry today's ranks, so a week's poll only counts once the week before is played
  const played = w => { const x = S.filter(g => g[G.week] === w); return x.length && x.filter(g => g[G.hp] != null).length / x.length >= 0.9; };
  for (const w of weeks) {
    if (w !== weeks[0] && !played(w - 1)) break;
    const seen = {}, dates = S.filter(g => g[G.week] === w).map(g => g[G.date]).sort();
    for (const g of S) if (g[G.week] === w) { if (g[G.hr]) seen[g[G.hid]] = g[G.hr]; if (g[G.ar]) seen[g[G.aid]] = g[G.ar]; }
    if (!Object.keys(seen).length) continue;
    const taken = new Set(Object.values(seen)), poll = { ...seen }, observed = new Set(Object.keys(seen).map(String));
    const fill = Object.entries(last).filter(([id, x]) => !(id in seen) && w - x.w <= 2).sort((a, b) => a[1].r - b[1].r);
    const open = []; for (let r = 1; r <= 25; r++) if (!taken.has(r)) open.push(r);
    for (const [id] of fill) { if (!open.length) break; poll[id] = open.shift(); }
    for (const [id, r] of Object.entries(seen)) last[id] = { r, w };
    for (const id of Object.keys(last)) if (!(id in seen) && w - last[id].w > 2) delete last[id];
    polls[w] = { poll, observed, start: dates[0] };
  }
  return polls;
}

// ---------- features ----------
// State after a week's games for every FBS team in the season: record so far and that week's result
export const FEATS = ['1', 'v0', 'W', 'L', 'B', 'W*oppv', 'L*oppv', 'W*mov', 'L*mov', 'W*road', 'L*home', 'W*fcs', 'L*fcs', 'L*v0', 'B*v0', 'wins', 'losses', 'unbeaten', 'p4', 'rating', 'L*oppUnr', 'v0sq', 'W*v0'];
export function teamsOf(games, season) {
  const T = {};
  for (const g of games) if (g[G.season] === season) for (const [id, name, conf, div] of [[g[G.hid], g[G.home], g[G.hconf], g[G.hdiv]], [g[G.aid], g[G.away], g[G.aconf], g[G.adiv]]])
    if (div === 'fbs') T[id] = { id: String(id), name, conf, p4: p4Of(conf, season, name) };
  return T;
}
// x for each team after `week`'s games, given the poll that was current going into the week (poll: id -> rank)
export function features(games, season, week, poll, R, teams, override = null) {
  const rec = {}, res = {};
  for (const id of Object.keys(teams)) { rec[id] = { w: 0, l: 0 }; }
  for (const g0 of games) {
    if (g0[G.season] !== season || g0[G.week] > week) continue;
    const g = override && override[g0[G.id]] ? override[g0[G.id]] : g0;
    if (g[G.hp] == null || g[G.ap] == null || g[G.hp] === g[G.ap]) continue;
    for (const [me, op, mp, opp, home, opdiv] of [[g[G.hid], g[G.aid], g[G.hp], g[G.ap], !g[G.neutral], g[G.adiv]], [g[G.aid], g[G.hid], g[G.ap], g[G.hp], false, g[G.hdiv]]]) {
      if (!rec[me]) continue; const won = mp > opp; won ? rec[me].w++ : rec[me].l++;
      if (g[G.week] === week) res[me] = { won, mov: Math.max(-35, Math.min(35, mp - opp)), road: !home && !g[G.neutral] && me === g[G.aid], home, oppv: val(poll[op]), fcs: opdiv !== 'fbs' };
    }
  }
  const X = {};
  for (const id of Object.keys(teams)) {
    const r = res[id], v0 = val(poll[id]), W = r && r.won ? 1 : 0, L = r && !r.won ? 1 : 0, B = r ? 0 : 1, t = rec[id];
    X[id] = [1, v0, W, L, B, W * (r ? r.oppv : 0), L * (r ? r.oppv : 0), W * (r ? r.mov : 0) / 10, L * (r ? r.mov : 0) / 10, W * (r && r.road ? 1 : 0), L * (r && r.home ? 1 : 0),
      W * (r && r.fcs ? 1 : 0), L * (r && r.fcs ? 1 : 0), L * v0, B * v0, t.w, t.l, t.l === 0 ? 1 : 0, teams[id].p4 ? 1 : 0, (R[id] ?? 0) / 10, L * (r && !r.oppv ? 1 : 0), v0 * v0 / 25, W * v0];
  }
  return X;
}

// ---------- ridge regression ----------
export function ridge(rows, lambda = 1) {
  const k = rows[0].x.length, A = Array.from({ length: k }, () => new Float64Array(k)), b = new Float64Array(k);
  for (const { x, y, w = 1 } of rows) for (let i = 0; i < k; i++) { b[i] += w * x[i] * y; for (let j = 0; j < k; j++) A[i][j] += w * x[i] * x[j]; }
  for (let i = 1; i < k; i++) A[i][i] += lambda;
  // Gaussian elimination
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-9; for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c] / d; for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; } }
  return M.map((r, i) => r[k] / (r[i] || 1e-9));
}
const dot = (w, x) => { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * x[i]; return s; };

// The model: separate weights for teams that were ranked going in (R) and teams that weren't (U)
export function predictValues(model, X, poll) {
  const out = {};
  for (const [id, x] of Object.entries(X)) out[id] = dot(poll[id] ? model.R : model.U, x);
  return out;
}
export function rankFrom(values) {
  return Object.fromEntries(Object.entries(values).sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i + 1]));
}
// Sufficient statistics (X'WX, X'Wy, y'Wy, sum of weights) so new weeks can be added and the model refit without
// keeping every historical row around
export function stats(rows) {
  const k = FEATS.length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0); let yy = 0, n = 0;
  for (const { x, y, w = 1 } of rows) { yy += w * y * y; n += w; for (let i = 0; i < k; i++) { b[i] += w * x[i] * y; for (let j = 0; j < k; j++) A[i][j] += w * x[i] * x[j]; } }
  return { A, b, yy, n };
}
export function addStats(s, t, scale = 1) {
  if (!s) return { A: t.A.map(r => r.map(v => v * scale)), b: t.b.map(v => v * scale), yy: t.yy * scale, n: t.n * scale };
  return { A: s.A.map((r, i) => r.map((v, j) => v + scale * t.A[i][j])), b: s.b.map((v, i) => v + scale * t.b[i]), yy: s.yy + scale * t.yy, n: s.n + scale * t.n };
}
export function solve(st, lambda = 2) {
  const k = st.b.length, M = st.A.map((r, i) => [...r.map((v, j) => v + (i === j && i > 0 ? lambda : 0)), st.b[i]]);
  for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-9; for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c] / d; for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; } }
  const w = M.map((r, i) => r[k] / (r[i] || 1e-9));
  // residual SD: (y'y - 2w'b + w'Aw) / n
  let wb = 0, wAw = 0; for (let i = 0; i < k; i++) { wb += w[i] * st.b[i]; for (let j = 0; j < k; j++) wAw += w[i] * st.A[i][j] * w[j]; }
  return { w, sd: Math.sqrt(Math.max(0, (st.yy - 2 * wb + wAw) / Math.max(1, st.n))) };
}
// stats: { R, U } sufficient statistics for teams ranked / unranked going into the week
export function fitStats(S, lambda = 2) { const r = solve(S.R, lambda), u = solve(S.U, lambda); return { R: r.w, U: u.w, sdR: r.sd, sdU: u.sd }; }
export function fit(samples, { lambda = 2 } = {}) {
  return fitStats({ R: stats(samples.filter(s => s.ranked)), U: stats(samples.filter(s => !s.ranked)) }, lambda);
}

// Training rows for one season: poll before week w + week w results -> poll before week w+1
// AP only: ESPN switches its ranks to the CFP rankings once those come out, so only weeks that start before Oct 27.
export function samplesFor(games, season, { prior = {}, apOnly = true } = {}) {
  const polls = rebuildPolls(games, season), teams = teamsOf(games, season), weeks = Object.keys(polls).map(Number).sort((a, b) => a - b), out = [];
  for (let i = 0; i + 1 < weeks.length; i++) {
    const w = weeks[i], nx = weeks[i + 1]; if (nx !== w + 1) continue;
    if (apOnly && polls[nx].start.slice(5) >= '10-27') continue;
    const wg = games.filter(g => g[G.season] === season && g[G.week] === w); if (wg.filter(g => g[G.hp] != null).length < 0.9 * wg.length) continue;
    const before = games.filter(g => g[G.season] === season && g[G.week] <= w), R = ratings(before, { prior });
    const X = features(games, season, w, polls[w].poll, R, teams), next = polls[nx];
    for (const [id, x] of Object.entries(X)) {
      const ranked = !!polls[w].poll[id];
      // only judge a team's next rank where it was seen (it played the next week) or it surely fell out
      const r1 = next.poll[id]; if (!next.observed.has(id) && r1) continue;
      if (!ranked && x[16] > 3) continue; // unranked with 4+ losses: never in the poll, skip the noise
      out.push({ season, week: w, id, x, y: val(r1), ranked, w: 1 });
    }
  }
  return out;
}

// ---------- simulation ----------
// Small seeded RNG so a page refresh doesn't reshuffle everything
export function rng(seed = 1) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const gauss = r => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };

// Where a game stands: final, live (lead, share of the game left, ESPN's home win %), or not started.
// Returns the home team's expected final margin (mu), its spread (s) and the home win probability.
export function gameOutlook(R, g, live) {
  const pre = live && live.line != null ? live.line : gameLine(R, g).margin;
  if (g[G.hp] != null && g[G.ap] != null && (!live || live.state === 'post')) return { final: true, mu: g[G.hp] - g[G.ap], s: 0, p: g[G.hp] > g[G.ap] ? 1 : 0 };
  if (live && live.state === 'in') {
    const f = Math.max(0.005, Math.min(1, live.left)), s = SIGMA * Math.sqrt(f);
    let mu = live.lead + pre * f;
    if (live.prob != null && live.prob > 0.001 && live.prob < 0.999) mu = s * iPhi(live.prob); // ESPN's live win % when it has one
    return { live: true, mu, s, p: Phi(mu / s) };
  }
  return { mu: pre, s: SIGMA, p: Phi(pre / SIGMA) };
}

// The next AP poll, simulated: unfinished games this week are played out `sims` times, each outcome goes through the
// poll model, and voter noise (the model's own miss size) is added. Returns each team's rank distribution.
// force: { gameId: 'h' | 'a' } settles unfinished games for a what-if (the forced team wins by its expected margin, at
// least a touchdown if it was the underdog).
export const forcedRow = (g, o, side) => { const t = g.slice(), m = side === 'h' ? Math.max(o.mu > 0 ? Math.round(o.mu) : 7, 1) : -Math.max(o.mu < 0 ? Math.round(-o.mu) : 7, 1);
  t[G.hp] = Math.max(0, m); t[G.ap] = Math.max(0, -m); return t; };
export function projectPoll({ games, season, week, poll, R, teams, model, live = {}, sims = 300, seed = 7, force = {} }) {
  const r = rng(seed), wk = games.filter(g => g[G.season] === season && g[G.week] === week), open = [];
  const outlook = {}, fixed = {};
  for (const g of wk) { const o = gameOutlook(R, g, live[g[G.id]]); outlook[g[G.id]] = o;
    if (!o.final && force[g[G.id]]) { fixed[g[G.id]] = forcedRow(g, o, force[g[G.id]]); outlook[g[G.id]] = { ...o, forced: force[g[G.id]], p: force[g[G.id]] === 'h' ? 1 : 0 }; }
    else if (!o.final) open.push(g); }
  // chaos: how many of the current top 10 lose this week, sim by sim
  const top10 = Object.entries(poll).filter(([, x]) => x <= 10).map(([id]) => id), top5 = new Set(top10.filter(id => poll[id] <= 5));
  const lostIn = row => { const out = []; if (row[G.hp] == null || row[G.hp] === row[G.ap]) return out; out.push(String(row[G.hp] > row[G.ap] ? row[G.aid] : row[G.hid])); return out; };
  const chaos = { anyTop5: 0, top10Losses: new Array(11).fill(0) };
  const ids = Object.keys(teams), N = {}, P25 = {}, P10 = {}, sum = {}, hist = {};
  for (const id of ids) { N[id] = 0; P25[id] = 0; P10[id] = 0; sum[id] = 0; hist[id] = new Array(27).fill(0); }
  const one = override => { const X = features(games, season, week, poll, R, teams, override); return predictValues(model, X, poll); };
  // the single most likely outcome: every open game goes to the team that's ahead or favored
  const fav = { ...fixed }; for (const g of open) { const m = outlook[g[G.id]].mu; const t = g.slice(); const mm = Math.round(m) || (m >= 0 ? 1 : -1); t[G.hp] = Math.max(0, mm); t[G.ap] = Math.max(0, -mm); fav[g[G.id]] = t; }
  const likely = rankFrom(one(fav));
  for (let k = 0; k < sims; k++) {
    const ov = { ...fixed };
    for (const g of open) { const o = outlook[g[G.id]]; let m = Math.round(o.mu + o.s * gauss(r)); if (!m) m = r() < o.p ? 1 : -1; const t = g.slice(); t[G.hp] = Math.max(0, m); t[G.ap] = Math.max(0, -m); ov[g[G.id]] = t; }
    { let n = 0, t5 = false; const T10 = new Set(top10);
      for (const g of wk) { const row = ov[g[G.id]] || g; for (const id of lostIn(row)) if (T10.has(id)) { n++; if (top5.has(id)) t5 = true; } }
      chaos.top10Losses[Math.min(10, n)]++; if (t5) chaos.anyTop5++; }
    const v = one(ov); for (const id of ids) v[id] += gauss(r) * (poll[id] ? model.sdR : Math.min(model.sdU, model.sdR)) * 0.5;
    const rk = rankFrom(v);
    for (const id of ids) { const x = rk[id]; sum[id] += Math.min(x, 26); hist[id][Math.min(x, 26)]++; if (x <= 25) P25[id]++; if (x <= 10) P10[id]++; }
  }
  const q = (h, p) => { let c = 0; for (let i = 1; i < h.length; i++) { c += h[i]; if (c >= p * sims) return i; } return 26; };
  const out = ids.map(id => ({ id, prev: poll[id] || null, likely: likely[id], mean: sum[id] / sims, p25: P25[id] / sims, p10: P10[id] / sims, lo: q(hist[id], 0.1), hi: q(hist[id], 0.9), hist: hist[id].slice(1) }));
  // The projected poll: teams in order of their average simulated rank
  out.sort((a, b) => a.mean - b.mean || a.likely - b.likely);
  chaos.anyTop5 /= sims; chaos.top10Losses = chaos.top10Losses.map(c => c / sims);
  const likelyValues = one(fav);
  return { teams: out.filter(t => t.p25 > 0.02 || t.prev || t.likely <= 30), outlook, open: open.length, total: wk.length, sims, chaos, likely, likelyValues, fixed };
}

// The games that move the poll most: each unfinished game is settled both ways (everything else to the favorite) and
// the two projected polls are compared. Swing = total spots the top 30 move between the two outcomes.
export function swingGames({ games, season, week, poll, R, teams, model, live = {}, fixed = {}, top = 6 }) {
  const wk = games.filter(g => g[G.season] === season && g[G.week] === week), outlook = {}, base = { ...fixed }, open = [];
  for (const g of wk) { const o = gameOutlook(R, g, live[g[G.id]]); outlook[g[G.id]] = o; if (!o.final && !fixed[g[G.id]]) { open.push(g); base[g[G.id]] = forcedRow(g, o, o.mu >= 0 ? 'h' : 'a'); } }
  const run = ov => rankFrom(predictValues(model, features(games, season, week, poll, R, teams, ov), poll));
  const ref = run(base), watch = Object.entries(ref).filter(([, x]) => x <= 30).map(([id]) => id);
  const out = [];
  for (const g of open) {
    const h = g[G.hid], a = g[G.aid]; if (!(poll[h] || poll[a] || ref[h] <= 30 || ref[a] <= 30)) continue;
    const H = run({ ...base, [g[G.id]]: forcedRow(g, outlook[g[G.id]], 'h') }), A = run({ ...base, [g[G.id]]: forcedRow(g, outlook[g[G.id]], 'a') });
    const ids = new Set([...watch, String(h), String(a)]); let swing = 0; for (const id of ids) swing += Math.min(15, Math.abs((H[id] || 40) - (A[id] || 40)));
    out.push({ id: g[G.id], home: String(h), away: String(a), p: outlook[g[G.id]].p, swing, ifHome: { home: H[h], away: H[a] }, ifAway: { home: A[h], away: A[a] } });
  }
  return out.sort((x, y) => y.swing - x.swing).slice(0, top);
}

// Offense and defense ratings: expected points = mean + off(team) - def(opponent) +/- half the home edge. Used to turn
// a projected margin into a projected score, and to explain a matchup.
export function odRatings(games, { prior = {}, priorWeight = 6, iters = 60, cap = 63 } = {}) {
  const done = games.filter(g => g[G.hp] != null && g[G.ap] != null), key = (id, div) => (div === 'fbs' ? String(id) : FCS);
  const O = {}, Dd = {}; let mean = 27;
  for (const g of done) for (const [id, div] of [[g[G.hid], g[G.hdiv]], [g[G.aid], g[G.adiv]]]) { const k = key(id, div); O[k] = prior.o?.[k] ?? (k === FCS ? -10 : 0); Dd[k] = prior.d?.[k] ?? (k === FCS ? -12 : 0); }
  if (done.length) mean = done.reduce((a, g) => a + Math.min(cap, g[G.hp]) + Math.min(cap, g[G.ap]), 0) / (2 * done.length);
  for (let it = 0; it < iters; it++) {
    const no = {}, nd = {}, c = {};
    for (const g of done) {
      const h = key(g[G.hid], g[G.hdiv]), a = key(g[G.aid], g[G.adiv]), e = g[G.neutral] ? 0 : HFA / 2;
      const ph = Math.min(cap, g[G.hp]), pa = Math.min(cap, g[G.ap]);
      no[h] = (no[h] || 0) + ph - mean - e + Dd[a]; no[a] = (no[a] || 0) + pa - mean + e + Dd[h];
      nd[a] = (nd[a] || 0) + mean + e + O[h] - ph; nd[h] = (nd[h] || 0) + mean - e + O[a] - pa;
      c[h] = (c[h] || 0) + 1; c[a] = (c[a] || 0) + 1;
    }
    for (const k of Object.keys(c)) { if (k === FCS) continue; O[k] = (no[k] + priorWeight * (prior.o?.[k] ?? 0)) / (c[k] + priorWeight); Dd[k] = (nd[k] + priorWeight * (prior.d?.[k] ?? 0)) / (c[k] + priorWeight); }
  }
  return { o: O, d: Dd, mean };
}

// The rest of the regular season, played out `sims` times. Each sim also nudges every team's rating (shock, in points)
// because a team's true strength is uncertain, which makes a team's results move together like they do in real life.
export function seasonSim({ games, season, R, teams, live = {}, sims = 4000, shock = 4, seed = 11 }) {
  const r = rng(seed), S = games.filter(g => g[G.season] === season), ids = Object.keys(teams);
  const W0 = {}, L0 = {}; for (const id of ids) { W0[id] = 0; L0[id] = 0; }
  const rest = [];
  for (const g of S) {
    const o = gameOutlook(R, g, live[g[G.id]]);
    if (o.final) { if (g[G.hp] === g[G.ap]) continue; const hw = g[G.hp] > g[G.ap]; if (W0[g[G.hid]] != null) hw ? W0[g[G.hid]]++ : L0[g[G.hid]]++; if (W0[g[G.aid]] != null) hw ? L0[g[G.aid]]++ : W0[g[G.aid]]++; }
    else rest.push({ g, o });
  }
  const hist = {}; for (const id of ids) hist[id] = new Array(17).fill(0);
  const sh = {};
  for (let k = 0; k < sims; k++) {
    for (const id of ids) sh[id] = gauss(r) * shock;
    const w = { ...W0 };
    for (const { g, o } of rest) {
      const d = (sh[g[G.hid]] || 0) - (sh[g[G.aid]] || 0), mu = o.mu + (o.live ? d * (o.s / SIGMA) : d), s = o.s || 0.01;
      const home = mu + s * gauss(r) > 0;
      if (home) { if (w[g[G.hid]] != null) w[g[G.hid]]++; } else if (w[g[G.aid]] != null) w[g[G.aid]]++;
    }
    for (const id of ids) hist[id][Math.min(16, w[id])]++;
  }
  const out = {};
  for (const id of ids) {
    const h = hist[id].map(c => c / sims), mean = h.reduce((a, p, i) => a + p * i, 0);
    const games = S.filter(g => String(g[G.hid]) === id || String(g[G.aid]) === id).length;
    out[id] = { w: W0[id], l: L0[id], games, mean, hist: h };
  }
  return { teams: out, rest: rest.length, sims };
}

// ---------- strength of schedule and strength of record ----------
// For one point in the season (ratings R built from games through `week`):
//   difficulty of a game  = opponent's rating - home edge (a road game at a +10 team counts as 12.5)
//   SOS                   = average difficulty (played, remaining, full season)
//   benchmark             = the average rating of the top 25 teams right now ("a typical top-25 team")
//   strength of record    = chance the benchmark team would win at least as many of these games (lower = more impressive)
//   wins above benchmark  = actual wins - the benchmark team's expected wins against the same games
//   game score            = margin (capped at 28) - home edge + opponent rating: how well the team played that day,
//                           in rating points
export function sosTable(games, season, week, R, teams) {
  const S = games.filter(g => g[G.season] === season), fbs = Object.keys(teams).filter(id => R[id] != null);
  const bench = fbs.map(id => R[id]).sort((a, b) => b - a).slice(0, 25).reduce((a, b) => a + b, 0) / 25;
  const out = {};
  for (const id of fbs) out[id] = { id, played: [], rest: [], w: 0, l: 0 };
  for (const g of S) for (const [me, op, home] of [[String(g[G.hid]), String(g[G.aid]), true], [String(g[G.aid]), String(g[G.hid]), false]]) {
    const t = out[me]; if (!t) continue;
    const opR = teams[op] ? (R[op] ?? 0) : (R[FCS] ?? -22), site = g[G.neutral] ? 0 : home ? HFA : -HFA, diff = opR - site;
    const done = g[G.week] <= week && g[G.hp] != null && g[G.hp] !== g[G.ap];
    const x = { op, opR, site, diff, pb: Phi((bench - diff) / SIGMA), week: g[G.week], id: g[G.id] };
    if (done) { const m = (home ? 1 : -1) * (g[G.hp] - g[G.ap]); x.m = m; x.won = m > 0; x.score = Math.max(-28, Math.min(28, m)) - site + opR; x.won ? t.w++ : t.l++; t.played.push(x); }
    else if (g[G.week] > week) t.rest.push(x);
  }
  for (const t of Object.values(out)) { t.played.sort((a, b) => a.week - b.week); t.rest.sort((a, b) => a.week - b.week); }
  const avg = a => (a.length ? a.reduce((s, x) => s + x.diff, 0) / a.length : null);
  for (const t of Object.values(out)) {
    // P(benchmark wins >= t.w of the played games): Poisson-binomial by dynamic programming
    let dp = [1]; for (const x of t.played) { const n = new Array(dp.length + 1).fill(0); dp.forEach((p, k) => { n[k] += p * (1 - x.pb); n[k + 1] += p * x.pb; }); dp = n; }
    t.sor = t.played.length ? dp.slice(t.w).reduce((a, b) => a + b, 0) : null;
    t.benchW = t.played.reduce((a, x) => a + x.pb, 0); t.wab = t.w - t.benchW;
    t.sos = avg(t.played); t.futSos = avg(t.rest); t.fullSos = avg([...t.played, ...t.rest]);
    t.futBenchW = t.rest.reduce((a, x) => a + x.pb, 0);
    t.perf = t.played.length ? t.played.reduce((a, x) => a + x.score, 0) / t.played.length : null;
    t.power = R[t.id] ?? 0;
  }
  // ranks: hardest schedule = 1; most impressive record = 1 (lowest SOR, then more wins above benchmark)
  const rank = (key, cmp) => { const L = Object.values(out).filter(t => t[key] != null).sort(cmp); L.forEach((t, i) => { t[key + 'Rank'] = i + 1; }); };
  rank('sos', (a, b) => b.sos - a.sos); rank('futSos', (a, b) => b.futSos - a.futSos); rank('fullSos', (a, b) => b.fullSos - a.fullSos);
  rank('sor', (a, b) => a.sor - b.sor || b.wab - a.wab); rank('power', (a, b) => b.power - a.power); rank('wab', (a, b) => b.wab - a.wab);
  return { bench, teams: out };
}
