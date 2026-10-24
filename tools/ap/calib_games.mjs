// How well ratings built from games before week w predict week w winners (FBS games, 2014-2025): log loss and
// calibration for a few spread SDs and prior weights. node tools/ap/calib_games.mjs games.json
import fs from 'node:fs';
import { G, ratings, gameLine } from '../../api/apmodel.mjs';
const games = JSON.parse(fs.readFileSync(process.argv[2] || 'games.json', 'utf8'));
const seasons = [...new Set(games.map(g => g[G.season]))].sort();
for (const [shrink, pw] of [[0.7, 4], [0.8, 4], [0.8, 6], [0.9, 6]]) {
  const priors = {}; for (const s of seasons) { const R = ratings(games.filter(g => g[G.season] === s), { prior: priors[s] || {}, priorWeight: pw }); priors[s + 1] = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v * shrink])); }
  const P = [];
  for (const s of seasons) { if (s < 2014 || s > 2025) continue; const S = games.filter(g => g[G.season] === s);
    for (let w = 1; w <= 15; w++) { const R = ratings(S.filter(g => g[G.week] < w), { prior: priors[s] || {}, priorWeight: pw });
      for (const g of S) if (g[G.week] === w && g[G.hp] != null && g[G.hp] !== g[G.ap] && g[G.hdiv] === 'fbs' && g[G.adiv] === 'fbs') P.push({ m: gameLine(R, g).margin, y: g[G.hp] > g[G.ap] ? 1 : 0, w, err: (g[G.hp] - g[G.ap]) - gameLine(R, g).margin }); } }
  const { Phi } = await import('../../api/apmodel.mjs');
  const out = [11, 12, 13, 14, 15].map(sd => { const ll = P.reduce((a, p) => { const q = Math.min(0.995, Math.max(0.005, Phi(p.m / sd))); return a - (p.y ? Math.log(q) : Math.log(1 - q)); }, 0) / P.length; return `sd${sd}=${ll.toFixed(4)}`; });
  const rmse = Math.sqrt(P.reduce((a, p) => a + p.err ** 2, 0) / P.length), hit = P.filter(p => (p.m > 0) === !!p.y).length / P.length;
  console.log(`shrink ${shrink} priorW ${pw}: games ${P.length} rmse ${rmse.toFixed(2)} picks right ${(hit * 100).toFixed(1)}% logloss ${out.join(' ')}`);
}
