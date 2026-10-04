// Trading backtest. For sampled snaps from past games, simulates the rest of the game from that exact spot and compares the
// model's home win probability with the price a bettor could have traded at, then asks: if you bet whichever side the model
// liked by at least T points, how often did it win and did it make money after costs?
//   node scripts/trading_study.mjs run  [tables.json] [first_season]   -> sims every snap, writes sim/study_raw.json
//   node scripts/trading_study.mjs fit                                 -> picks thresholds, writes sim/trading.json
// Use tables trained only on seasons before the study seasons (MAX_SEASON in train.py) so the test is out of sample.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../sim/engine.mjs';
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sim');
const mode = process.argv[2] || 'run';
const COST = 0.02; // paying the ask plus exchange fees, in probability points
if (mode === 'run') {
  const D = JSON.parse(fs.readFileSync(process.argv[3] || path.join(HERE, 'data.json'), 'utf8')); E.setData(D);
  const first = +(process.argv[4] || 2023), N = +process.env.STUDY_N || 1500;
  const snaps = JSON.parse(fs.readFileSync(path.join(HERE, 'snaps.json'), 'utf8')).filter(s => s[1] >= first);
  const outFile = path.join(HERE, 'study_raw.json');
  const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : [];
  const t0 = Date.now();
  for (let i = out.length; i < snaps.length; i++) {
    const [gid, season, post, poss, pos, down, dist, qtr, secs, a, b, toA, toB, h2, vwp, spread, total, y] = snaps[i];
    const S = E.prepS0({ poss, pos, down, dist, qtr, secs, a, b, toA, toB, half2Recv: h2, post: !!post, neutral: true }, spread, total, D.cal);
    const A = E.runBatch(S, N, null, false);
    out.push([gid, season, qtr, +((A.win + 0.5 * A.tie) / A.n).toFixed(4), vwp, y, a - b, spread]);
    if (i % 200 === 0) { fs.writeFileSync(outFile, JSON.stringify(out)); console.log(i, snaps.length, ((Date.now() - t0) / 1000).toFixed(0) + 's'); }
  }
  fs.writeFileSync(outFile, JSON.stringify(out)); console.log('done', out.length);
} else {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'study_raw.json'), 'utf8'));
  const rows = raw.map(([gid, season, qtr, m, p, y]) => ({ gid, season, qtr, m, p, y }));
  // One bet per game: the first snap where the edge clears T, the same rule the live site uses
  function bets(set, T, lo = 0.1, hi = 0.9) {
    const seen = new Set(), out = [];
    for (const r of set) {
      if (seen.has(r.gid)) continue;
      for (const side of ['home', 'away']) {
        const mp = side === 'home' ? r.m : 1 - r.m, price = (side === 'home' ? r.p : 1 - r.p) + COST, win = side === 'home' ? r.y : 1 - r.y;
        if (price < lo || price > hi) continue;
        if (mp - price >= T) { seen.add(r.gid); out.push({ gid: r.gid, mp, price, win, pl: win - price, roi: (win - price) / price }); break; }
      }
    }
    return out;
  }
  function stats(b) {
    if (!b.length) return { n: 0 };
    const n = b.length, hit = b.reduce((s, x) => s + x.win, 0) / n, roi = b.reduce((s, x) => s + x.pl, 0) / b.reduce((s, x) => s + x.price, 0);
    const exp = b.reduce((s, x) => s + x.mp, 0) / n, px = b.reduce((s, x) => s + x.price, 0) / n;
    // bootstrap the return on money staked
    const R = []; for (let k = 0; k < 2000; k++) { let pl = 0, st = 0; for (let j = 0; j < n; j++) { const x = b[(Math.random() * n) | 0]; pl += x.pl; st += x.price; } R.push(pl / st); }
    R.sort((a, b) => a - b);
    return { n, hit: +hit.toFixed(3), modelSaid: +exp.toFixed(3), avgPrice: +px.toFixed(3), roi: +roi.toFixed(3), roiLo: +R[50].toFixed(3), roiHi: +R[1949].toFixed(3), pProfit: +(R.filter(r => r > 0).length / R.length).toFixed(3) };
  }
  const order = (a, b) => a.gid < b.gid ? -1 : a.gid > b.gid ? 1 : 0;
  rows.sort(order); // snaps are already in game order within each game
  const fitSet = rows.filter(r => r.season <= 2024), testSet = rows.filter(r => r.season >= 2025);
  const Ts = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15];
  const table = Ts.map(T => ({ T, fit: stats(bets(fitSet, T)), test: stats(bets(testSet, T)), all: stats(bets(rows, T)) }));
  for (const r of table) console.log(`T ${r.T}: fit ${JSON.stringify(r.fit)}\n        test ${JSON.stringify(r.test)}`);
  // Calibration of the model vs. the stand-in price on all snaps, by bucket
  const cal = []; for (let b = 0; b < 10; b++) { const s = rows.filter(r => Math.min(9, Math.floor(r.m * 10)) === b); if (s.length) cal.push({ b, n: s.length, model: +(s.reduce((x, r) => x + r.m, 0) / s.length).toFixed(3), price: +(s.reduce((x, r) => x + r.p, 0) / s.length).toFixed(3), won: +(s.reduce((x, r) => x + r.y, 0) / s.length).toFixed(3) }); }
  const brier = k => rows.reduce((s, r) => s + (r[k] - r.y) ** 2, 0) / rows.length;
  // Pick the threshold whose worst plausible fit-period return (5th percentile of the bootstrap) was best, with 40+ bets.
  // Seasons 2025 on are never used to choose; they are the test.
  const cands = table.filter(r => r.fit.n >= 40).sort((a, b) => b.fit.roiLo - a.fit.roiLo);
  const pick = cands.length && cands[0].fit.roiLo > 0 ? cands[0] : null;
  const res = { cost: COST, seasons: [...new Set(rows.map(r => r.season))], snaps: rows.length, games: new Set(rows.map(r => r.gid)).size,
    brier: { model: +brier('m').toFixed(4), price: +brier('p').toFixed(4) }, calibration: cal, table, threshold: pick ? pick.T : null,
    chosen: pick, priceRange: [0.1, 0.9], at: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(path.join(HERE, 'trading.json'), JSON.stringify(res, null, 1));
  console.log('brier', res.brier, 'threshold', res.threshold);
}
