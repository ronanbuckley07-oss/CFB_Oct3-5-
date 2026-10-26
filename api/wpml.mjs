// The machine-learning win-probability model: a second opinion that never simulates anything. It learned straight
// from how real games ended (CFB: every ESPN play 2014-2025; NFL: nflverse 2006-2026) which game states turn into wins.
// Three models, averaged: LightGBM gradient-boosted trees, a logistic regression, and a small neural network
// (inputs -> 16 -> 8 -> 1). Trained in tools/ml/train_wp.py, shipped as api/wpml_<league>.json. The features here are
// computed identically in Python and checked for parity.
//
// A state is from the HOME team's point of view:
//   diff (home - away), tl (seconds left in regulation), posH (+1 home ball, -1 away), ytg (yards to the end zone),
//   down, dist, toH, toA (timeouts), spread (pregame expected home margin), total (over/under),
//   h2 (+1 home gets the 2nd-half kickoff, -1 away, 0 once the 2nd half has started),
//   and momentum: run (home minus away points, last 10 game-minutes), last (+1 home scored last, -1 away, 0 none),
//   ypp (home minus away offense yards per play, last 16 snaps), tov (away minus home turnovers, last 10 game-minutes)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ALL_FEATS = ['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2', 'em', 'z', 'fp', 'run', 'last', 'ypp', 'tov'];
export const WP_FEATS = ALL_FEATS.slice(0, 14);
export const MOMENTUM = ['run', 'last', 'ypp', 'tov'];
function featMap(s) {
  const f = s.tl / 3600, em = s.diff + s.spread * f; // expected final margin if the rest of the game goes to form
  return { diff: s.diff, tl: s.tl, posH: s.posH, ytg: s.ytg, down: s.down, dist: s.dist, toH: s.toH, toA: s.toA, spread: s.spread, total: s.total, h2: s.h2,
    em, z: em / (14 * Math.sqrt(f) + 1), fp: s.posH * (100 - s.ytg), run: s.run ?? 0, last: s.last ?? 0, ypp: s.ypp ?? 0, tov: s.tov ?? 0 };
}
export function wpFeatures(s, feats = WP_FEATS) { const m = featMap(s); return feats.map(f => m[f]); }
const sig = v => 1 / (1 + Math.exp(-v));
const featsOf = m => m.feats || WP_FEATS;

// LightGBM trees, flattened: nodes [feature, threshold, left, right, node average]; a child index < 0 is leaf
// (-index - 1). Goes left when x <= threshold.
export function wpRaw(m, x) {
  let s = 0;
  for (const t of m.trees) { let n = 0; for (;;) { const nd = t.n[n], c = x[nd[0]] <= nd[1] ? nd[2] : nd[3]; if (c < 0) { s += t.l[-c - 1]; break; } n = c; } }
  return s;
}
// The logistic regression: standardized inputs plus three interactions, one weight each
function lrInputs(m, x) { const F = featsOf(m), i = k => F.indexOf(k), f = 1 - x[i('tl')] / 3600; return [...x, x[i('em')] * f, x[i('z')] * Math.abs(x[i('z')]), x[i('fp')] * f]; }
export function lrLogit(lr, z) { let s = lr.b; for (let i = 0; i < z.length; i++) s += lr.coef[i] * (z[i] - lr.mean[i]) / lr.scale[i]; return s; }
export const lrProb = (m, x) => sig(lrLogit(m.lr, lrInputs(m, x)));
// The neural network: standardize, ReLU hidden layers, sigmoid output. Returns every layer's activations too.
export function nnForward(nn, x) {
  let a = x.map((v, i) => (v - nn.mean[i]) / nn.scale[i]); const layers = [a];
  for (let L = 0; L < nn.W.length; L++) {
    const W = nn.W[L], b = nn.b[L], out = new Array(b.length).fill(0);
    for (let j = 0; j < b.length; j++) { let s = b[j]; for (let i = 0; i < a.length; i++) s += a[i] * W[i][j]; out[j] = L < nn.W.length - 1 ? Math.max(0, s) : s; }
    a = out; layers.push(a);
  }
  return { p: sig(a[0]), logit: a[0], layers };
}
// All three, and their average (the average is what the site calls "the ML model")
export function wpAll(m, s) {
  const x = wpFeatures(s, featsOf(m)), trees = sig(wpRaw(m, x)), lr = m.lr ? sig(lrLogit(m.lr, lrInputs(m, x))) : trees, nn = m.nn ? nnForward(m.nn, x).p : null;
  const parts = [trees, lr, ...(nn != null ? [nn] : [])];
  return { trees, lr, nn, ml: parts.reduce((a, b) => a + b, 0) / parts.length };
}
export const wpProb = (m, s) => wpAll(m, s).ml;

// ---------- why: each model's answer broken into input-by-input contributions (log-odds) ----------
// trees: Saabas path attribution (each split's change in node average goes to the split's input);
// logistic: weight x (input - average) / spread, interactions credited to the input they're built from;
// network: occlusion (set one input to its training average and see how far the answer moves).
export function explain(m, s) {
  const F = featsOf(m), x = wpFeatures(s, F), out = { feats: F, x };
  const tc = new Array(F.length).fill(0); let base = 0, path0 = null;
  m.trees.forEach((t, ti) => {
    let n = 0, val = t.n[0][4]; base += val; const steps = [];
    for (;;) { const nd = t.n[n], left = x[nd[0]] <= nd[1], c = left ? nd[2] : nd[3], nv = c < 0 ? t.l[-c - 1] : t.n[c][4];
      tc[nd[0]] += nv - val; if (ti === 0) steps.push({ f: F[nd[0]], thr: nd[1], left, v: nv }); val = nv; if (c < 0) break; n = c; }
    if (ti === 0) path0 = { root: t.n[0][4], steps };
  });
  out.trees = { base, contrib: tc, logit: base + tc.reduce((a, b) => a + b, 0), firstTree: path0, n: m.trees.length };
  if (m.lr) { const z = lrInputs(m, x), names = m.lr.feats || [], c = new Array(F.length).fill(0), parent = { em_t: 'em', z2: 'z', fp_t: 'fp' };
    z.forEach((v, i) => { const nm = names[i] || F[i], k = F.indexOf(parent[nm] || nm); c[k] += m.lr.coef[i] * (v - m.lr.mean[i]) / m.lr.scale[i]; });
    out.lr = { base: m.lr.b, contrib: c, logit: lrLogit(m.lr, z) }; }
  if (m.nn) { const full = nnForward(m.nn, x), c = F.map((_, i) => { const y = x.slice(); y[i] = m.means ? m.means[i] : m.nn.mean[i]; return full.logit - nnForward(m.nn, y).logit; });
    out.nn = { contrib: c, logit: full.logit, layers: full.layers }; }
  return out;
}

// ---------- momentum from ESPN's play list (the same definitions as tools/ml/states.py) ----------
// plays: [{ period, clock 'M:SS', hs, as (score after the play), team (offense id), yds, type, down }] in order.
// homeId: the home team's ESPN id.
export function momentumFrom(plays, homeId) {
  const el = p => { const [mm, ss] = String(p.clock || '0:00').split(':').map(Number); const q = Math.min(4, p.period || 1); return (q - 1) * 900 + (900 - ((mm || 0) * 60 + (ss || 0))); };
  const ev = [], snaps = []; let lh = 0, la = 0, last = 0, now = 0;
  for (const p of plays || []) {
    if (p.hs == null || p.as == null) continue; const t = el(p); now = Math.max(now, t);
    const dh = p.hs - lh, da = p.as - la; if (dh > 0 || da > 0) { ev.push({ t, run: Math.max(0, dh) - Math.max(0, da) }); last = dh > da ? 1 : -1; } lh = p.hs; la = p.as;
    const off = String(p.team) === String(homeId) ? 1 : -1;
    if (p.down >= 1 && p.down <= 4 && p.yds != null && !/punt|field goal|kickoff|extra point|timeout|penalty/i.test(p.type || '')) snaps.push({ off, y: Math.max(-20, Math.min(60, p.yds)) });
    if (/interception|fumble recovery \(opponent\)|fumble lost/i.test(p.type || '')) ev.push({ t, tov: -off });
  }
  const recent = ev.filter(e => e.t >= now - 600), s16 = snaps.slice(-16), hy = s16.filter(x => x.off === 1).map(x => x.y), ay = s16.filter(x => x.off === -1).map(x => x.y);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { run: recent.reduce((a, e) => a + (e.run || 0), 0), last, ypp: hy.length && ay.length ? Math.max(-15, Math.min(15, mean(hy) - mean(ay))) : 0, tov: recent.reduce((a, e) => a + (e.tov || 0), 0) };
}

// The live engine's state (slots ND / UNC, one of them home) -> home-perspective state
export function fromEngine(S, homeSlot, edgeND, mom) {
  const h = homeSlot === 'ND', nd = S.nd ?? 0, unc = S.unc ?? 0, q = S.qtr ?? 1;
  const tl = q > 4 ? 0 : Math.max(0, (4 - q) * 900 + (S.secs ?? 900));
  const spreadND = edgeND ?? S.edge ?? 0;
  return {
    diff: h ? nd - unc : unc - nd, tl, posH: (S.poss === homeSlot) ? 1 : -1, ytg: Math.max(1, Math.min(99, 100 - (S.pos ?? 25))),
    down: Math.max(1, Math.min(4, S.down ?? 1)), dist: Math.max(1, Math.min(99, S.dist ?? 10)), toH: h ? S.toND ?? 3 : S.toUNC ?? 3, toA: h ? S.toUNC ?? 3 : S.toND ?? 3,
    spread: h ? spreadND : -spreadND, total: S.total ?? 52, h2: q <= 2 && S.half2Recv ? (S.half2Recv === homeSlot ? 1 : -1) : 0,
    run: mom ? mom.run : 0, last: mom ? mom.last : 0, ypp: mom ? mom.ypp : 0, tov: mom ? mom.tov : 0,
  };
}
const cache = {};
export function loadWp(league) {
  if (league in cache) return cache[league];
  try { cache[league] = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), `wpml_${league}.json`), 'utf8')); } catch { cache[league] = null; }
  return cache[league];
}
