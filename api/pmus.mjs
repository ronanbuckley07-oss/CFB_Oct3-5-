// Polymarket US (the CFTC-regulated exchange US residents can trade on, docs.polymarket.us).
//   Public data: https://gateway.polymarket.us  (leagues, events with markets and best bid/ask, order books)
//   Trading:     https://api.polymarket.us      (Ed25519-signed: balances, positions, preview, orders)
// Every market is one YES/NO instrument and every price is the YES price. Buying NO is selling YES at (1 - price).
import crypto from 'node:crypto';

export const GATEWAY = process.env.PMUS_GATEWAY || 'https://gateway.polymarket.us';
export const API = process.env.PMUS_API || 'https://api.polymarket.us';
export const TAKER_THETA = 0.0695; // fee schedule effective Oct 1, 2026: fee = theta x contracts x p x (1 - p)
export const takerFee = (qty, p) => Math.round(TAKER_THETA * qty * p * (1 - p) * 100) / 100;

const num = x => { const v = typeof x === 'object' && x ? +x.value : +x; return isFinite(v) ? v : null; };

// ---------- public market data ----------
export function createPmusData(get) {
  let leagueSlugs = null;
  async function leagueSlug(league) {
    if (!leagueSlugs) {
      leagueSlugs = {};
      try {
        const d = await get(`${GATEWAY}/v2/leagues?limit=50`, 3600000);
        for (const l of d.leagues || []) {
          const s = String(l.slug || '').toLowerCase(), n = String(l.name || '').toLowerCase();
          if (s === 'nfl' || n === 'nfl') leagueSlugs.nfl = l.slug;
          if (/^(cfb|ncaaf|college-?football|ncaa-?football)$/.test(s) || /college football|ncaa football|ncaaf/.test(n)) leagueSlugs.cfb = l.slug;
        }
      } catch {}
      leagueSlugs.nfl = leagueSlugs.nfl || 'nfl'; leagueSlugs.cfb = leagueSlugs.cfb || 'cfb';
    }
    return leagueSlugs[league];
  }
  async function events(league) {
    const slug = await leagueSlug(league), out = [];
    for (let off = 0; off < 400; off += 100) {
      const d = await get(`${GATEWAY}/v2/leagues/${slug}/events?limit=100&offset=${off}`, 15000);
      out.push(...(d.events || [])); if ((d.events || []).length < 100) break;
    }
    return out;
  }
  // Find our game on Polymarket US and return its tradable full-game markets.
  // nameScore(label, team) is the matcher the rest of the site uses; A = away, B = home.
  async function forGame(league, A, B, kickoff, nameScore) {
    const evs = await events(league), day = kickoff ? new Date(kickoff).getTime() : null;
    let best = null;
    for (const ev of evs) {
      if (ev.closed || ev.archived) continue;
      const label = `${ev.title || ''} ${(ev.teams || []).map(t => `${t.name || ''} ${t.abbreviation || ''} ${t.alias || ''}`).join(' ')}`;
      const sc = nameScore(label, A) + nameScore(label, B); if (sc < 1) continue;
      const t = new Date(ev.startTime || ev.startDate || ev.eventDate || 0).getTime();
      if (day && t && Math.abs(t - day) > 2 * 86400000) continue;
      if (!best || sc > best.sc) best = { sc, ev };
    }
    if (!best) return { found: false, checked: evs.length };
    const ev = best.ev, res = { found: true, title: ev.title, slug: ev.slug, url: ev.slug ? `https://polymarket.us/event/${ev.slug}` : null, spreads: [], totals: [] };
    const teamSide = t => { if (!t) return null; const lab = `${t.name || ''} ${t.abbreviation || ''} ${t.alias || ''}`; const a = nameScore(lab, A), b = nameScore(lab, B); return a > b && a > 0 ? 'A' : b > a && b > 0 ? 'B' : null; };
    for (const m of ev.markets || []) {
      if (m.closed || m.active === false || m.hidden || !m.slug) continue;
      const type = String(m.sportsMarketType || m.marketType || '').toLowerCase(), q = `${m.question || ''} ${m.title || ''}`;
      if (/half|quarter|1h|2h|q[1-4]\b|team total|player|prop/i.test(q)) continue;
      const bid = num(m.bestBidQuote), ask = num(m.bestAskQuote);
      if (!(ask > 0 && ask < 1) && !(bid > 0 && bid < 1)) continue; // nobody quoting it
      const sides = m.marketSides || [], longSide = sides.find(s => s.long === true) || sides[0];
      const yesTeam = teamSide((longSide && longSide.team) || m.subject && { name: m.subject.name });
      const mid = bid != null && ask != null ? (bid + ask) / 2 : ask ?? bid;
      const base = { slug: m.slug, bid, ask, mid, tick: num(m.orderPriceMinTickSize) || 0.01, minQty: num(m.minimumTradeQty) || 1 };
      if (/moneyline/.test(type)) {
        if (!yesTeam || res[yesTeam]) continue;
        const other = yesTeam === 'A' ? 'B' : 'A';
        // YES side and the NO side (the other team) of one instrument
        res[yesTeam] = { ...base, p: mid, trade: { slug: m.slug, outcome: 'YES' } };
        res[other] = { ...base, p: 1 - mid, bid: ask != null ? 1 - ask : null, ask: bid != null ? 1 - bid : null, trade: { slug: m.slug, outcome: 'NO' } };
      } else if (/spread/.test(type)) {
        const line = num(m.line); if (line == null || !yesTeam) continue;
        // "KC -3.5": YES = KC wins by more than 3.5, i.e. margin > -line
        res.spreads.push({ side: yesTeam, by: -line, p: mid, ...base });
      } else if (/total/.test(type)) {
        const line = num(m.line); if (line == null || line < 20) continue;
        const desc = `${(longSide && (longSide.description || longSide.identifier)) || ''} ${q}`;
        const yesOver = !/under/i.test(longSide && (longSide.description || longSide.identifier) || '') || /over/i.test(desc);
        res.totals.push({ line, p: yesOver ? mid : 1 - mid, yesOver, ...base });
      }
    }
    if (!res.A || !res.B) res.found = !!(res.spreads.length || res.totals.length);
    return res;
  }
  async function book(slug) {
    const d = await get(`${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`, 1500);
    const md = d.marketData || d;
    const lv = a => (a || []).map(e => ({ px: num(e.px), qty: +e.qty || 0 })).filter(e => e.px > 0 && e.px < 1 && e.qty > 0);
    return { bids: lv(md.bids).sort((a, b) => b.px - a.px), offers: lv(md.offers).sort((a, b) => a.px - b.px), state: md.state || null, at: md.transactTime || null };
  }
  return { leagueSlug, events, forGame, book };
}

// Walk the book the way a taker order would. Buying YES eats offers; buying NO sells YES into bids (cost 1 - bid each).
// Returns what $stake would really get: contracts, average price per contract, taker fees, total cost.
export function simulateFill(bk, outcome, stake, maxPrice = 0.97) {
  const levels = outcome === 'YES' ? bk.offers.map(l => ({ px: l.px, qty: l.qty })) : bk.bids.map(l => ({ px: 1 - l.px, qty: l.qty }));
  let qty = 0, spend = 0, fee = 0, worst = null;
  for (const l of levels) {
    if (l.px > maxPrice) break;
    const room = stake - spend - fee; if (room <= 0.005) break;
    const perC = l.px + TAKER_THETA * l.px * (1 - l.px);
    const take = Math.min(l.qty, Math.floor(room / perC)); if (take <= 0) break;
    qty += take; spend += take * l.px; fee += TAKER_THETA * take * l.px * (1 - l.px); worst = l.px;
    if (take < l.qty) break;
  }
  fee = Math.round(fee * 100) / 100;
  return { qty, avg: qty ? spend / qty : null, fee, cost: +(spend + fee).toFixed(2), worst, full: spend + fee >= stake * 0.9, depth: levels.slice(0, 5) };
}

// ---------- authenticated trading client ----------
export function createPmusTrader({ keyId = process.env.POLYMARKET_US_KEY_ID, secret = process.env.POLYMARKET_US_SECRET_KEY } = {}) {
  if (!keyId || !secret) return null;
  // The secret is base64; its first 32 bytes are the Ed25519 seed. Wrap it as PKCS#8 so Node's crypto can sign with it.
  const seed = Buffer.from(secret, 'base64').subarray(0, 32);
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  async function call(method, path, body) {
    const ts = String(Date.now());
    const sig = crypto.sign(null, Buffer.from(`${ts}${method}${path}`), key).toString('base64');
    const r = await fetch(API + path, { method, headers: { 'X-PM-Access-Key': keyId, 'X-PM-Timestamp': ts, 'X-PM-Signature': sig, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(`Polymarket US ${r.status}: ${(j && (j.message || j.error)) || text.slice(0, 200)}`);
    return j;
  }
  // Prices are always the YES price. YES bets buy YES; NO bets sell YES (the docs' "buying NO").
  const orderBody = ({ slug, outcome, qty, limitYesPx }) => ({
    marketSlug: slug, type: 'ORDER_TYPE_LIMIT', price: { value: limitYesPx.toFixed(2), currency: 'USD' }, quantity: qty,
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL', intent: outcome === 'YES' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_SELL_LONG',
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL', synchronousExecution: true, maxBlockTime: '5' });
  return {
    balances: () => call('GET', '/v1/account/balances'),
    positions: () => call('GET', '/v1/portfolio/positions'),
    preview: o => call('POST', '/v1/order/preview', { request: orderBody(o) }),
    place: o => call('POST', '/v1/orders', orderBody(o)),
    orderBody,
  };
}
