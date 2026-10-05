import fs from 'node:fs';
const t0 = Date.parse('2026-10-05T01:00:00Z'); let k = 0;
const P = (o) => ({ key: 'k' + (k++), league: 'nfl', event: '9', matchup: 'Lions at Panthers', venue: 'Polymarket US', trade: { slug: 's' + k, outcome: 'YES' }, tier: 'low', phase: 'Q3 late', status: 'open', at: new Date(t0 + k * 1000).toISOString(), ...o });
const ladder = [[6.5, 0.77, 0.87, 0.75], [7.5, 0.84, 0.93, 0.83], [8.5, 0.84, 0.94, 0.83], [9.5, 0.86, 0.94, 0.85]].map(([by, price, model, mid]) =>
  P({ sel: `DET +${by}`, type: 'spread', teamId: 'det', by: -by, price, model, fair: (model + mid) / 2, fairEdge: (model + mid) / 2 - price, why: { mid }, clock: 'Q3 6:21', score: 'DET 19, CAR 22' }));
const picks = [...ladder,
  P({ sel: 'CAR −6.5', type: 'spread', teamId: 'car', by: 6.5, price: 0.45, model: 0.65, fair: 0.545, why: { mid: 0.44 }, clock: 'Q3 2:47', score: 'DET 19, CAR 28', tier: 'medium' }),
  P({ event: '5', sel: 'KC −3.5 (gap 12, WON)', type: 'spread', teamId: 'kc', price: 0.5, model: 0.61, why: { mid: 0.49 }, clock: 'Q2 3:00', score: 'x', status: 'won', pl: 0.5, tier: 'medium' }),
  P({ event: '6', sel: 'Over 41.5', type: 'total', over: true, price: 0.52, model: 0.58, why: { mid: 0.51 }, clock: 'Q2 9:00', score: 'y', tier: 'medium' }),
  P({ event: '6', sel: 'Under 44.5 (other side)', type: 'total', over: false, price: 0.5, model: 0.56, why: { mid: 0.49 }, clock: 'Q3 9:00', score: 'z', tier: 'medium' }),
  P({ event: '7', sel: 'NE +3.5 (no fill)', type: 'spread', teamId: 'ne', price: 0.55, model: 0.6, why: { mid: 0.54 }, fill: { qty: 0 }, clock: 'Q3 1:00', score: 'w', tier: 'medium' }),
  P({ event: '8', sel: 'BUF −2.5 (normal, keep)', type: 'spread', teamId: 'buf', price: 0.55, model: 0.6, why: { mid: 0.54 }, clock: 'Q3 5:00', score: 'v', tier: 'medium' }),
  P({ event: '8', sel: 'BUF to win (steady, keep)', type: 'moneyline', teamId: 'buf', steady: true, price: 0.75, model: 0.8, why: { mid: 0.73 }, clock: 'Q3 5:00', score: 'v' }),
  // 30 settled Q3-late spread bets, about break-even
  ...Array.from({ length: 30 }, (_, i) => P({ event: 'f' + i, sel: 'Q3 bet ' + i, type: 'spread', teamId: 'u' + i, price: 0.5, model: 0.55, why: { mid: 0.5 }, phase: 'Q3 late', clock: 'Q3 5:00', score: 'q' + i, tier: 'medium', status: i < 16 ? 'won' : 'lost', pl: i < 16 ? 0.5 : -0.5 })),
  // 30 settled Q1-early bets that mostly lost: the learner should block "Q1 early"
  ...Array.from({ length: 30 }, (_, i) => P({ event: 'e' + i, sel: 'Q1 bet ' + i, type: 'moneyline', teamId: 't' + i, price: 0.5, model: 0.55, why: { mid: 0.5 }, phase: 'Q1 early', clock: 'Q1 10:00', score: 's' + i, tier: 'medium', status: i < 9 ? 'won' : 'lost', pl: i < 9 ? 0.5 : -0.5 })),
];
fs.writeFileSync('data11/picks.json', JSON.stringify({ picks, auto: {} }));
fs.writeFileSync('data11/trades.json', JSON.stringify({ trades: [
  { run: 'r1', mode: 'paper', event: '9', sel: 'CAR +1.5', type: 'spread', teamId: 'car', model: 0.704, fair: 0.633, trust: 0.5, qty: 2, cost: 1.16, status: 'open', at: '2026-10-05T01:44:00Z' },
  { run: 'r1', mode: 'paper', event: '9', sel: 'CAR −1.5', type: 'spread', teamId: 'car', model: 0.624, fair: 0.551, trust: 0.5, qty: 2, cost: 0.98, status: 'open', at: '2026-10-05T01:45:00Z' },
  { run: 'r1', mode: 'paper', event: '3', sel: 'NYG +3.5', type: 'spread', teamId: 'nyg', model: 0.6, fair: 0.57, trust: 0.5, qty: 2, cost: 1.1, status: 'open', at: '2026-10-05T01:50:00Z' }], killed: false }));
const { createPicks } = await import('/home/user/cfb_oct3-5-/api/picks.mjs');
const Pk = createPicks({ api: {}, dir: '/home/user/work/data11' });
const all = Pk.all();
console.log('KEPT:'); for (const p of all.filter(p => p.status !== 'void' && !/^Q[13] bet/.test(p.sel))) console.log('  ', p.sel);
console.log('VOIDED:'); for (const p of all.filter(p => p.status === 'void' && !/^Q[13] bet/.test(p.sel))) console.log('  ', p.sel.padEnd(26), '→', p.voidReason, p.voidedStatus !== 'open' ? `(was ${p.voidedStatus})` : '');
const a = Pk.audit(); console.log('learned blocks:', JSON.stringify(a.learned.blocks));
// a new Q1-early candidate is blocked; a Q3 one isn't
const agg = H => { const A = { n: 0, win: 0, tie: 0, marH: new Array(141).fill(0), totH: new Array(151).fill(0), ndH: new Array(151).fill(0), ucH: new Array(151).fill(0), marSum: 0 };
  for (const [m, w] of H) { A.marH[60 + m] += w; A.n += w; if (m > 0) A.win += w; } A.totH[45] = A.n; return A; };
const A = agg([[-3, 300], [3, 250], [10, 450]]);
const mk = { awayId: '1', pmus: { found: true, away: { ask: 0.71, bid: 0.69, p: 0.70, trade: { slug: 'm', outcome: 'YES' } }, home: { ask: 0.31, bid: 0.29, p: 0.30, trade: { slug: 'm', outcome: 'NO' } },
  spreads: [{ side: 'away', by: 3.5, p: 0.33, bid: 0.32, ask: 0.34, slug: 'sp', trade: { slug: 'sp', outcome: 'YES' } }], totals: [] } };
for (const S of [{ qtr: 1, secs: 600 }, { qtr: 3, secs: 300 }]) console.log(`candidates at Q${S.qtr} ${S.secs}s:`, Pk.edges({ league: 'nfl', event: 'z', slotId: { ND: '1', UNC: '2' }, abbr: { ND: 'X', UNC: 'Y' }, S }, A, mk).map(e => e.sel));
const { createTrading } = await import('/home/user/cfb_oct3-5-/api/trade.mjs');
createTrading({ api: {}, dir: '/home/user/work/data11', leading: () => ({ bets: [] }), picks: Pk });
const tr = JSON.parse(fs.readFileSync('data11/trades.json')).trades; console.log('trades:', tr.map(t => `${t.sel}: ${t.status}${t.voidReason ? ' (' + t.voidReason + ')' : ''}`));
process.exit(0);
