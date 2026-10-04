// Fits the constants that turn a point spread and an over/under into engine settings, then writes them into sim/data.json.
// For a grid of lines, it searches for the strength edge and scoring tilt whose kickoff sims average exactly that margin and
// total (overtime included), then fits the simple formulas prepS0() uses. Run after scripts/train.py:  node scripts/calibrate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../sim/engine.mjs';
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sim', 'data.json');
const D = JSON.parse(fs.readFileSync(FILE, 'utf8'));
E.setData(D); E.seedRng(12345);
const N = +process.env.CAL_N || 12000;
const K0 = { poss: 'B', pos: 30, down: 1, dist: 10, qtr: 1, secs: 900, a: 0, b: 0, half2Recv: 'A', toA: 3, toB: 3, neutral: true };
function measure(edge, tilt, esd) {
  const st = Object.assign({}, K0, { edge, tilt, esd, spread: 0, total: 0 });
  // half the sims with each team receiving the opening kickoff
  const A = E.mergeAgg(E.runBatch(st, N / 2, null, false), E.runBatch(Object.assign({}, st, { poss: 'A', half2Recv: 'B' }), N / 2, null, false));
  let t = 0, m2 = 0; A.totH.forEach((c, i) => t += c * i); A.marH.forEach((c, i) => m2 += c * (i - E.MOFF) ** 2);
  const mar = A.marSum / A.n; return { mar, tot: t / A.n, sd: Math.sqrt(m2 / A.n - mar * mar), tie: A.tie / A.n, ot: A.ot / A.n };
}
const ESD = 5; // strength uncertainty in points, refit below
const rows = [];
for (const sp of [0, 3, 6.5, 10, 14]) for (const tot of [37, 43, 49, 54]) {
  let edge = sp * 1.25, tilt = (40 - tot) / 40, r;
  for (let it = 0; it < 7; it++) {
    r = measure(edge, tilt, ESD * (edge / Math.max(1, sp) || 1.25));
    edge += (sp - r.mar) * 1.2; tilt += (r.tot - tot) / 45;
    tilt = Math.max(-0.6, Math.min(0.8, tilt));
  }
  rows.push({ sp, tot, edge, tilt, ...r });
  console.log(`spread ${sp} total ${tot}: edge ${edge.toFixed(2)} tilt ${tilt.toFixed(3)} -> margin ${r.mar.toFixed(2)} total ${r.tot.toFixed(1)} sd ${r.sd.toFixed(1)} ot ${(r.ot * 100).toFixed(1)}% tie ${(r.tie * 100).toFixed(2)}%`);
}
// tilt = (a + b|spread| - total) / c  -> linear regression tilt ~ x0 + x1|sp| + x2 tot
function lsq(X, y) { const n = X[0].length, A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  X.forEach((x, i) => { for (let j = 0; j < n; j++) { b[j] += x[j] * y[i]; for (let k = 0; k < n; k++) A[j][k] += x[j] * x[k]; } });
  for (let i = 0; i < n; i++) { let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r; [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = 0; r < n; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let k = i; k < n; k++) A[r][k] -= f * A[i][k]; b[r] -= f * b[i]; } }
  return b.map((v, i) => v / A[i][i]); }
const [x0, x1, x2] = lsq(rows.map(r => [1, r.sp, r.tot]), rows.map(r => r.tilt));
const c = -1 / x2, a = x0 * c, b = x1 * c;
const ks = rows.filter(r => r.sp > 0).map(r => r.edge / (r.sp * (1 + 0.6 * Math.abs(r.tilt))));
const k = ks.reduce((s, v) => s + v, 0) / ks.length;
// Strength uncertainty: pick the esd whose pregame margin spread matches real NFL games around the closing line
const target = D.meta.marginSD || 13;
let esd = ESD;
for (let it = 0; it < 6; it++) {
  const cal = { a, b, c, k, esd }; const s0 = E.prepS0(K0, 3, 44, cal); const r = measure(s0.edge, s0.tilt, s0.esd);
  esd = Math.sqrt(Math.max(1, esd * esd + (target * target - r.sd * r.sd))); console.log('esd', esd.toFixed(2), 'sd', r.sd.toFixed(2));
}
D.cal = { a: +a.toFixed(3), b: +b.toFixed(4), c: +c.toFixed(3), k: +k.toFixed(4), esd: +esd.toFixed(2) };
// check
for (const [sp, tot] of [[0, 44], [3, 47.5], [7, 41], [13.5, 50]]) { const s0 = E.prepS0(K0, sp, tot, D.cal); const r = measure(s0.edge, s0.tilt, s0.esd);
  console.log(`check ${sp}/${tot}: margin ${r.mar.toFixed(2)} total ${r.tot.toFixed(1)} sd ${r.sd.toFixed(1)}`); }
fs.writeFileSync(FILE, JSON.stringify(D));
console.log('cal', D.cal);
