// Replays the live bet rules (api/picks.mjs) on the 2025-26 NFL holdout.
// Market = nflfastR's Vegas home WP (moneyline); spread/total ladders priced by a normal model anchored to it.
import fs from 'node:fs';
const S = JSON.parse(fs.readFileSync('holdout_snaps.json', 'utf8'));
const O = JSON.parse(fs.readFileSync(process.argv[2] || 'holdout_out.json', 'utf8'));
const TH = 0.0695, fee = p => TH * p * (1 - p);
const TIERS = { low: { min: 0.60, fe: 0.025 }, medium: { min: 0.35, fe: 0.03 }, high: { min: 0.10, fe: 0.04 } };
const tierOf = c => c >= 0.60 ? 'low' : c >= 0.35 ? 'medium' : c >= 0.10 ? 'high' : null;
const inWindow = s => (s.qtr === 3 && s.secs <= 450) || (s.qtr === 4 && s.secs >= 480);
const Phi = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const iPhi = p => { let lo = -8, hi = 8; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const SPREADS = [1.5, 3.5, 4.5, 6.5, 7.5, 9.5, 10.5, 13.5, 14.5, 17.5, 20.5];

// Every contract on the board at one snap: {type, model, mid, y (did it win), team}
function board(s, o, ladders) {
  const tl = (4 - Math.min(4, s.qtr)) * 900 + s.secs, f = Math.max(tl / 3600, 0.002);
  const hm = s.hf - s.af, tot = s.hf + s.af, out = [];
  out.push({ type: 'ml', sel: s.home + ' ML', team: s.home, model: o.w, mid: s.v, y: hm > 0 ? 1 : hm < 0 ? 0 : null });
  out.push({ type: 'ml', sel: s.away + ' ML', team: s.away, model: 1 - o.w, mid: 1 - s.v, y: hm < 0 ? 1 : hm > 0 ? 0 : null });
  if (!ladders) return out;
  const sd = 13.1 * Math.sqrt(f), mu = sd * iPhi(Math.min(0.999, Math.max(0.001, s.v)));
  for (const X of SPREADS) for (const side of [1, -1]) {
    // "side wins by more than X": home side uses P(margin > X), away uses P(margin < -X)
    const mk = side === 1 ? Phi((mu - X) / sd) : Phi((-X - mu) / sd);
    const mdl = side === 1 ? o.mg[Math.floor(X) + 40] : 1 - o.mg[Math.ceil(-X) + 40 - 1];
    const y = side * hm > X ? 1 : 0;
    const team = side === 1 ? s.home : s.away;
    out.push({ type: 'spread', sel: `${team} -${X}`, team, model: mdl, mid: mk, y });
    out.push({ type: 'spread', sel: `${team === s.home ? s.away : s.home} +${X}`, team: team === s.home ? s.away : s.home, model: 1 - mdl, mid: 1 - mk, y: 1 - y });
  }
  if (!board.totals) return out; // the normal-model totals proxy is miscalibrated (see calib.mjs), so totals are left out
  const muT = s.nd + s.unc + s.totalLine * f, sdT = 13.2 * Math.sqrt(f);
  for (let d = -10.5; d <= 10.5; d += 3) {
    const t = Math.round(muT + d) + 0.5; if (t < 21 || t > 79) continue;
    const mk = Phi((muT - t) / sdT), mdl = o.tt[Math.floor(t) - 20];
    out.push({ type: 'total', sel: `Over ${t}`, team: null, model: mdl, mid: mk, y: tot > t ? 1 : 0 });
    out.push({ type: 'total', sel: `Under ${t}`, team: null, model: 1 - mdl, mid: 1 - mk, y: tot < t ? 1 : 0 });
  }
  return out;
}
// The live filter: cost is the ask (mid + half spread, rounded up to a cent, plus slippage) plus the taker fee
function qualify(c, cfg) {
  const half = c.type === 'ml' ? cfg.hML : cfg.hLad;
  const ask = Math.min(0.99, Math.ceil((c.mid + half + cfg.slip) * 100 - 1e-9) / 100);
  const cost = ask + fee(ask), edge = c.model - cost, fair = cfg.w * c.model + (1 - cfg.w) * c.mid, fairEdge = fair - cost, tier = tierOf(cost);
  if (!tier || c.y == null || cost >= 0.95 || !(c.model > 0.03 && c.model < 0.97) || edge > 0.20) return null;
  if (fairEdge < (cfg.fe?.[tier] ?? TIERS[tier].fe)) return null;
  return { ...c, ask, cost, edge, fair, fairEdge, tier };
}
export function bets(cfg) {
  const byG = new Map(); S.forEach((s, i) => { if (O[i]) { if (!byG.has(s.g)) byG.set(s.g, []); byG.get(s.g).push([s, O[i]]); } });
  const out = [];
  for (const [g, L] of byG) {
    const done = {};
    for (const [s, o] of L) {
      if (!(cfg.when || inWindow)(s)) continue;
      const list = board(s, o, cfg.ladders).map(c => qualify(c, cfg)).filter(Boolean).sort((a, b) => b.fairEdge - a.fairEdge);
      for (const t of Object.keys(TIERS)) {
        if (done[t]) continue; const b = list.find(e => e.tier === t); if (!b) continue;
        done[t] = 1; out.push({ ...b, g, season: s.season, week: s.week, clock: `Q${s.qtr} ${Math.floor(s.secs / 60)}:${String(s.secs % 60).padStart(2, '0')}`, home: s.home, away: s.away });
      }
    }
  }
  return out;
}
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
export function stats(B) {
  if (!B.length) return { n: 0 };
  const n = B.length, st = B.reduce((a, b) => a + b.cost, 0), pl = B.reduce((a, b) => a + (b.y - b.cost), 0);
  const games = [...new Set(B.map(b => b.g))], byG = {}; for (const b of B) (byG[b.g] = byG[b.g] || []).push(b);
  const R = []; for (let k = 0; k < 4000; k++) { let p = 0, c = 0; for (let j = 0; j < games.length; j++) for (const b of byG[games[(rnd() * games.length) | 0]]) { p += b.y - b.cost; c += b.cost; } R.push(c ? p / c : 0); }
  R.sort((a, b) => a - b);
  const avg = k => B.reduce((a, b) => a + b[k], 0) / n;
  return { n, hit: +avg('y').toFixed(3), market: +avg('mid').toFixed(3), fair: +avg('fair').toFixed(3), model: +avg('model').toFixed(3), cost: +avg('cost').toFixed(3),
    roi: +(pl / st).toFixed(3), lo: +R[100].toFixed(3), hi: +R[3899].toFixed(3), pProfit: +(R.filter(r => r > 0).length / R.length).toFixed(3) };
}
export const BASE = { hML: 0.01, hLad: 0.02, slip: 0, w: 0.5, ladders: false };
export { S, O, board, qualify, TIERS };

if (process.argv[1].endsWith('analyze.mjs')) {
  const row = (lab, B) => { const r = {}; for (const t of ['all', 'low', 'medium', 'high']) r[t] = stats(t === 'all' ? B : B.filter(b => b.tier === t)); console.log(lab, JSON.stringify(r)); };
  console.log('snaps simulated', Object.keys(O).length);
  for (const lad of [false, true]) {
    console.log(`\n=== ${lad ? 'moneyline + spread/total ladders' : 'moneyline only'} ===`);
    for (const [lab, c] of [['frictionless (ask=mid, fee only)', { hML: 0, hLad: 0, slip: 0 }], ['base (1c ML / 2c ladder half-spread)', {}], ['+1c slippage', { slip: 0.01 }], ['+2c slippage', { slip: 0.02 }], ['wide (2c/4c) +1c', { hML: 0.02, hLad: 0.04, slip: 0.01 }]])
      row(lab, bets({ ...BASE, ...c, ladders: lad }));
  }
}
