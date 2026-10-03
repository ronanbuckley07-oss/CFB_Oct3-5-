// ESPN proxy, served at /api/espn by server.mjs. The browser never calls ESPN directly, and every ESPN response is
// memoized briefly in memory, so a hundred people watching the board cost the same as one.
//   ?kind=scoreboard[&scope=top|fbs][&date=YYYYMMDD] -> this week's games, trimmed for the home page (no sims)
//   ?kind=card&event=ID[&date=YYYYMMDD]  -> one game in the same trimmed shape, for the game page's start screen
//   ?kind=box&event=ID                   -> box score: team stats and player stat lines
//   ?kind=markets&event=ID[&kalshi=TICKER][&poly=SLUG] -> Kalshi and Polymarket win prices for both teams
//   ?event=ID&date=YYYYMMDD           -> that game's scoreboard entry (live state, odds)       [original behavior]
//   ?kind=summary&event=ID            -> trimmed game summary: teams, line, every play, ESPN win probability
//   ?kind=list&date=YYYYMMDD          -> finished FBS games on that date (for backtesting)
//   ?kind=find&q=Michigan at Ohio State  (or &event=ID) -> the ESPN game, its date, and both teams' names and colors
//   ?kind=team&id=TEAMID              -> player usage from this season's box scores, plus the team's schedule
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';

export default async (req) => {
  const u = new URL(req.url);
  const kind = u.searchParams.get('kind') || 'game';
  const event = (u.searchParams.get('event') || '').replace(/\D/g, '');
  const date = (u.searchParams.get('date') || '').replace(/\D/g, '');
  try {
    if (kind === 'scoreboard') {
      const scope = u.searchParams.get('scope') === 'fbs' ? 'fbs' : 'top';
      const d = await get(`${BASE}/scoreboard?groups=80&limit=400${date ? `&dates=${date}` : ''}`, 10000);
      const all = (d.events || []).map(trimEvent).filter(Boolean);
      const top = all.filter(g => g.home.rank || g.away.rank);
      const games = scope === 'top' && top.length ? top : all;
      return json({ updated: new Date().toISOString(), scope, fallback: scope === 'top' && !top.length,
        week: d.week?.number ?? null, counts: { top: top.length, fbs: all.length }, games }, 200, 10);
    }
    if (kind === 'card') {
      if (!event) return json({ error: 'missing event' }, 400);
      let dt = date;
      if (!dt) { const s = await get(`${BASE}/summary?event=${event}`, 8000); dt = etDate(s.header?.competitions?.[0]?.date); }
      const d = await get(`${BASE}/scoreboard?groups=80&limit=400${dt ? `&dates=${dt}` : ''}`, 10000);
      const ev = (d.events || []).find(e => String(e.id) === event);
      if (!ev) return json({ error: 'game not found' }, 404);
      return json({ ...trimEvent(ev), etDate: dt }, 200, 10);
    }
    if (kind === 'box') {
      if (!event) return json({ error: 'missing event' }, 400);
      return json(trimBox(await get(`${BASE}/summary?event=${event}`, 8000)), 200, 10);
    }
    if (kind === 'markets') {
      if (!event) return json({ error: 'missing event' }, 400);
      return json(await markets(event, u.searchParams.get('kalshi'), u.searchParams.get('poly'), u.searchParams.has('debug')), 200, 15);
    }
    if (kind === 'summary') {
      if (!event) return json({ error: 'missing event' }, 400);
      const d = await get(`${BASE}/summary?event=${event}`, 8000);
      const out = trimSummary(d);
      return json(out, 200, out.state === 'post' ? 3600 : 10);
    }
    if (kind === 'find') return json(await findGame(u.searchParams.get('q') || '', event), 200, 60);
    if (kind === 'team') {
      const id = (u.searchParams.get('id') || '').replace(/\D/g, '');
      if (!id) return json({ error: 'missing id' }, 400);
      return json(await teamUsage(id), 200, 1800);
    }
    if (kind === 'list') {
      if (!date) return json({ error: 'missing date' }, 400);
      const d = await get(`${BASE}/scoreboard?groups=80&limit=300&dates=${date}`, 300000);
      const games = (d.events || []).filter(e => e.status?.type?.state === 'post').map(e => {
        const c = e.competitions?.[0] || {};
        const t = (c.competitors || []).map(x => ({ id: x.id, homeAway: x.homeAway, abbr: x.team?.abbreviation, score: +x.score || 0 }));
        return { id: e.id, name: e.shortName || e.name, teams: t, line: c.odds?.[0]?.details || null };
      });
      return json({ date, games }, 200, 300);
    }
    if (!event) return json({ error: 'missing event' }, 400);
    const data = await get(`${BASE}/scoreboard?groups=80&limit=300${date ? `&dates=${date}` : ''}`, 4000);
    const ev = (data.events || []).find(e => String(e.id) === event);
    if (!ev) return json({ error: 'game not found on that date' }, 404);
    return json(ev, 200, 3);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
};

// ---------- game finder ----------
let teamCache = null;
async function allTeams() {
  if (teamCache) return teamCache;
  const d = await get(`${BASE}/teams?limit=1000`, 86400000);
  const list = d.sports?.[0]?.leagues?.[0]?.teams || [];
  teamCache = list.map(x => x.team).filter(Boolean).map(teamInfo);
  return teamCache;
}
function teamInfo(t) {
  return { id: String(t.id), name: t.displayName || t.name, short: t.shortDisplayName || t.location || t.name,
    abbr: t.abbreviation, location: t.location || '', mascot: t.name || '',
    color: t.color ? '#' + t.color : null, alt: t.alternateColor ? '#' + t.alternateColor : null };
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();
function scoreTeam(t, q) {
  const n = norm(q); if (!n) return 0;
  const fields = [t.abbr, t.short, t.location, t.name, `${t.location} ${t.mascot}`].map(norm);
  if (fields.some(f => f === n)) return 100;
  if (norm(t.location) === n || norm(t.short) === n) return 95;
  if (fields.some(f => f.startsWith(n + ' ') || f.startsWith(n))) return 60 - Math.abs(norm(t.location).length - n.length) / 10;
  if (fields.some(f => f.includes(n))) return 30;
  return 0;
}
function bestTeams(q) {
  return teamCache.map(t => [scoreTeam(t, q), t]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]);
}
async function findGame(q, event) {
  await allTeams();
  if (event) {
    const d = await get(`${BASE}/summary?event=${event}`, 8000);
    const comp = d.header?.competitions?.[0] || {};
    const cs = comp.competitors || [];
    if (cs.length < 2) throw new Error('game not found');
    const byId = id => teamCache.find(t => t.id === String(id));
    const home = cs.find(c => c.homeAway === 'home'), away = cs.find(c => c.homeAway === 'away');
    const A = byId(away.id) || teamInfo(away.team), B = byId(home.id) || teamInfo(home.team);
    return pack(event, comp.date, comp.status?.type?.state, A, B, home.id);
  }
  const parts = q.split(/\s+(?:vs\.?|v\.?|versus|at|@|and|&|-)\s+|\s*@\s*|\s*,\s*/i).map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('type one or two team names');
  const ca = bestTeams(parts[0]);
  if (!ca.length) throw new Error(`no team matches "${parts[0]}"`);
  let A = ca[0][1], B = null;
  if (parts[1]) { const cb = bestTeams(parts[1]); if (!cb.length) throw new Error(`no team matches "${parts[1]}"`); B = cb[0][1]; }
  const sched = await get(`${BASE}/teams/${A.id}/schedule`, 600000);
  const evs = (sched.events || []).filter(e => {
    const cs = e.competitions?.[0]?.competitors || [];
    return !B || cs.some(c => String(c.id ?? c.team?.id) === B.id);
  });
  if (!evs.length) throw new Error(B ? `no ${A.short} game against ${B.short} this season` : `no games found for ${A.short}`);
  // Prefer a game in progress, then the next one, then the most recent
  const now = Date.now(), st = e => e.competitions?.[0]?.status?.type?.state;
  const ev = evs.find(e => st(e) === 'in')
    || evs.filter(e => st(e) === 'pre').sort((a, b) => new Date(a.date) - new Date(b.date))[0]
    || evs.sort((a, b) => Math.abs(new Date(a.date) - now) - Math.abs(new Date(b.date) - now))[0];
  const cs = ev.competitions?.[0]?.competitors || [];
  const home = cs.find(c => c.homeAway === 'home');
  if (!B) { const o = cs.find(c => String(c.id ?? c.team?.id) !== A.id); B = teamCache.find(t => t.id === String(o?.id ?? o?.team?.id)) || teamInfo(o.team); }
  const alts = ca.slice(1, 4).filter(x => x[0] >= ca[0][0] - 5).map(x => x[1].name);
  return { ...pack(ev.id, ev.date, st(ev), A, B, home?.id ?? home?.team?.id), alternatives: alts };
}
// ESPN's scoreboard is indexed by US Eastern date
const etDate = date => date ? new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '') : null;
function pack(id, date, state, A, B, homeId) {
  return { event: String(id), date: etDate(date), kickoff: date, state, A, B, homeId: String(homeId) };
}

// ---------- scoreboard entry -> what the home page and start screen draw ----------
function trimEvent(e) {
  const c = e.competitions?.[0]; if (!c) return null;
  const st = c.status || e.status || {}, ty = st.type || {};
  const side = x => {
    if (!x) return null; const t = x.team || {}, rk = x.curatedRank?.current;
    const logos = t.logos || [];
    const dark = logos.find(l => (l.rel || []).includes('dark'))?.href;
    return { id: String(x.id ?? t.id), abbr: t.abbreviation || t.shortDisplayName, short: t.shortDisplayName || t.location || t.name,
      name: t.displayName || t.name, logo: t.logo || logos[0]?.href || null, logoDark: dark || null,
      color: t.color ? '#' + t.color : null, alt: t.alternateColor ? '#' + t.alternateColor : null,
      rank: rk && rk <= 25 ? rk : null, record: x.records?.find(r => r.type === 'total')?.summary || x.records?.[0]?.summary || null,
      score: x.score != null && x.score !== '' ? +x.score : null, winner: !!x.winner };
  };
  const cs = c.competitors || [];
  const home = side(cs.find(x => x.homeAway === 'home')), away = side(cs.find(x => x.homeAway === 'away'));
  if (!home || !away) return null;
  const sit = c.situation; let s = null, wpHome = null;
  const phase = ty.state !== 'in' ? null : (ty.name === 'STATUS_HALFTIME' || /half/i.test(ty.shortDetail || '')) ? 'half'
    : ty.name === 'STATUS_END_PERIOD' || /^end of/i.test(ty.shortDetail || '') ? 'break' : 'play';
  if (sit && ty.state === 'in' && phase === 'half') {
    s = { poss: null, down: null, dist: null, pos: null, spot: null, text: null, redZone: false, lastPlay: cleanPlay(sit.lastPlay?.text) };
    const p = sit.lastPlay?.probability?.homeWinPercentage; if (typeof p === 'number') wpHome = p;
  } else if (sit && ty.state === 'in') {
    const pid = String(sit.possession ?? '');
    const poss = pid === home.id ? 'home' : pid === away.id ? 'away' : null;
    let pos = null; // yards from the offense's own goal line
    const m = String(sit.possessionText || '').match(/^(\S+)\s+(\d+)/);
    if (poss && m) {
      const off = poss === 'home' ? home : away, def = poss === 'home' ? away : home, tag = m[1].toUpperCase(), yl = +m[2];
      if (tag === String(off.abbr).toUpperCase()) pos = yl; else if (tag === String(def.abbr).toUpperCase()) pos = 100 - yl;
    } else if (poss && /\b50\b/.test(sit.possessionText || '')) pos = 50;
    const down = sit.down >= 1 && sit.down <= 4 ? sit.down : null;
    s = { poss, down, dist: down && sit.distance > 0 ? sit.distance : null, pos, spot: sit.possessionText || null,
      text: sit.shortDownDistanceText || sit.downDistanceText || null, redZone: !!sit.isRedZone,
      lastPlay: cleanPlay(sit.lastPlay?.text), homeTO: sit.homeTimeouts ?? null, awayTO: sit.awayTimeouts ?? null };
    const p = sit.lastPlay?.probability?.homeWinPercentage; if (typeof p === 'number') wpHome = p;
  }
  // ESPN drops win probability between plays and at halftime, so fall back to the last number it sent
  const id = String(e.id);
  if (wpHome != null) lastWp.set(id, wpHome); else if (ty.state === 'in') wpHome = lastWp.get(id) ?? null;
  if (ty.state === 'post') wpHome = home.winner ? 1 : away.winner ? 0 : null;
  const od = c.odds?.[0] || {};
  return { id, phase, date: e.date, state: ty.state || null, detail: ty.shortDetail || ty.detail || null,
    period: st.period ?? null, clock: st.displayClock ?? null, neutral: !!c.neutralSite,
    tv: c.broadcasts?.[0]?.names?.[0] || c.broadcast || null, home, away, sit: s, wpHome,
    line: od.details || null, ou: od.overUnder ?? null };
}

const lastWp = new Map();
// "(00:18) No Huddle-Shotgun #13 A.Simmons pass complete..." -> "A.Simmons pass complete..."
function cleanPlay(t) {
  if (!t) return null;
  return String(t).replace(/^\(\d+:\d+\)\s*/, '').replace(/^(No Huddle-?|Shotgun|No Huddle)\s*/gi, '').replace(/^(Shotgun|No Huddle)\s*/gi, '')
    .replace(/#\d+\s+/g, '').replace(/\s+/g, ' ').trim() || null;
}

// ---------- box score ----------
function trimBox(d) {
  const bx = d.boxscore || {};
  const teams = (bx.teams || []).map(t => ({ id: String(t.team?.id), abbr: t.team?.abbreviation, name: t.team?.shortDisplayName || t.team?.displayName,
    color: t.team?.color ? '#' + t.team.color : null, homeAway: t.homeAway || null,
    stats: (t.statistics || []).map(x => ({ name: x.name, label: x.label || x.name, value: x.displayValue ?? String(x.value ?? '') })) }));
  const players = (bx.players || []).map(p => ({ id: String(p.team?.id), abbr: p.team?.abbreviation,
    cats: (p.statistics || []).map(c => ({ name: c.name, title: c.text || c.name, labels: c.labels || [],
      rows: (c.athletes || []).map(a => [a.athlete?.shortName || a.athlete?.displayName || '?', ...(a.stats || [])]),
      totals: c.totals || null })) }));
  const comp = d.header?.competitions?.[0] || {};
  const lines = (comp.competitors || []).map(c => ({ id: String(c.id ?? c.team?.id), homeAway: c.homeAway, abbr: c.team?.abbreviation,
    q: (c.linescores || []).map(l => l.displayValue ?? l.value), score: c.score }));
  return { state: comp.status?.type?.state || null, teams, players, lines };
}

// ---------- prediction markets: Kalshi and Polymarket ----------
const KALSHI = ['https://external-api.kalshi.com/trade-api/v2', 'https://api.elections.kalshi.com/trade-api/v2'];
const GAMMA = 'https://gamma-api.polymarket.com';
const words = s => norm(String(s || '').replace(/\bst\.?\b/gi, 'state')).split(' ').filter(w => w && !['the', 'of', 'university', 'u'].includes(w));
// How well a market's label names this team: 0 (no) to 1 (exact)
function nameScore(label, t) {
  const L = ' ' + words(label).join(' ') + ' ';
  const cands = [t.name, t.location, t.short, `${t.location} ${t.mascot}`].filter(Boolean).map(x => words(x).join(' ')).filter(Boolean);
  let best = 0;
  for (const c of cands) { if (L.trim() === c) return 1; if (L.includes(' ' + c + ' ')) best = Math.max(best, 0.6 + Math.min(0.3, c.length / 60)); }
  if (t.abbr && new RegExp(`(^|[^a-z])${t.abbr.toLowerCase()}([^a-z]|$)`).test(String(label).toLowerCase())) best = Math.max(best, 0.5);
  return best;
}
const num01 = x => { if (x == null || x === '') return null; const v = +x; if (!isFinite(v)) return null; return v > 1 ? v / 100 : v; };
function midPrice(bid, ask, last) {
  const b = num01(bid), a = num01(ask), l = num01(last);
  if (b != null && a != null && a > 0 && a >= b && a - b <= 0.12) return { p: (a + b) / 2, bid: b, ask: a, last: l };
  if (l != null && l > 0) return { p: l, bid: b, ask: a, last: l };
  if (b != null && a != null && a > 0) return { p: (a + b) / 2, bid: b, ask: a, last: l };
  return null;
}
async function getAny(urls, ttl) { let err; for (const u of urls) { try { return await get(u, ttl); } catch (e) { err = e; } } throw err; }

async function kalshiEvents() {
  const out = []; let cursor = '';
  for (let page = 0; page < 6; page++) {
    const q = `/events?series_ticker=KXNCAAFGAME&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const d = await getAny(KALSHI.map(b => b + q), 20000);
    out.push(...(d.events || [])); cursor = d.cursor; if (!cursor || !(d.events || []).length) break;
  }
  return out;
}
async function kalshiFor(A, B, pin) {
  let events;
  if (pin) {
    const tk = pin.toUpperCase().replace(/-[A-Z0-9]+$/, m => m); // event or market ticker
    const evT = tk.split('-').slice(0, 2).join('-');
    const d = await getAny(KALSHI.map(b => `${b}/events/${evT}?with_nested_markets=true`), 20000);
    events = [d.event ? { ...d.event, markets: d.markets || d.event.markets } : d];
  } else events = await kalshiEvents();
  let best = null;
  for (const ev of events) {
    const title = `${ev.title || ''} ${ev.sub_title || ''}`;
    const sc = nameScore(title, A) + nameScore(title, B);
    if (sc >= 1 && (!best || sc > best.sc)) best = { sc, ev };
  }
  if (!best) return { found: false, checked: events.length };
  const res = { found: true, title: best.ev.title, ticker: best.ev.event_ticker, url: `https://kalshi.com/markets/kxncaafgame/${String(best.ev.event_ticker || '').toLowerCase()}` };
  for (const m of best.ev.markets || []) {
    const label = `${m.yes_sub_title || ''} ${m.subtitle || ''} ${String(m.ticker || '').split('-').pop()}`;
    const pr = midPrice(m.yes_bid_dollars ?? m.yes_bid, m.yes_ask_dollars ?? m.yes_ask, m.last_price_dollars ?? m.last_price);
    if (!pr) continue;
    const sa = nameScore(label, A), sb = nameScore(label, B);
    if (sa > sb && sa > 0) res.A = { ...pr, label: m.yes_sub_title || m.ticker, vol: m.volume ?? null };
    else if (sb > sa && sb > 0) res.B = { ...pr, label: m.yes_sub_title || m.ticker, vol: m.volume ?? null };
  }
  if (res.A && !res.B) res.B = { p: 1 - res.A.p, implied: true }; if (res.B && !res.A) res.A = { p: 1 - res.B.p, implied: true };
  return res;
}

async function polyEvents() {
  const lists = [];
  try {
    const sports = await get(`${GAMMA}/sports`, 3600000);
    const cfb = (Array.isArray(sports) ? sports : []).find(x => /^(cfb|ncaaf|college-?football)$/i.test(x.sport || ''));
    if (cfb?.series) for (const sid of String(cfb.series).split(',').filter(Boolean))
      lists.push(get(`${GAMMA}/events?series_id=${sid}&closed=false&limit=500`, 20000).catch(() => []));
  } catch {}
  for (const tag of ['cfb', 'college-football', 'ncaaf']) lists.push(get(`${GAMMA}/events?tag_slug=${tag}&closed=false&limit=500`, 20000).catch(() => []));
  const seen = new Set(), out = [];
  for (const l of await Promise.all(lists)) for (const e of (Array.isArray(l) ? l : l?.data || [])) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
  return out;
}
const parseArr = x => { if (Array.isArray(x)) return x; try { return JSON.parse(x || '[]'); } catch { return []; } };
async function polyFor(A, B, pin, kickoff) {
  let events;
  if (pin) { const e = await get(`${GAMMA}/events/slug/${encodeURIComponent(pin)}`, 20000); events = [e]; }
  else events = await polyEvents();
  const day = kickoff ? new Date(kickoff).getTime() : null;
  let best = null;
  for (const ev of events) {
    const sc = nameScore(ev.title, A) + nameScore(ev.title, B);
    if (sc < 1) continue;
    const t = new Date(ev.startTime || ev.gameStartTime || ev.endDate || ev.startDate || 0).getTime();
    const near = !day || !t || Math.abs(t - day) < 4 * 86400000;
    if (near && (!best || sc > best.sc)) best = { sc, ev };
  }
  if (!best) return { found: false, checked: events.length };
  const ev = best.ev, res = { found: true, title: ev.title, slug: ev.slug, url: `https://polymarket.com/event/${ev.slug}` };
  // The moneyline market is the one whose two outcomes are the two teams
  for (const m of ev.markets || []) {
    if (m.closed && !m.active) continue;
    const outs = parseArr(m.outcomes), prices = parseArr(m.outcomePrices).map(Number);
    if (outs.length !== 2 || /spread|o\/u|total|over|under|half|quarter/i.test(`${m.question || ''} ${m.sportsMarketType || ''}`) && m.sportsMarketType !== 'moneyline') continue;
    const ia = outs.findIndex(o => nameScore(o, A) > nameScore(o, B)), ib = 1 - ia;
    if (ia < 0 || nameScore(outs[ib], B) <= 0) continue;
    // bestBid/bestAsk are quoted for the first outcome
    const pr0 = midPrice(m.bestBid, m.bestAsk, m.lastTradePrice ?? prices[0]);
    const p0 = pr0 ? pr0.p : prices[0]; if (!(p0 >= 0 && p0 <= 1)) continue;
    const pA = ia === 0 ? p0 : 1 - p0;
    res.A = { p: pA, label: outs[ia], vol: +m.volume || null }; res.B = { p: 1 - pA, label: outs[ib] };
    if (pr0 && pr0.bid != null && pr0.ask != null) { res.A.bid = ia === 0 ? pr0.bid : 1 - pr0.ask; res.A.ask = ia === 0 ? pr0.ask : 1 - pr0.bid; }
    break;
  }
  if (!res.A) res.found = false;
  return res;
}
async function markets(event, kPin, pPin, debug) {
  await allTeams();
  const s = await get(`${BASE}/summary?event=${event}`, 8000);
  const comp = s.header?.competitions?.[0] || {}, cs = comp.competitors || [];
  const byId = id => teamCache.find(t => t.id === String(id));
  const away = cs.find(c => c.homeAway === 'away'), home = cs.find(c => c.homeAway === 'home');
  if (!away || !home) throw new Error('game not found');
  const A = byId(away.id) || teamInfo(away.team), B = byId(home.id) || teamInfo(home.team); // A = away, B = home
  const [k, p] = await Promise.all([kalshiFor(A, B, kPin).catch(e => ({ found: false, error: String(e.message || e) })),
    polyFor(A, B, pPin, comp.date).catch(e => ({ found: false, error: String(e.message || e) }))]);
  const pack = r => r && r.found && r.A ? { ...r, away: r.A, home: r.B, A: undefined, B: undefined } : r;
  const out = { at: new Date().toISOString(), awayId: A.id, homeId: B.id, kalshi: pack(k), poly: pack(p) };
  if (debug) {
    out.debug = { teams: [A, B] };
    try { out.debug.kalshiTitles = (await kalshiEvents()).map(e => `${e.event_ticker}: ${e.title}`).slice(0, 400); } catch (e) { out.debug.kalshiError = String(e.message || e); }
    try { out.debug.polyTitles = (await polyEvents()).map(e => `${e.slug}: ${e.title}`).slice(0, 400); } catch (e) { out.debug.polyError = String(e.message || e); }
  }
  return out;
}

// ---------- player usage from this season's box scores ----------
async function teamUsage(id) {
  const sched = await get(`${BASE}/teams/${id}/schedule`, 600000);
  const evs = sched.events || [];
  const done = evs.filter(e => e.competitions?.[0]?.status?.type?.state === 'post').slice(-12);
  const opp = e => { const o = (e.competitions?.[0]?.competitors || []).find(c => String(c.id ?? c.team?.id) !== id);
    return o?.team?.shortDisplayName || o?.team?.displayName || o?.team?.location || '?'; };
  const sums = await Promise.all(done.map(e => get(`${BASE}/summary?event=${e.id}`, 3600000).catch(() => null)));
  const P = {}, R = {}, C = {};
  let games = 0;
  for (const d of sums) {
    const side = (d?.boxscore?.players || []).find(p => String(p.team?.id) === id);
    if (!side) continue; games++;
    for (const cat of side.statistics || []) {
      const lab = (cat.labels || cat.keys || []).map(x => String(x).toUpperCase());
      const ix = (...names) => lab.findIndex(l => names.includes(l));
      for (const a of cat.athletes || []) {
        const nm = a.athlete?.displayName; if (!nm) continue; const s = a.stats || [];
        const num = i => (i >= 0 ? parseFloat(String(s[i]).replace(/[^\d.-]/g, '')) || 0 : 0);
        if (cat.name === 'passing') {
          const ca = String(s[ix('C/ATT', 'COMPLETIONS/PASSINGATTEMPTS')] || '0/0').split('/');
          const p = P[nm] ||= { att: 0, cmp: 0, yds: 0 }; p.cmp += +ca[0] || 0; p.att += +ca[1] || 0; p.yds += num(ix('YDS', 'PASSINGYARDS'));
        } else if (cat.name === 'rushing') {
          const r = R[nm] ||= { car: 0, yds: 0, td: 0 }; r.car += num(ix('CAR', 'RUSHINGATTEMPTS')); r.yds += num(ix('YDS', 'RUSHINGYARDS')); r.td += num(ix('TD', 'RUSHINGTOUCHDOWNS'));
        } else if (cat.name === 'receiving') {
          const c = C[nm] ||= { rec: 0, yds: 0 }; c.rec += num(ix('REC', 'RECEPTIONS')); c.yds += num(ix('YDS', 'RECEIVINGYARDS'));
        }
      }
    }
  }
  const att = Object.values(P).reduce((a, p) => a + p.att, 0), cmp = Object.values(P).reduce((a, p) => a + p.cmp, 0);
  const car = Object.values(R).reduce((a, r) => a + r.car, 0);
  const yds = Object.values(P).reduce((a, p) => a + p.yds, 0) + Object.values(R).reduce((a, r) => a + r.yds, 0);
  const cr = att ? Math.max(0.4, cmp / att) : 0.62; // ESPN box scores have no targets, so estimate them from catches
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const teams = {
    qbs: top(Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.att])), 3).filter(x => x[1] > 0),
    rush: Object.entries(R).filter(([, r]) => r.car > 0).sort((a, b) => b[1].car - a[1].car).slice(0, 7).map(([k, r]) => [k, r.car, r.yds, r.td]),
    recv: Object.entries(C).filter(([, c]) => c.rec > 0).sort((a, b) => b[1].rec - a[1].rec).slice(0, 10).map(([k, c]) => [k, Math.max(c.rec, Math.round(c.rec / cr)), c.rec, c.yds]),
    games, plays: att + car, ypp: att + car ? +(yds / (att + car)).toFixed(2) : 0, passrate: att + car ? +(att / (att + car)).toFixed(3) : 0.49,
    opps: done.map(opp), source: 'espn',
  };
  const scoreOf = c => { const v = c?.score; return v == null ? null : typeof v === 'object' ? +(v.value ?? v.displayValue) : +v; };
  const played = evs.filter(e => e.competitions?.[0]?.status?.type?.state === 'post').map(e => {
    const c0 = e.competitions[0], cs = c0.competitors || [], me = cs.find(c => String(c.id ?? c.team?.id) === id), ot = cs.find(c => c !== me);
    const ms = scoreOf(me), os = scoreOf(ot), won = me?.winner === true || (ms != null && os != null && ms > os);
    return { id: String(e.id), date: e.date, opp: opp(e), away: me?.homeAway === 'away', neutral: !!c0.neutralSite, won, pf: ms, pa: os };
  });
  const pre = evs.filter(e => e.competitions?.[0]?.status?.type?.state === 'pre');
  // ESPN's matchup predictor (FPI) gives a win chance for future games that don't have a betting line yet
  const preds = await Promise.all(pre.map(e => get(`${BASE}/summary?event=${e.id}`, 3600000).then(d => {
    const pr = d.predictor || {}; const homeId = String((d.header?.competitions?.[0]?.competitors || []).find(c => c.homeAway === 'home')?.id ?? '');
    const mine = homeId === id ? pr.homeTeam : pr.awayTeam, v = parseFloat(mine?.gameProjection);
    const od = (d.pickcenter || [])[0];
    return { fpi: isFinite(v) ? v / 100 : null, line: od?.details || null };
  }).catch(() => ({}))));
  const upcoming = pre.map((e, i) => {
    const cs = e.competitions?.[0]?.competitors || [], me = cs.find(c => String(c.id ?? c.team?.id) === id);
    return { id: String(e.id), date: e.date, opp: opp(e), away: me?.homeAway === 'away', neutral: !!e.competitions?.[0]?.neutralSite, ...preds[i] };
  });
  return { id, usage: teams, played, upcoming };
}

// Memoized ESPN fetch. Concurrent callers share one request; results live for ttl ms.
const memo = new Map();
function get(url, ttl = 4000) {
  const now = Date.now(), hit = memo.get(url);
  if (hit && hit.exp > now) return hit.p;
  const p = (async () => {
    const r = await fetch(url, { headers: { 'User-Agent': 'cfb-sim/2.0' }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(`ESPN returned ${r.status}`);
    return r.json();
  })();
  memo.set(url, { exp: now + ttl, p });
  p.catch(() => memo.delete(url));
  if (memo.size > 600) for (const [k, v] of memo) if (v.exp <= now) memo.delete(k);
  return p;
}

// Keep only what the simulator needs. ESPN's summary payload is large and its shape can change, so every field is optional.
function trimSummary(d) {
  const comp = d.header?.competitions?.[0] || {};
  const comps = (comp.competitors || []).map(c => ({
    id: String(c.id ?? c.team?.id), homeAway: c.homeAway, abbr: c.team?.abbreviation, name: c.team?.displayName,
    score: +c.score || 0, winner: !!c.winner,
  }));
  const pc = (d.pickcenter || [])[0] || {};
  const odds = { details: pc.details || null, overUnder: pc.overUnder ?? null, spread: pc.spread ?? null,
    homeFav: pc.homeTeamOdds?.favorite ?? null, raw: pc };
  const plays = [];
  const drives = [...(d.drives?.previous || []), ...(d.drives?.current ? [d.drives.current] : [])];
  for (const dr of drives) for (const p of dr.plays || []) plays.push(slim(p, dr.team?.id));
  if (!plays.length) for (const p of d.plays || []) plays.push(slim(p, null));
  const wp = (d.winprobability || []).map(w => ({ id: String(w.playId), home: w.homeWinPercentage }));
  return { state: comp.status?.type?.state || null, comps, odds, plays, wp };
}
function slim(p, driveTeam) {
  const s = p.start || {};
  return {
    id: String(p.id), text: p.text || '', type: p.type?.text || '', period: p.period?.number ?? null,
    clock: p.clock?.displayValue ?? null, hs: p.homeScore ?? null, as: p.awayScore ?? null,
    down: s.down ?? null, dist: s.distance ?? null, ytez: s.yardsToEndzone ?? null,
    team: String(s.team?.id ?? driveTeam ?? ''),
  };
}
function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` },
  });
}
