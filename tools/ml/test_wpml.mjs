// The ML win-probability model and the live grader.  node tools/ml/test_wpml.mjs
import assert from 'node:assert'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadWp, wpAll, wpFeatures, fromEngine } from '../../api/wpml.mjs';
import { createGrader } from '../../api/mlgrade.mjs';
for (const lg of ['cfb', 'nfl']) {
  const m = loadWp(lg); assert.ok(m && m.trees.length > 50 && m.lr, `${lg} model loads`);
  const base = { diff: 0, tl: 1800, posH: 1, ytg: 75, down: 1, dist: 10, toH: 3, toA: 3, spread: 0, total: 50, h2: 0 };
  const p = s => wpAll(m, { ...base, ...s }).ml;
  // sanity: more points ahead, bigger favorite, less time while ahead -> more likely to win
  assert.ok(p({ diff: 7 }) > p({ diff: 0 }) && p({ diff: 0 }) > p({ diff: -7 }), 'lead helps');
  assert.ok(p({ spread: 10 }) > p({ spread: 0 }), 'being favored helps');
  assert.ok(p({ diff: 7, tl: 120 }) > p({ diff: 7, tl: 2400 }), 'a lead is worth more late');
  assert.ok(p({ diff: 0, spread: 0, posH: 1, ytg: 5 }) > p({ diff: 0, spread: 0, posH: -1, ytg: 5 }), 'having the ball near the goal line helps');
  assert.ok(Math.abs(p({ tl: 3600, posH: 1, ytg: 75, spread: 0 }) - 0.5) < 0.12, 'an even game starts near 50%');
  // engine orientation: the same game seen from either slot gives complementary answers
  const S = { qtr: 3, secs: 300, nd: 17, unc: 10, poss: 'ND', pos: 60, down: 2, dist: 5, toND: 2, toUNC: 3, half2Recv: 'UNC', total: 48 };
  const homeND = wpAll(m, fromEngine({ ...S, edge: 3 }, 'ND', 3)).ml, homeUNC = wpAll(m, fromEngine({ ...S, edge: 3 }, 'UNC', 3)).ml;
  assert.ok(homeND > 0.5 && homeUNC < 0.5, 'home-perspective flip');
  console.log(lg, 'ok: up 7 at half', p({ diff: 7 }).toFixed(3), '| up 7, 2 min left', p({ diff: 7, tl: 120 }).toFixed(3), '| 10-pt favorite at kickoff', p({ tl: 3600, spread: 10 }).toFixed(3));
}
// grader: notes per play, grades at the final, scores both systems
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grd-'));
const api = { cfb: async () => new Response(JSON.stringify({ state: 'post', comps: [{ id: '2', homeAway: 'home', abbr: 'H', score: 24 }, { id: '1', homeAway: 'away', abbr: 'A', score: 17 }] })) };
const G = createGrader({ api, dataDir: dir }), g = { league: 'cfb', event: '7', title: 'A at H', homeSlot: 'UNC', slotId: { ND: '1', UNC: '2' } };
G.note(g, { qtr: 1, secs: 800, nd: 0, unc: 0, poss: 'ND', down: 1 }, { mc: 0.40, ml: 0.45, mkt: 0.42 }); // ND (away) 40% -> home 60%
G.note(g, { qtr: 4, secs: 100, nd: 17, unc: 24, poss: 'UNC', down: 1 }, { mc: 0.05, ml: 0.10, mkt: null });
// force the game to look old so it gets graded
const file = path.join(dir, 'mlgrade.json'); G.flush(); const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.games['cfb:7'].at = Date.now() - 3600e3; fs.writeFileSync(file, JSON.stringify(raw));
const G2 = createGrader({ api, dataDir: dir }); await G2.grade(); const s = G2.summary('cfb');
assert.equal(s.games, 1); assert.equal(s.overall.n, 2); assert.ok(s.overall.mc < s.overall.ml, 'Monte Carlo was sharper on this made-up game');
console.log('grader ok:', JSON.stringify(s.overall));
process.exit(0);
