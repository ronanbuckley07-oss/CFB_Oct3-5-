import { createAutopilot } from '/home/user/cfb_oct3-5-/api/autopilot.mjs';
const now = Date.now(), B = (px) => ({ bids: [{ px: px - 0.01, qty: 900 }], offers: [{ px, qty: 900 }] });
const books = { c15: B(0.56), c25: B(0.52), d35: B(0.45), o44: B(0.50), u44: B(0.50), st: B(0.74), ln: B(0.48), old: B(0.60), chase: B(0.70) };
const pk = (key, event, sel, type, slug, price, model, mid, extra = {}) => ({ key, league: 'nfl', event, matchup: event === '9' ? 'Lions at Panthers' : 'Bills at Jets', sel, type, venue: 'Polymarket US',
  tier: price >= 0.6 ? 'low' : 'medium', price, model, fair: (model + mid) / 2, why: { mid }, trade: { slug, outcome: 'YES' }, status: 'open', at: new Date(now - 20000).toISOString(), ...extra });
const picks = [
  pk('a', '9', 'CAR +1.5', 'spread', 'c15', 0.577, 0.64, 0.555, { teamId: 'car' }),
  pk('b', '9', 'CAR +2.5', 'spread', 'c25', 0.537, 0.60, 0.515, { teamId: 'car' }),
  pk('c', '9', 'DET +3.5 (other side)', 'spread', 'd35', 0.467, 0.53, 0.445, { teamId: 'det' }),
  pk('d', '9', 'Over 44.5', 'total', 'o44', 0.517, 0.58, 0.495, { over: true }),
  pk('e', '9', 'Under 44.5 (other side)', 'total', 'u44', 0.517, 0.58, 0.495, { over: false }),
  pk('f', '8', 'BUF to win', 'moneyline', 'st', 0.755, 0.80, 0.735, { teamId: 'buf', steady: true }),
  pk('g', '8', 'NYJ +7.5 (small edge)', 'spread', 'ln', 0.497, 0.53, 0.475, { teamId: 'nyj', lean: true }),
  pk('h', '8', 'BUF -3.5 (5 min old)', 'spread', 'old', 0.617, 0.68, 0.595, { teamId: 'buf', at: new Date(now - 300000).toISOString() }),
  pk('i', '8', 'BUF -1.5 (price ran away)', 'spread', 'chase', 0.62, 0.70, 0.60, { teamId: 'buf' }),
];
const db = { trades: [], killed: false };
const AP = createAutopilot({ db, save: () => {}, trader: null, api: { picksAll: () => picks, book: async (l, s) => books[s] }, limits: { maxOrder: 10, maxDaily: 50, slip: 0.02 },
  enabledLive: () => false, leading: () => ({ bets: [] }), liveChecks: () => [] });
AP.start({ budget: 50, maxPerBet: 6, stopLoss: 25, risk: 'medium', leagues: ['nfl'], start: new Date(now - 1000).toISOString(), end: new Date(now + 3600e3).toISOString(), mode: 'paper' });
await new Promise(r => setTimeout(r, 1500 + 16000 + 16000));
console.log('bought:'); for (const t of db.trades) console.log(`  ${t.sel.padEnd(10)} ${t.qty} @ ${Math.round(t.avg * 100)}¢  $${t.cost}  (${t.src})`);
const got = new Set(db.trades.map(t => t.pick)), names = Object.fromEntries(picks.map(p => [p.key, p.sel]));
console.log('skipped:', picks.filter(p => !got.has(p.key)).map(p => p.sel));
console.log('game 9 exposure $' + db.trades.filter(t => t.event === '9').reduce((a, t) => a + t.cost, 0).toFixed(2), '(cap $12.50)'); process.exit(0);
