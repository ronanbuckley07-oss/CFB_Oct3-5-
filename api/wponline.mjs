// Live learning for the ML model, as games finish. The big models (trees, logistic, network) were trained on past
// seasons; on top of them sits a small correction layer that learns from this season's finished games:
//   corrected log-odds = b + a x (ML log-odds) + w_run x run/10 + w_last x last + w_ypp x ypp/5 + w_tov x tov
// It starts as "no correction" (b = 0, a = 1, w = 0). After every graded game it takes a few gradient steps on that
// game's live reads, pulled back toward "no correction" so one strange game can't swing it.
// Momentum lives here on purpose: offline it added nothing once score, time and strength were known (tools/ml/train_wp.py
// "momentum" set), so it starts at weight zero and only grows if this season's live games say it matters.
// Two guards: (1) prequential scoring: each game is predicted *before* it's learned from, and the correction is only
// switched on once its running score beats the plain model's; (2) an anchor set of held-out past plays: an update that
// makes the anchor set worse by more than 0.002 log loss is rejected.
// Saved to DATA_DIR/wponline.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wpProb, loadWp } from './wpml.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const cl = p => Math.min(0.995, Math.max(0.005, p)), logit = p => Math.log(cl(p) / (1 - cl(p))), sig = v => 1 / (1 + Math.exp(-v));
const ll = (p, y) => -(y ? Math.log(cl(p)) : Math.log(1 - cl(p)));
export const NAMES = ['bias', 'trust in the model', 'scoring run', 'who scored last', 'recent yards per play', 'recent turnovers'];
const INIT = [0, 1, 0, 0, 0, 0];
// inputs: [1, base logit, run/10, last, ypp/5, tov]
const xOf = (s, base) => [1, logit(base), (s.run ?? 0) / 10, s.last ?? 0, (s.ypp ?? 0) / 5, s.tov ?? 0];
const apply = (w, x) => sig(w.reduce((a, wi, i) => a + wi * x[i], 0));

export function createOnline({ dataDir }) {
  const file = dataDir ? path.join(dataDir, 'wponline.json') : null;
  let db = {}; try { if (file) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const L = lg => (db[lg] ||= { w: INIT.slice(), games: 0, preq: { base: 0, corr: 0, n: 0 }, history: [], on: false });
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch {} };
  const anchors = {};
  const anchorOf = lg => { if (lg in anchors) return anchors[lg]; try { const m = loadWp(lg), rows = JSON.parse(fs.readFileSync(path.join(here, `wpml_${lg}_anchor.json`), 'utf8')).rows.slice(0, 2500);
    anchors[lg] = rows.map(r => ({ x: xOf(r, wpProb(m, r)), y: r.y })); } catch { anchors[lg] = null; } return anchors[lg]; };
  const lossOn = (w, rows) => rows.reduce((a, r) => a + ll(apply(w, r.x), r.y), 0) / rows.length;

  // states: home-perspective ML states (with momentum) from one finished game's live reads; y: 1 if home won
  function learn(lg, states, y, meta = {}) {
    const m = loadWp(lg); if (!m || !states.length) return null;
    const S = L(lg), rows = states.map(s => ({ x: xOf(s, wpProb(m, s)), y }));
    // 1. predict before learning (prequential)
    const base = rows.reduce((a, r) => a + ll(sig(r.x[1]), y), 0) / rows.length, corr = lossOn(S.w, rows);
    S.preq.base += base * rows.length; S.preq.corr += corr * rows.length; S.preq.n += rows.length;
    // 2. a few gradient steps, each pulled back toward "no correction" (L2 toward INIT)
    const w = S.w.slice(), lr = 0.05, lam = 0.02, steps = 8;
    for (let k = 0; k < steps; k++) { const g = new Array(w.length).fill(0);
      for (const r of rows) { const e = apply(w, r.x) - r.y; for (let i = 0; i < w.length; i++) g[i] += e * r.x[i] / rows.length; }
      for (let i = 0; i < w.length; i++) w[i] -= lr * (g[i] + lam * (w[i] - INIT[i])); }
    // 3. guard: don't accept an update that makes held-out past plays worse
    const A = anchorOf(lg); let accepted = true, anchorBase = null, anchorNew = null;
    if (A && A.length) { anchorBase = lossOn(INIT, A); anchorNew = lossOn(w, A); if (anchorNew > anchorBase + 0.002) accepted = false; }
    if (accepted) S.w = w;
    S.games++; S.on = S.games >= 5 && S.preq.corr < S.preq.base;
    S.history.push({ at: new Date().toISOString(), event: meta.event || null, matchup: meta.matchup || null, reads: rows.length, base: +base.toFixed(4), corr: +corr.toFixed(4), accepted,
      anchorBase: anchorBase && +anchorBase.toFixed(4), anchorNew: anchorNew && +anchorNew.toFixed(4), w: S.w.map(v => +v.toFixed(4)) });
    if (S.history.length > 300) S.history.shift();
    save();
    return S.history[S.history.length - 1];
  }
  // the corrected ML probability (or the plain one while the correction hasn't earned its place)
  function correct(lg, s, base) { const S = L(lg); return S.on ? apply(S.w, xOf(s, base)) : base; }
  const raw = (lg, s, base) => apply(L(lg).w, xOf(s, base));
  function summary(lg) { const S = L(lg); return { league: lg, on: S.on, games: S.games, names: NAMES, w: S.w.map(v => +v.toFixed(4)), init: INIT,
    preq: S.preq.n ? { base: +(S.preq.base / S.preq.n).toFixed(4), corr: +(S.preq.corr / S.preq.n).toFixed(4), reads: S.preq.n } : null, history: S.history.slice(-60) }; }
  return { learn, correct, raw, summary };
}
