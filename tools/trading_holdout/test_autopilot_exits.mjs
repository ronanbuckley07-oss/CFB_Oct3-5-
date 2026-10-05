import { createAutopilot } from '/home/user/cfb_oct3-5-/api/autopilot.mjs';
import { createPmusTrader } from '/home/user/cfb_oct3-5-/api/pmus.mjs';
const real = createPmusTrader({ keyId: 'test', secret: Buffer.alloc(32, 7).toString('base64') });
const now = Date.now(), B = (bid, ask, q = 900) => ({ bids: [{ px: bid, qty: q }], offers: [{ px: ask, qty: q }] });
const books = { u: B(0.48, 0.49) }; // a NO bet: "Under", bought by selling YES at 0.48 (NO costs 0.52)
const sent = []; let mode = 'fill';
const trader = { place: async o => { const body = real.orderBody(o); sent.push(body); if (mode === 'error') throw new Error('Polymarket US 503: down');
  const bk = books[o.slug], yesPx = body.intent === 'ORDER_INTENT_BUY_LONG' ? bk.offers[0].px : bk.bids[0].px, shares = mode === 'half' ? Math.floor(o.qty / 2) : o.qty;
  return { id: 'x', executions: [{ type: 'EXECUTION_TYPE_FILL', lastShares: String(shares), lastPx: { value: String(yesPx) }, commissionNotionalCollected: { value: '0' } }] }; } };
const picks = [{ key: 'u', league: 'nfl', event: '9', matchup: 'Lions at Panthers', sel: 'Under 44.5', type: 'total', over: false, venue: 'Polymarket US', tier: 'medium', price: 0.537, model: 0.60, fair: 0.56, why: { mid: 0.52 },
  trade: { slug: 'u', outcome: 'NO' }, status: 'open', at: new Date(now - 5000).toISOString() }];
const db = { trades: [], killed: false };
const AP = createAutopilot({ db, save: () => {}, trader, api: { picksAll: () => picks, book: async (l, s) => books[s] }, limits: { maxOrder: 10, maxDaily: 50, slip: 0.02 },
  enabledLive: () => true, leading: () => ({ bets: [] }), liveChecks: () => [] });
AP.start({ budget: 5, maxPerBet: 5, stopLoss: 5, risk: 'high', leagues: ['nfl'], start: new Date(now - 1000).toISOString(), end: new Date(now + 3600e3).toISOString(), mode: 'live', takeProfit: 20, oneGame: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(1500); const t = db.trades[0]; console.log('bought:', t.sel, t.qty, 'sh, cost', t.cost, '| order', sent[0].intent, '@ YES', sent[0].price.value);
// Under is winning: YES (over) drops to 0.30, so NO is worth ~0.70 -> +30%; the buy-back only half fills
books.u = B(0.29, 0.30); mode = 'half'; sent.length = 0; await wait(15500);
console.log('half fill:', db.trades.map(t => `${t.qty}sh ${t.status} cost ${t.cost}${t.pl != null ? ' pl ' + t.pl : ''}`), '| order', sent.map(b => `${b.intent} ${b.quantity} @ YES ${b.price.value}`));
mode = 'fill'; await wait(31000);
console.log('rest:', db.trades.map(t => `${t.qty}sh ${t.status}${t.pl != null ? ' pl ' + t.pl : ''}`));
// order errors: a fresh run in paper? no: live run whose buys all error -> stops after 3
const db2 = { trades: [], killed: false }; mode = 'error';
const picks2 = [1, 2, 3, 4].map(i => ({ ...picks[0], key: 'e' + i, event: 'e' + i, trade: { slug: 'u', outcome: 'NO' }, at: new Date().toISOString() }));
const AP2 = createAutopilot({ db: db2, save: () => {}, trader, api: { picksAll: () => picks2, book: async () => B(0.48, 0.49) }, limits: { maxOrder: 10, maxDaily: 50, slip: 0.02 }, enabledLive: () => true, leading: () => ({ bets: [] }), liveChecks: () => [] });
AP2.start({ budget: 5, maxPerBet: 5, stopLoss: 5, risk: 'high', leagues: ['nfl'], start: new Date(Date.now() - 1000).toISOString(), end: new Date(Date.now() + 3600e3).toISOString(), mode: 'live' });
await wait(1500); console.log('3 errors:', AP2.state().run.status, '-', AP2.state().run.reason);
process.exit(0);
