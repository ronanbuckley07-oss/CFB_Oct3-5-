import fs from 'node:fs';
const { createPicks } = await import('/home/user/cfb_oct3-5-/api/picks.mjs');
const BK = px => ({ bids: [{ px: px - 0.02, qty: 900 }], offers: [{ px, qty: 900 }] });
let books = {}; const P = createPicks({ api: { nfl: { pmusBook: async s => books[s], kalshiBook: async s => books[s] } }, dir: '/home/user/work/data10' });
const agg = H => { const A = { n: 0, win: 0, tie: 0, marH: new Array(141).fill(0), totH: new Array(151).fill(0), ndH: new Array(151).fill(0), ucH: new Array(151).fill(0), marSum: 0 };
  for (const [m, w] of H) { A.marH[60 + m] += w; A.n += w; if (m > 0) A.win += w; A.marSum += m * w; } A.totH[45] = A.n; A.ndH[24] = A.n; A.ucH[17] = A.n; return A; };
const g = { league: 'nfl', event: '9', title: 'X at Y', slotId: { ND: '1', UNC: '2' }, abbr: { ND: 'X', UNC: 'Y' }, mkFetched: Date.now() - 1000 };
const S = { qtr: 3, secs: 400, nd: 10, unc: 10, poss: 'ND', down: 1, dist: 10, pos: 30 };
const ml = (p, slug) => ({ away: { ask: p + 0.01, bid: p - 0.01, p, trade: { slug, outcome: 'YES' } }, home: { ask: 1 - p + 0.01, bid: 1 - p - 0.01, p: 1 - p, trade: { slug, outcome: 'NO' } } });
// 1. Model and market agree X wins 70%, but the model sees the win as a blowout more often: X -3.5 at 34c, model 45%
let A = agg([[-3, 300], [3, 250], [10, 450]]);
books = { ml: BK(0.71), sp: BK(0.34) };
let mk = { awayId: '1', pmus: { found: true, ...ml(0.70, 'ml'), spreads: [{ side: 'away', by: 3.5, p: 0.33, bid: 0.32, ask: 0.34, slug: 'sp', trade: { slug: 'sp', outcome: 'YES' } }], totals: [] } };
console.log('1. shape edge (should qualify):', (await P.consider(g, A, mk, S)).map(e => `${e.sel} model ${(e.model * 100).toFixed(1)} cost ${(e.cost * 100).toFixed(1)}`));
// 2. Screenshot-like: model thinks X (Detroit) is much better than the market does; market X wins 33%, X trails by 3
A = agg([[-14, 60], [-10, 40], [-6, 150], [-3, 200], [1, 250], [4, 200], [8, 100]]); // raw: X wins 55%, X +9.5 ~ 94%
books = { ml: BK(0.34), s95: BK(0.86), s65: BK(0.77) };
mk = { awayId: '1', pmus: { found: true, ...ml(0.33, 'ml'), spreads: [{ side: 'away', by: -9.5, p: 0.85, bid: 0.84, ask: 0.86, slug: 's95', trade: { slug: 's95', outcome: 'YES' } },
  { side: 'away', by: -6.5, p: 0.76, bid: 0.75, ask: 0.77, slug: 's65', trade: { slug: 's65', outcome: 'YES' } }], totals: [] } };
const raw = P.contracts(g, A, mk, false).filter(e => e.type === 'spread' && e.slot === 'ND').map(e => `${e.sel} raw ${(e.model * 100).toFixed(1)}`);
const anch = P.contracts(g, A, mk, true).filter(e => e.type === 'spread' && e.slot === 'ND').map(e => `${e.sel} anchored ${(e.model * 100).toFixed(1)} (shift ${e.anchorShift})`);
console.log('2. ladder raw:', raw, '\n   anchored:', anch);
console.log('   bets now:', (await P.consider({ ...g, event: '10' }, A, mk, S)).map(e => e.sel), '| small edges:', (await P.considerLeans({ ...g, event: '10' }, A, mk, S)).map(e => e.sel));
process.exit(0);
