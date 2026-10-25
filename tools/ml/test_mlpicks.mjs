// The ML system's bets and the agreement tag, with fake order books.  node tools/ml/test_mlpicks.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert';
const { createPicks } = await import('../../api/picks.mjs');
const { clampConfig } = await import('../../api/autopilot.mjs');
const BK = px => ({ bids: [{ px: px - 0.02, qty: 900 }], offers: [{ px, qty: 900 }] });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-'));
let books = {}; const P = createPicks({ api: { nfl: { pmusBook: async s => books[s], kalshiBook: async s => books[s] } }, dir });
const agg = (H, ml) => { const A = { n: 0, win: 0, tie: 0, marH: new Array(141).fill(0), totH: new Array(151).fill(0), ndH: new Array(151).fill(0), ucH: new Array(151).fill(0), marSum: 0, ml };
  for (const [m, w] of H) { A.marH[60 + m] += w; A.n += w; if (m > 0) A.win += w; A.marSum += m * w; } A.totH[45] = A.n; A.ndH[24] = A.n; A.ucH[17] = A.n; return A; };
const g = { league: 'nfl', event: '21', title: 'X at Y', slotId: { ND: '1', UNC: '2' }, abbr: { ND: 'X', UNC: 'Y' }, mkFetched: Date.now() - 1000, homeSlot: 'UNC' };
const mkOf = (p, slug) => ({ awayId: '1', pmus: { found: true, away: { ask: p + 0.01, bid: p - 0.01, p, trade: { slug, outcome: 'YES' } }, home: { ask: 1 - p + 0.01, bid: 1 - p - 0.01, p: 1 - p, trade: { slug, outcome: 'NO' } }, spreads: [], totals: [] } });
const S = { qtr: 3, secs: 400, nd: 17, unc: 10, poss: 'ND', down: 1, dist: 10, pos: 30 };

// 1. Monte Carlo says X 80% (market 80%): no Monte Carlo edge. ML says X 89.5%: ML fair (89.5+80)/2 = 84.75 vs cost ~82.1
//    (81c ask + fee) -> an edge of 2.65 points, over the 2.5 bar, with ML 9.5 points from the market (under the 10 cap)
let A = agg([[-3, 200], [7, 800]], 0.895); books = { m1: BK(0.81) };
let mk = mkOf(0.80, 'm1');
const ctr = P.contracts(g, A, mk).find(e => e.type === 'moneyline' && e.slot === 'ND');
assert.ok(Math.abs(ctr.ml - 0.895) < 1e-9 && ctr.mlAgrees === true, 'ML attached to the X moneyline, agrees');
assert.equal(P.contracts(g, A, mk).find(e => e.slot === 'UNC').mlAgrees, false, 'and disagrees with the other side');
const mc = await P.consider(g, A, mk, S); assert.equal(mc.length, 0, 'no Monte Carlo bet');
const mlb = await P.mlConsider(g, A, mk, S); assert.equal(mlb.length, 1, 'one ML bet'); assert.equal(mlb[0].sel, 'X to win');
assert.ok(Math.abs(mlb[0].model - 0.895) < 1e-9 && Math.abs(mlb[0].mcModel - 0.8) < 1e-9, 'ML pick carries both models');
let rep = P.report('nfl'); assert.equal(rep.mlSystem.edge.open, 1); assert.equal(rep.open.length, 0, 'ML picks stay out of the Monte Carlo record');
// logged once per contract per game
assert.equal((await P.mlConsider(g, A, mk, S)).length, 1); assert.equal(P.all().filter(p => p.mlSys === 'edge').length, 1, 'not logged twice');
// 2. ML far from the market (>10 pts): no ML bet
assert.equal((await P.mlConsider({ ...g, event: '22' }, agg([[-3, 200], [7, 800]], 0.95), mk, S)).length, 0, 'gap over 10 points is skipped');
// 3. ML steady pick: X leads by 7, priced 75c, ML 80% -> fair 77.5 >= cost ~77; settled play
books = { m3: BK(0.76) }; mk = mkOf(0.75, 'm3');
const st = await P.mlSteadyPick({ ...g, event: '23' }, agg([[3, 200], [10, 800]], 0.80), mk, S, 60000);
assert.ok(st && st.mlSys === 'steady', 'ML steady pick logged');
assert.equal(await P.mlSteadyPick({ ...g, event: '23' }, agg([[3, 200], [10, 800]], 0.80), mk, S, 60000), null, 'one per game');
assert.equal(await P.mlSteadyPick({ ...g, event: '24' }, agg([[3, 200], [10, 800]], 0.80), mk, S, 10000), null, 'waits for a settled play');
// cash-out at 90c includes ML steady picks
const cashed = P.cashOuts({ ...g, event: '23' }, mkOf(0.91, 'm3')); assert.equal(cashed.length, 1, 'ML steady pick cashes out at 90c');
// 4. A Monte Carlo steady pick records that ML disagreed: X leads by 7 at 75c, Monte Carlo 85% (fair 80 >= cost),
//    ML 70% (its fair 72.5 < cost)
books = { m4: BK(0.76) }; mk = mkOf(0.75, 'm4');
const sp = await P.steadyPick({ ...g, event: '25' }, agg([[-3, 150], [7, 850]], 0.70), mk, S, 60000);
assert.ok(sp && sp.steady && sp.mlAgrees === false && sp.ml === 0.7, 'Monte Carlo steady pick tagged: ML disagrees');
const mcPicks = [sp];
rep = P.report('nfl'); assert.ok(rep.agreement && rep.agreement.main && rep.agreement.steady);
// 5. autopilot settings
assert.equal(clampConfig({}, { maxOrder: 10, maxDaily: 50 }).follow, 'mc'); assert.equal(clampConfig({ follow: 'both', mlAgree: 1 }, { maxOrder: 10, maxDaily: 50 }).mlAgree, true);
console.log('ok: ML edge bet, gap check, ML steady + cash-out, agreement tag', mcPicks.length ? '(MC pick tagged)' : '(no MC pick in case 4)', '| autopilot settings');
process.exit(0);
