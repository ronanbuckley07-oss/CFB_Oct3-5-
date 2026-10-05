import { createAutopilot } from '/home/user/cfb_oct3-5-/api/autopilot.mjs';
const now = Date.now(); let books = { spA: { bids: [{ px: 0.55, qty: 500 }], offers: [{ px: 0.56, qty: 500 }] }, spB: { bids: [{ px: 0.47, qty: 500 }], offers: [{ px: 0.48, qty: 500 }] },
  gap: { bids: [{ px: 0.47, qty: 500 }], offers: [{ px: 0.48, qty: 500 }] }, st: { bids: [{ px: 0.73, qty: 500 }], offers: [{ px: 0.74, qty: 500 }] } };
const bet = (event, sel, slug, model, mid, tier) => ({ league: 'nfl', event, matchup: 'Lions at Panthers', sel, type: 'spread', venue: 'Polymarket US', tier, model, mid, fair: (model + mid) / 2, fairEdge: 0.04,
  trade: { slug, outcome: 'YES' }, book: { at: Date.now() } });
const leading = () => ({ bets: [bet('9', 'CAR +1.5', 'spA', 0.64, 0.563, 'medium'), bet('9', 'CAR −1.5', 'spB', 0.55, 0.478, 'medium'), bet('7', 'BUF −3.5 (14.6-pt gap)', 'gap', 0.624, 0.478, 'medium')] });
const picks = [{ steady: true, status: 'open', venue: 'Polymarket US', league: 'nfl', event: '8', matchup: 'Bills at Jets', sel: 'BUF to win', type: 'moneyline', teamId: '2', model: 0.80, price: 0.755, fair: 0.775, why: { mid: 0.735 }, trade: { slug: 'st', outcome: 'YES' }, at: new Date().toISOString() }];
const db = { trades: [], killed: false }; const logs = [];
const AP = createAutopilot({ db, save: () => {}, trader: null, api: { picksAll: () => picks, book: async (l, s) => books[s] }, limits: { maxOrder: 10, maxDaily: 50, slip: 0.02 },
  enabledLive: () => false, leading, liveChecks: () => [] });
AP.start({ budget: 50, maxPerBet: 6, stopLoss: 25, risk: 'medium', leagues: ['nfl'], start: new Date(now - 1000).toISOString(), end: new Date(now + 3600e3).toISOString(), mode: 'paper' });
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(1500); await wait(31000); await wait(31000); // three ticks (one buy per tick)
console.log('trades:', db.trades.map(t => `${t.sel} ${t.qty}@${t.avg} $${t.cost} ${t.status}${t.steady ? ' (steady)' : ''}`));
books.st = { bids: [{ px: 0.91, qty: 500 }], offers: [{ px: 0.92, qty: 500 }] }; await wait(31000);
console.log('after price hits 91c:', db.trades.map(t => `${t.sel} ${t.status} pl=${t.pl ?? '-'}`));
console.log('log:', AP.state().run.log.map(l => l.msg).reverse());
console.log('stats', JSON.stringify(AP.state().run.stats)); process.exit(0);
