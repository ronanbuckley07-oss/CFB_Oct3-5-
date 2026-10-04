// One-tap trading on Polymarket US, for the site owner only.
//
// Nothing trades on its own. The private /trade page lists the model's current Polymarket US bets with what your
// stake would really buy on the order book. You preview one, then confirm it. Every order is checked against hard
// limits set in Render's environment, uses a limit price (never a market order), and fills immediately or cancels.
//
// Environment (Render > Environment):
//   TRADE_PASSWORD              required to unlock /trade at all
//   POLYMARKET_US_KEY_ID        from polymarket.us/developer (after identity verification)
//   POLYMARKET_US_SECRET_KEY    shown once when you create the key
//   TRADING_ENABLED=true        master switch; anything else means preview only
//   MAX_ORDER_USD=10  MAX_DAILY_USD=50  MAX_OPEN_BETS=5  MAX_SLIPPAGE_CENTS=2  MIN_EDGE=0.05
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { simulateFill, createPmusTrader, takerFee } from './pmus.mjs';
import { gradeBet } from './picks.mjs';

const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);

export function createTrading({ api, dir, leading }) {
  const PASSWORD = env('TRADE_PASSWORD', '');
  const LIMITS = { maxOrder: +env('MAX_ORDER_USD', 10), maxDaily: +env('MAX_DAILY_USD', 50), maxOpen: +env('MAX_OPEN_BETS', 5),
    slip: +env('MAX_SLIPPAGE_CENTS', 2) / 100, minEdge: +env('MIN_FAIR_EDGE', 0.025) };
  const ENABLED = env('TRADING_ENABLED', 'false') === 'true';
  let trader = null; try { trader = createPmusTrader(); } catch (e) { console.error('trade: bad Polymarket US key', e.message); }
  const SECRET = crypto.createHash('sha256').update(`${PASSWORD}:${env('POLYMARKET_US_KEY_ID', '')}:session`).digest();

  const file = path.join(dir, 'trades.json');
  let db = { trades: [], killed: false };
  try { db = Object.assign(db, JSON.parse(readFileSync(file, 'utf8'))); } catch {}
  const save = () => { try { mkdirSync(dir, { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(db)); renameSync(file + '.tmp', file); } catch (e) { console.error('trade: save failed', e.message); } };

  // ---------- auth: one password, an HMAC-signed session cookie, strict same-site ----------
  const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
  const makeToken = (obj) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${sign(b)}`; };
  const readToken = (t) => { if (!t || !t.includes('.')) return null; const [b, s] = t.split('.'); const exp = sign(b);
    if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
    try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; } };
  const cookie = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(x => x[0]));
  const authed = req => !!readToken(cookie(req).tsess);
  const fails = new Map();

  // ---------- money bookkeeping ----------
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const spentToday = () => db.trades.filter(t => t.day === today() && t.qty > 0).reduce((a, t) => a + t.cost, 0);
  const openBets = () => db.trades.filter(t => t.qty > 0 && t.status === 'open').length;

  async function opportunities() {
    const L = leading('all').bets.filter(b => b.venue === 'Polymarket US' && b.trade && (b.fairEdge ?? 0) >= LIMITS.minEdge);
    const out = [];
    for (const b of L.slice(0, 12)) {
      try {
        const bk = await api[b.league].pmusBook(b.trade.slug), f = simulateFill(bk, b.trade.outcome, LIMITS.maxOrder);
        const ev = f.qty ? (b.fair ?? b.model) * f.qty - f.cost : null;
        out.push({ ...b, fill: f.qty ? { qty: f.qty, avg: +f.avg.toFixed(4), fee: f.fee, cost: f.cost, worst: f.worst, full: f.full, ev: +ev.toFixed(2) } : null, depth: f.depth });
      } catch (e) { out.push({ ...b, fill: null, error: String(e.message || e) }); }
    }
    return out;
  }

  // Settle real trades the same way as paper picks
  async function settle() {
    for (const t of db.trades.filter(t => t.status === 'open' && t.qty > 0)) {
      try {
        const sm = await api[t.league](new Request(`http://local/api?kind=summary&event=${t.event}`)).then(r => r.json());
        if (sm.state !== 'post') continue;
        const sc = Object.fromEntries((sm.comps || []).map(c => [String(c.id), +c.score || 0]));
        t.status = gradeBet(t, sc); t.pl = +(t.status === 'won' ? t.qty - t.cost : t.status === 'lost' ? -t.cost : 0).toFixed(2); t.settledAt = new Date().toISOString(); save();
      } catch {}
    }
  }
  setInterval(settle, 5 * 60000).unref();

  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
  const body = req => new Promise((ok, bad) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } }); });

  async function handle(req, res, u) {
    if (!PASSWORD) return send(res, 404, { error: 'Trading is not set up. Add TRADE_PASSWORD in Render.' });
    const route = u.pathname.replace('/api/trade', '') || '/';
    if (req.method === 'POST' && req.headers['x-trade'] !== '1') return send(res, 403, { error: 'missing header' });

    if (route === '/login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
      const f = fails.get(ip) || { n: 0, until: 0 }; if (f.until > Date.now()) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
      const { password } = await body(req).catch(() => ({}));
      const a = crypto.createHash('sha256').update(String(password || '')).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest();
      if (!crypto.timingSafeEqual(a, b)) { f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; } fails.set(ip, f); return send(res, 401, { error: 'Wrong password' }); }
      fails.delete(ip);
      const secure = /^https/.test(String(req.headers['x-forwarded-proto'] || '')) ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'set-cookie': `tsess=${makeToken({ exp: Date.now() + 12 * 3600000 })}; Path=/api/trade; HttpOnly; SameSite=Strict; Max-Age=43200${secure}` });
    }
    if (route === '/logout') return send(res, 200, { ok: true }, { 'set-cookie': 'tsess=; Path=/api/trade; Max-Age=0' });
    if (!authed(req)) return send(res, 401, { error: 'login required' });

    if (route === '/state') {
      let account = null, accountError = null;
      if (trader) try { const b = await trader.balances(); account = (b.balances || [])[0] || null; } catch (e) { accountError = String(e.message || e); }
      return send(res, 200, { enabled: ENABLED, killed: db.killed, connected: !!trader, account, accountError, limits: LIMITS,
        spentToday: +spentToday().toFixed(2), openBets: openBets(), opportunities: await opportunities(), trades: db.trades.slice(-100).reverse() });
    }
    if (route === '/kill' && req.method === 'POST') { const { on } = await body(req); db.killed = !!on; save(); return send(res, 200, { killed: db.killed }); }

    if (route === '/preview' && req.method === 'POST') {
      const o = await body(req);
      const b = leading('all').bets.find(x => x.trade && x.trade.slug === o.slug && x.trade.outcome === o.outcome);
      if (!b) return send(res, 409, { error: 'That bet is no longer on the board. Prices or the game moved.' });
      const usd = Math.min(+o.usd || LIMITS.maxOrder, LIMITS.maxOrder);
      const bk = await api[b.league].pmusBook(b.trade.slug), f = simulateFill(bk, b.trade.outcome, usd);
      if (!f.qty) return send(res, 409, { error: 'Nothing on the order book at a usable price right now.' });
      // limit = the worst level we'd touch, plus the slippage allowance, as a price for our side
      const limitSide = Math.min(0.99, +(f.worst + LIMITS.slip).toFixed(2));
      const limitYesPx = b.trade.outcome === 'YES' ? limitSide : +(1 - limitSide).toFixed(2);
      // size down so even a fill at the limit price can't pass the per-order cap
      let qty = f.qty; while (qty > 1 && qty * limitSide + takerFee(qty, limitSide) > usd) qty--;
      let exchange = null, exchangeError = null;
      if (trader) try { exchange = await trader.preview({ slug: b.trade.slug, outcome: b.trade.outcome, qty, limitYesPx }); } catch (e) { exchangeError = String(e.message || e); }
      const plan = { slug: b.trade.slug, outcome: b.trade.outcome, qty, limitSide, limitYesPx, estCost: +(f.avg * qty + takerFee(qty, f.avg)).toFixed(2), maxCost: +(qty * limitSide + takerFee(qty, limitSide)).toFixed(2),
        league: b.league, event: b.event, matchup: b.matchup, sel: b.sel, type: b.type, teamId: b.teamId, by: b.by, line: b.line, over: b.over,
        model: b.model, fair: b.fair ?? null, tier: b.tier || null, exp: Date.now() + 30000 };
      return send(res, 200, { plan, token: makeToken(plan), fill: { qty, avg: f.avg, fee: takerFee(qty, f.avg), cost: plan.estCost }, exchange, exchangeError,
        ev: +((b.fair ?? b.model) * qty - plan.estCost).toFixed(2), checks: checks(plan) });
    }
    if (route === '/place' && req.method === 'POST') {
      const { token } = await body(req); const plan = readToken(token);
      if (!plan) return send(res, 409, { error: 'Preview expired (30 seconds). Preview again.' });
      const c = checks(plan); if (c.some(x => !x.ok)) return send(res, 409, { error: 'Blocked. Failed: ' + c.filter(x => !x.ok).map(x => x.msg).join('; ') });
      if (db.trades.some(t => t.token === token)) return send(res, 409, { error: 'Already placed.' });
      let r, err = null;
      try { r = await trader.place({ slug: plan.slug, outcome: plan.outcome, qty: plan.qty, limitYesPx: plan.limitYesPx }); } catch (e) { err = String(e.message || e); }
      // read back what actually filled
      const ex = (r && r.executions) || [], fills = ex.filter(x => /FILL/.test(x.type || ''));
      let qty = 0, notional = 0, fee = 0;
      for (const x of fills) { const q = +x.lastShares || 0, px = +(x.lastPx && x.lastPx.value) || 0; qty += q; notional += q * (plan.outcome === 'YES' ? px : 1 - px); fee += +(x.commissionNotionalCollected && x.commissionNotionalCollected.value) || 0; }
      const t = { at: new Date().toISOString(), day: today(), token, orderId: r && r.id || null, error: err, ...plan, qty, avg: qty ? +(notional / qty).toFixed(4) : null,
        fee: +fee.toFixed(2), cost: +(notional + fee).toFixed(2), status: qty > 0 ? 'open' : 'unfilled', raw: ex.map(x => ({ type: x.type, shares: x.lastShares, px: x.lastPx && x.lastPx.value, reason: x.orderRejectReason || x.text || null })) };
      delete t.exp; db.trades.push(t); save();
      return send(res, err ? 502 : 200, { trade: t });
    }
    return send(res, 404, { error: 'unknown route' });
  }

  function checks(plan) {
    const spent = spentToday();
    return [
      { ok: !!trader, msg: 'Polymarket US API keys are set in Render' },
      { ok: ENABLED, msg: 'TRADING_ENABLED is true (otherwise preview only)' },
      { ok: !db.killed, msg: 'Kill switch is off' },
      { ok: plan.maxCost <= LIMITS.maxOrder, msg: `Worst case $${plan.maxCost} fits the $${LIMITS.maxOrder} per-order limit` },
      { ok: spent + plan.maxCost <= LIMITS.maxDaily, msg: `Stays under the $${LIMITS.maxDaily} daily limit ($${spent.toFixed(2)} used today)` },
      { ok: openBets() < LIMITS.maxOpen, msg: `Fewer than ${LIMITS.maxOpen} bets open` },
      { ok: !db.trades.some(t => t.qty > 0 && t.status === 'open' && t.slug === plan.slug), msg: 'Not already holding this market' },
    ];
  }
  return { handle };
}
