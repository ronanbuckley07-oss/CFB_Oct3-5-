import { createAutopilot } from '/home/user/cfb_oct3-5-/api/autopilot.mjs';
import { createPmusTrader } from '/home/user/cfb_oct3-5-/api/pmus.mjs';
const real = createPmusTrader({ keyId: 'test', secret: Buffer.alloc(32, 7).toString('base64') }); // only to use its order builder
const now = Date.now(), B = (bid, ask, q = 900) => ({ bids: [{ px: bid, qty: q }], offers: [{ px: ask, qty: q }] });
const books = { st: B(0.73, 0.74), spA: B(0.55, 0.56), g8: B(0.50, 0.51) };
const sent = []; let mode = 'fill';
const trader = { place: async o => { const body = real.orderBody(o); sent.push({ o, body });
    if (mode === 'error') throw new Error('Polymarket US 500: test error');
    const bk = books[o.slug]; const yesPx = body.intent === 'ORDER_INTENT_BUY_LONG' ? bk.offers[0].px : bk.bids[0].px; // fill at the touch
    const ok = body.intent === 'ORDER_INTENT_BUY_LONG' ? yesPx <= +body.price.value : yesPx >= +body.price.value;
    const shares = mode === 'half' ? Math.ceil(o.qty / 2) : o.qty;
    return { id: 'ord' + sent.length, executions: ok ? [{ type: 'EXECUTION_TYPE_FILL', lastShares: String(shares), lastPx: { value: String(yesPx) }, commissionNotionalCollected: { value: '0.01' } }] : [] }; } };
const pk = (key, event, sel, slug, price, model, mid, extra = {}) => ({ key, league: 'nfl', event, matchup: event === '9' ? 'Lions at Panthers' : 'Bills at Jets', sel, type: 'spread', venue: 'Polymarket US',
  tier: price >= 0.6 ? 'low' : 'medium', price, model, fair: (model + mid) / 2, why: { mid }, trade: { slug, outcome: 'YES' }, status: 'open', at: new Date(now - 10000).toISOString(), teamId: 'x' + key, ...extra });
const picks = [pk('s', '9', 'CAR to win (steady)', 'st', 0.755, 0.80, 0.735, { type: 'moneyline', steady: true, teamId: 'car' }),
  pk('a', '9', 'CAR +1.5', 'spA', 0.577, 0.65, 0.555, { teamId: 'car' }), pk('b', '8', 'BUF −2.5 (other game)', 'g8', 0.517, 0.58, 0.495), pk('c', '9', 'CAR −3.5 (book errors)', 'bad', 0.5, 0.56, 0.49, { teamId: 'car' })];
const db = { trades: [], killed: false };
const AP = createAutopilot({ db, save: () => {}, trader, api: { picksAll: () => picks, book: async (l, s) => { if (!books[s]) throw new Error('book down'); return books[s]; } },
  limits: { maxOrder: 10, maxDaily: 50, slip: 0.02 }, enabledLive: () => true, leading: () => ({ bets: [] }), liveChecks: () => [] });
AP.start({ budget: 5, maxPerBet: 5, stopLoss: 5, risk: 'medium', leagues: ['nfl'], start: new Date(now - 1000).toISOString(), end: new Date(now + 3600e3).toISOString(), mode: 'live', takeProfit: 30, stopLossPct: 40, oneGame: true });
const wait = ms => new Promise(r => setTimeout(r, ms)), show = l => console.log(l, db.trades.map(t => `${t.sel}: ${t.qty}sh $${t.cost} ${t.status}${t.exit ? ' [' + t.exit + ']' : ''}${t.pl != null ? ' pl ' + t.pl : ''}`));
await wait(1500); show('after first check:');
console.log('  orders:', sent.map(x => `${x.body.intent} ${x.o.qty} @ YES ${x.body.price.value}`));
// CAR +1.5 rallies (sell for +30%+), steady drops 40%+... and the sale only half fills
books.spA = B(0.80, 0.81); books.st = B(0.40, 0.41); mode = 'half'; sent.length = 0;
await wait(15500); show('after prices move (half fills):');
console.log('  sell orders:', sent.map(x => `${x.body.intent} ${x.o.qty} @ YES ${x.body.price.value} (holding ${x.o.outcome === 'NO' ? 'YES → sell' : 'NO → buy back'})`));
mode = 'fill'; await wait(31000); show('after the rest sells:');
console.log('  run:', AP.state().run.status, AP.state().run.reason || '', '| stats', JSON.stringify(AP.state().run.stats));
console.log('  log:\n   ' + AP.state().run.log.map(l => l.msg).reverse().join('\n   '));
process.exit(0);
