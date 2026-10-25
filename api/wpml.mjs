// The machine-learning win-probability model: a second opinion that never simulates anything. It learned straight
// from how real games ended (CFB: every ESPN play 2014-2025; NFL: nflverse 2006-2026) which game states turn into wins.
// Model: LightGBM gradient-boosted trees, trained in tools/ml/train_wp.py, shipped as api/wpml_<league>.json.
// The features here are computed identically in Python (tools/ml/train_wp.py) and checked for parity.
//
// A state is from the HOME team's point of view:
//   diff (home - away), tl (seconds left in regulation), posH (+1 home ball, -1 away), ytg (yards to the end zone),
//   down, dist, toH, toA (timeouts), spread (pregame expected home margin), total (over/under),
//   h2 (+1 home gets the 2nd-half kickoff, -1 away, 0 once the 2nd half has started)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const WP_FEATS = ['diff', 'tl', 'posH', 'ytg', 'down', 'dist', 'toH', 'toA', 'spread', 'total', 'h2', 'em', 'z', 'fp'];
export function wpFeatures(s) {
  const f = s.tl / 3600, em = s.diff + s.spread * f; // expected final margin if the rest of the game goes to form
  return [s.diff, s.tl, s.posH, s.ytg, s.down, s.dist, s.toH, s.toA, s.spread, s.total, s.h2, em, em / (14 * Math.sqrt(f) + 1), s.posH * (100 - s.ytg)];
}
// LightGBM trees, flattened: each tree is [feature, threshold, left, right] nodes and leaf values; a child index < 0 is
// leaf (-index - 1). Goes left when x <= threshold.
export function wpRaw(m, x) {
  let s = 0;
  for (const t of m.trees) { let n = 0; for (;;) { const nd = t.n[n], c = x[nd[0]] <= nd[1] ? nd[2] : nd[3]; if (c < 0) { s += t.l[-c - 1]; break; } n = c; } }
  return s;
}
// The logistic-regression half: standardized features plus three interactions, one weight each
export function lrProb(lr, x) {
  const f = 1 - x[1] / 3600, z = [...x, x[11] * f, x[12] * Math.abs(x[12]), x[13] * f];
  let s = lr.b; for (let i = 0; i < z.length; i++) s += lr.coef[i] * (z[i] - lr.mean[i]) / lr.scale[i];
  return 1 / (1 + Math.exp(-s));
}
const sig = v => 1 / (1 + Math.exp(-v));
// Both ML models and their average (the average is what the site calls "the ML model")
export function wpAll(m, s) { const x = wpFeatures(s), trees = sig(wpRaw(m, x)), lr = m.lr ? lrProb(m.lr, x) : trees; return { trees, lr, ml: (trees + lr) / 2 }; }
export const wpProb = (m, s) => wpAll(m, s).ml;
// The live engine's state (slots ND / UNC, one of them home) -> home-perspective state
export function fromEngine(S, homeSlot, edgeND) {
  const h = homeSlot === 'ND', nd = S.nd ?? 0, unc = S.unc ?? 0, q = S.qtr ?? 1;
  const tl = q > 4 ? 0 : Math.max(0, (4 - q) * 900 + (S.secs ?? 900));
  const spreadND = edgeND ?? S.edge ?? 0;
  return {
    diff: h ? nd - unc : unc - nd, tl, posH: (S.poss === homeSlot) ? 1 : -1, ytg: Math.max(1, Math.min(99, 100 - (S.pos ?? 25))),
    down: Math.max(1, Math.min(4, S.down ?? 1)), dist: Math.max(1, Math.min(99, S.dist ?? 10)), toH: h ? S.toND ?? 3 : S.toUNC ?? 3, toA: h ? S.toUNC ?? 3 : S.toND ?? 3,
    spread: h ? spreadND : -spreadND, total: S.total ?? 52, h2: q <= 2 && S.half2Recv ? (S.half2Recv === homeSlot ? 1 : -1) : 0,
  };
}
const cache = {};
export function loadWp(league) {
  if (league in cache) return cache[league];
  try { cache[league] = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), `wpml_${league}.json`), 'utf8')); } catch { cache[league] = null; }
  return cache[league];
}
