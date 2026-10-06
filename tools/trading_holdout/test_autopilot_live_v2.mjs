import { createAutopilot, clampConfig } from '/home/user/cfb_oct3-5-/api/autopilot.mjs';
import { createPmusTrader } from '/home/user/cfb_oct3-5-/api/pmus.mjs';
const real = createPmusTrader({ keyId: 'test', secret: Buffer.alloc(32, 7).toString('base64') });
console.log('order body:', JSON.stringify(real.orderBody({ slug: 'm', outcome: 'YES', qty: 3, limitYesPx: 0.76, auto: true })));
try { real.orderBody({ slug: 'm', outcome: 'NO', qty: 1, limitYesPx: 0.4 }); } catch (e) { console.log('NO order:', e.message); }
const now = Date.now(), B = (bid, ask) => ({ bids: [{ px: bid, qty: 900 }], offers: [{ px: ask, qty: 900 }] });
const books = { st: B(0.73, 0.74), md: B(0.55, 0.56), stno: B(0.25, 0.26) }; const orders = {}; const calls = [];
const trader = {
  place: async o => { const body = real.orderBody(o); calls.push(['place', body.intent, body.quantity, body.price.value, body.manualOrderIndicator]);
    const id = 'o' + calls.length; orders[id] = { cumQuantity: String(body.quantity), avgPx: { value: String(books[o.slug].offers[0].px) }, state: 'ORDER_STATE_FILLED', commissionNotionalTotalCollected: { value: '0.05' } };
    return { id }; }, // no executions in the reply: the fill must be read back
  order: async id => ({ order: orders[id] }),
  closePosition: async p => { calls.push(['close', p.marketSlug, p.slippageTolerance && p.slippageTolerance.currentPrice.value, p.slippageTolerance && p.slippageTolerance.bips]);
    return { id: 'c', executions: [{ type: 'EXECUTION_TYPE_FILL', lastShares: '13', lastPx: { value: String(books.st.bids[0].px) }, commissionNotionalCollected: { value: '0.05' } }] }; } };
const pk = (key, sel, slug, price, model, mid, extra = {}) => ({ key, league: 'nfl', event: '9', matchup: 'Lions at Panthers', sel, type: 'moneyline', venue: 'Polymarket US', tier: 'low', price, model, fair: (model + mid) / 2, why: { mid },
  trade: { slug, outcome: 'YES' }, status: 'open', at: new Date(now - 10000).toISOString(), teamId: 'car', ...extra });
const picks = [pk('s', 'CAR to win (steady)', 'st', 0.755, 0.80, 0.735, { steady: true }), pk('m', 'CAR −1.5 (model pick)', 'md', 0.577, 0.65, 0.555, { type: 'spread' }),
  pk('n', 'DET to win (steady, No side)', 'stno', 0.755, 0.80, 0.735, { steady: true, teamId: 'det', trade: { slug: 'stno', outcome: 'NO' } })];
const db = { trades: [], killed: false };
const AP = createAutopilot({ db, save: () => {}, trader, api: { picksAll: () => picks, book: async (l, s) => books[s] }, limits: { maxOrder: 10, maxDaily: 50, slip: 0.02 },
  enabledLive: () => true, leading: () => ({ bets: [] }), liveChecks: () => [] });
const cfg = clampConfig({ budget: 10, maxPerBet: 10, stopLoss: 10, risk: 'medium', leagues: ['nfl'], start: new Date(now - 1000).toISOString(), end: new Date(now + 3600e3).toISOString(), mode: 'live', takeProfit: 15, oneGame: true }, { maxOrder: 10, maxDaily: 50 }, true);
console.log('config:', JSON.stringify({ steadyOnly: cfg.steadyOnly, maxPerBet: cfg.maxPerBet, takeProfit: cfg.takeProfit, oneGame: cfg.oneGame }));
AP.start(cfg); const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(4000); console.log('trades:', db.trades.map(t => `${t.sel} ${t.qty}sh @${t.avg} $${t.cost} ${t.status}`));
books.st = B(0.88, 0.89); await wait(16000);
console.log('after rise:', db.trades.map(t => `${t.sel} ${t.status} pl ${t.pl}`)); console.log('calls:', JSON.stringify(calls));
console.log('log:\n  ' + AP.state().run.log.map(l => l.msg).reverse().join('\n  ')); process.exit(0);
