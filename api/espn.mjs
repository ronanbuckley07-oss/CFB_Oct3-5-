// ESPN proxy, served at /api/espn by server.mjs. The browser never calls ESPN directly, and every ESPN response is
// memoized briefly in memory, so a hundred people watching the board cost the same as one.
//   ?kind=scoreboard[&scope=top|fbs][&date=YYYYMMDD] -> this week's games, trimmed for the home page (no sims)
//   ?kind=card&event=ID[&date=YYYYMMDD]  -> one game in the same trimmed shape, for the game page's start screen
//   ?kind=pregame&event=ID               -> three pregame reads (sportsbooks, ESPN FPI, prediction markets) as point spreads, averaged
//   ?kind=box&event=ID                   -> box score: team stats and player stat lines
//   ?kind=markets&event=ID[&kalshi=TICKER][&poly=SLUG] -> Kalshi and Polymarket win prices for both teams
//   ?event=ID&date=YYYYMMDD           -> that game's scoreboard entry (live state, odds)       [original behavior]
//   ?kind=summary&event=ID            -> trimmed game summary: teams, line, every play, ESPN win probability
//   ?kind=list&date=YYYYMMDD          -> finished FBS games on that date (for backtesting)
//   ?kind=find&q=Michigan at Ohio State  (or &event=ID) -> the ESPN game, its date, and both teams' names and colors
//   ?kind=team&id=TEAMID              -> player usage from this season's box scores, plus the team's schedule
// One handler per league. Everything below is shared; LG carries what differs (ESPN path, market series, spread SD).
export const LEAGUES = {
  cfb: { id: 'cfb', base: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football', sbq: 'groups=80', kx: 'KXNCAAF',
    poly: /^(cfb|ncaaf|college-?football)$/i, polyTags: ['cfb', 'college-football', 'ncaaf'], sig: 15.5 },
  nfl: { id: 'nfl', base: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl', sbq: 'lang=en', kx: 'KXNFL',
    poly: /^nfl$/i, polyTags: ['nfl'], sig: 13.0 },
};
export function createHandler(LG) {
const BASE = LG.base;
const handler = async (req) => {
  const u = new URL(req.url);
  const kind = u.searchParams.get('kind') || 'game';
  const event = (u.searchParams.get('event') || '').replace(/\D/g, '');
  const date = (u.searchParams.get('date') || '').replace(/\D/g, '');
  try {
    if (kind === 'scoreboard') {
      const scope = u.searchParams.get('scope') === 'fbs' ? 'fbs' : 'top';
      const d = await get(`${BASE}/scoreboard?${LG.sbq}&limit=400${date ? `&dates=${date}` : ''}`, 3000);
      const now = Date.now();
      // A final leaves the board 6 hours after it ended (first time this server saw it final, capped at kickoff + 4.5 h)
      const all = (d.events || []).map(trimEvent).filter(Boolean).filter(g => {
        if (g.state !== 'post') return true;
        const kick = Date.parse(g.date) || now, seen = finalSeen.get(g.id) ?? now;
        return now - Math.min(seen, kick + 4.5 * 3600000) < 6 * 3600000;
      });
      const top = all.filter(g => g.home.rank || g.away.rank);
      const games = scope === 'top' && top.length ? top : all;
      return json({ updated: new Date().toISOString(), scope, fallback: scope === 'top' && !top.length,
        week: d.week?.number ?? null, counts: { top: top.length, fbs: all.length }, games }, 200, 2);
    }
    if (kind === 'card') {
      if (!event) return json({ error: 'missing event' }, 400);
      let dt = date;
      if (!dt) { const s = await get(`${BASE}/summary?event=${event}`, 8000); dt = etDate(s.header?.competitions?.[0]?.date); }
      const d = await get(`${BASE}/scoreboard?${LG.sbq}&limit=400${dt ? `&dates=${dt}` : ''}`, 10000);
      const ev = (d.events || []).find(e => String(e.id) === event);
      if (!ev) return json({ error: 'game not found' }, 404);
      return json({ ...trimEvent(ev), etDate: dt }, 200, 10);
    }
    if (kind === 'pregame') {
      if (!event) return json({ error: 'missing event' }, 400);
      return json(await pregame(event), 200, 60);
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
      const d = await get(`${BASE}/scoreboard?${LG.sbq}&limit=300&dates=${date}`, 300000);
      const games = (d.events || []).filter(e => e.status?.type?.state === 'post').map(e => {
        const c = e.competitions?.[0] || {};
        const t = (c.competitors || []).map(x => ({ id: x.id, homeAway: x.homeAway, abbr: x.team?.abbreviation, score: +x.score || 0 }));
        return { id: e.id, name: e.shortName || e.name, teams: t, line: c.odds?.[0]?.details || null };
      });
      // ESPN drops odds from the scoreboard once a game is final, but the game summary keeps the closing line
      const need = games.filter(g => !g.line);
      for (let i = 0; i < need.length; i += 10) await Promise.all(need.slice(i, i + 10).map(g =>
        get(`${BASE}/summary?event=${g.id}`, 3600000).then(d => {
          const pc = (d.pickcenter || [])[0] || {};
          g.line = pc.details || null; g.ou = pc.overUnder ?? null;
          if (!g.line) { const w = (d.winprobability || [])[0]; if (w && typeof w.homeWinPercentage === 'number') g.pregame = true; }
        }).catch(() => {})));
      return json({ date, games }, 200, 300);
    }
    if (!event) return json({ error: 'missing event' }, 400);
    const data = await get(`${BASE}/scoreboard?${LG.sbq}&limit=300${date ? `&dates=${date}` : ''}`, 800);
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
  if (ty.state === 'post') { wpHome = home.winner ? 1 : away.winner ? 0 : null; if (!finalSeen.has(id)) finalSeen.set(id, Date.now()); }
  // ESPN often removes odds from the scoreboard once a game kicks off; keep the last line it showed
  const od0 = c.odds?.[0] || {};
  if (od0.details || od0.overUnder != null) lineSeen.set(id, { details: od0.details || null, overUnder: od0.overUnder ?? null });
  const od = (od0.details || od0.overUnder != null) ? od0 : (lineSeen.get(id) || {});
  return { id, phase, date: e.date, state: ty.state || null, detail: ty.shortDetail || ty.detail || null,
    period: st.period ?? null, clock: st.displayClock ?? null, neutral: !!c.neutralSite,
    tv: c.broadcasts?.[0]?.names?.[0] || c.broadcast || null, home, away, sit: s, wpHome,
    line: od.details || null, ou: od.overUnder ?? null };
}

const lastWp = new Map(), finalSeen = new Map(), lineSeen = new Map();
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
  if (t.mascot && L.includes(' ' + words(t.mascot).join(' ') + ' ')) best = Math.max(best, 0.85);
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

async function kalshiEvents(kind = 'GAME') {
  const out = []; let cursor = '';
  for (let page = 0; page < 6; page++) {
    const q = `/events?series_ticker=${LG.kx}${kind}&status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const d = await getAny(KALSHI.map(b => b + q), 20000);
    out.push(...(d.events || [])); cursor = d.cursor; if (!cursor || !(d.events || []).length) break;
  }
  return out;
}
async function kalshiFor(A, B, pin, t0, t1, kickoff) {
  let events;
  if (pin) {
    const evT = pin.toUpperCase().split('-').slice(0, 2).join('-').replace(new RegExp(`^${LG.kx}(SPREAD|TOTAL)`), `${LG.kx}GAME`);
    const d = await getAny(KALSHI.map(b => `${b}/events/${evT}?with_nested_markets=true`), 20000);
    events = [d.event ? { ...d.event, markets: d.markets || d.event.markets } : d];
  } else events = await kalshiEvents();
  let best = null;
  const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const kick = kickoff ? new Date(kickoff).getTime() : null;
  for (const ev of events) {
    const dm = String(ev.event_ticker || '').match(/-(\d{2})([A-Z]{3})(\d{2})/);
    if (kick && dm && MON[dm[2]] != null && Math.abs(Date.UTC(2000 + +dm[1], MON[dm[2]], +dm[3]) - kick) > 2 * 86400000) continue;
    const title = `${ev.title || ''} ${ev.sub_title || ''}`;
    const sc = nameScore(title, A) + nameScore(title, B);
    if (sc >= 1 && (!best || sc > best.sc)) best = { sc, ev };
  }
  if (!best) return { found: false, checked: events.length };
  const tk = best.ev.event_ticker || '';
  const res = { found: true, title: best.ev.title, ticker: tk, url: `https://kalshi.com/markets/${LG.kx.toLowerCase()}game/${tk.toLowerCase()}`, spreads: [], totals: [] };
  const side = label => { const sa = nameScore(label, A), sb = nameScore(label, B); return sa > sb && sa > 0 ? 'A' : sb > sa && sb > 0 ? 'B' : null; };
  const px = m => midPrice(m.yes_bid_dollars ?? m.yes_bid, m.yes_ask_dollars ?? m.yes_ask, m.last_price_dollars ?? m.last_price);
  const tickers = {};
  for (const m of best.ev.markets || []) {
    const pr = px(m); if (!pr) continue;
    const label = `${m.yes_sub_title || ''} ${m.subtitle || ''} ${String(m.ticker || '').split('-').pop()}`;
    const sd = side(label); if (!sd) continue;
    res[sd] = { ...pr, label: m.yes_sub_title || m.ticker, vol: +(m.volume_fp ?? m.volume) || null }; tickers[sd] = m.ticker;
  }
  if (res.A && !res.B) res.B = { p: 1 - res.A.p, implied: true }; if (res.B && !res.A) res.A = { p: 1 - res.B.p, implied: true };
  // Spread and total ladders live in sibling series with the same game code: "X wins by over 14.5 points", "Over 46.5 points scored"
  const code = tk.replace(new RegExp(`^${LG.kx}GAME-`), '');
  // Same game code first; if Kalshi named the spread/total event differently, match its title and date like the game
  const sibling = async kind => {
    let ms = await getAny(KALSHI.map(b => `${b}/events/${LG.kx}${kind}-${code}?with_nested_markets=true`), 20000).then(d => d.markets || d.event?.markets || []).catch(() => []);
    if (ms.length) return ms;
    const evs = await kalshiEvents(kind).catch(() => []);
    let pick = null;
    for (const ev of evs) {
      const dm = String(ev.event_ticker || '').match(/-(\d{2})([A-Z]{3})(\d{2})/);
      if (kick && dm && MON[dm[2]] != null && Math.abs(Date.UTC(2000 + +dm[1], MON[dm[2]], +dm[3]) - kick) > 2 * 86400000) continue;
      const sc = nameScore(`${ev.title || ''} ${ev.sub_title || ''}`, A) + nameScore(`${ev.title || ''} ${ev.sub_title || ''}`, B);
      if (sc >= 1 && (!pick || sc > pick.sc)) pick = { sc, ev };
    }
    return pick ? pick.ev.markets || [] : [];
  };
  const [sp, to] = await Promise.all([sibling('SPREAD'), sibling('TOTAL')]);
  for (const m of sp) {
    const pr = px(m); if (!pr) continue; const txt = `${m.yes_sub_title || ''} ${m.title || ''}`;
    const by = isFinite(+m.floor_strike) ? +m.floor_strike : +((txt.match(/over\s*([\d.]+)/i) || [])[1]);
    const sd = side(m.yes_sub_title || txt); if (sd && isFinite(by)) res.spreads.push({ side: sd, by, p: pr.p });
  }
  for (const m of to) {
    const pr = px(m); if (!pr) continue; const txt = `${m.yes_sub_title || ''} ${m.title || ''}`;
    const line = isFinite(+m.floor_strike) ? +m.floor_strike : +((txt.match(/over\s*([\d.]+)/i) || [])[1]);
    if (isFinite(line)) res.totals.push({ line, p: /under|below/i.test(m.yes_sub_title || '') ? 1 - pr.p : pr.p });
  }
  // Minute-by-minute price history for the game-winner market, so the chart has Kalshi's line from kickoff
  const hk = tickers.A || tickers.B;
  if (hk && t0) {
    try {
      const q = `/series/${LG.kx}GAME/markets/${hk}/candlesticks?start_ts=${t0}&end_ts=${t1}&period_interval=1`;
      const d = await getAny(KALSHI.map(b => b + q), 60000);
      const flip = !tickers.A;
      res.hist = (d.candlesticks || []).map(c => {
        const pr = midPrice(c.yes_bid?.close_dollars ?? c.yes_bid?.close, c.yes_ask?.close_dollars ?? c.yes_ask?.close, c.price?.close_dollars ?? c.price?.close ?? c.price?.previous_dollars);
        return pr ? [c.end_period_ts * 1000, flip ? 1 - pr.p : pr.p] : null;
      }).filter(Boolean);
    } catch (e) { res.histError = String(e.message || e); }
  }
  return res;
}

async function polyEvents() {
  const lists = [];
  try {
    const sports = await get(`${GAMMA}/sports`, 3600000);
    const cfb = (Array.isArray(sports) ? sports : []).find(x => LG.poly.test(x.sport || ''));
    if (cfb?.series) for (const sid of String(cfb.series).split(',').filter(Boolean))
      lists.push(get(`${GAMMA}/events?series_id=${sid}&closed=false&limit=500`, 20000).catch(() => []));
  } catch {}
  for (const tag of LG.polyTags) lists.push(get(`${GAMMA}/events?tag_slug=${tag}&closed=false&limit=500`, 20000).catch(() => []));
  const seen = new Set(), out = [];
  for (const l of await Promise.all(lists)) for (const e of (Array.isArray(l) ? l : l?.data || [])) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
  return out;
}
const PERIOD = /\b(1h|2h|1st half|2nd half|first half|second half|halftime|half|quarter|q[1-4]|[1-4]q|1st quarter|2nd quarter|3rd quarter|4th quarter)\b/i;
const parseArr = x => { if (Array.isArray(x)) return x; try { return JSON.parse(x || '[]'); } catch { return []; } };
async function polyFor(A, B, pin, kickoff, t0, t1) {
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
  let ev = best.ev;
  // Spread and total markets sometimes sit in a companion "-more-markets" event
  const evs = [ev];
  try { const more = await get(`${GAMMA}/events/slug/${ev.slug}-more-markets`, 60000); if (more?.markets) evs.push(more); } catch {}
  const res = { found: true, title: ev.title, slug: ev.slug, url: `https://polymarket.com/event/${ev.slug}`, spreads: [], totals: [] };
  const side = o => { const sa = nameScore(o, A), sb = nameScore(o, B); return sa > sb && sa > 0 ? 'A' : sb > sa && sb > 0 ? 'B' : null; };
  let token = null;
  for (const m of evs.flatMap(e => e.markets || [])) {
    if (m.closed && !m.active) continue;
    const outs = parseArr(m.outcomes), prices = parseArr(m.outcomePrices).map(Number); if (outs.length !== 2) continue;
    const pr0 = midPrice(m.bestBid, m.bestAsk, m.lastTradePrice ?? prices[0]); // quoted for the first outcome
    const p0 = pr0 ? pr0.p : prices[0]; if (!(p0 >= 0 && p0 <= 1)) continue;
    const q = `${m.question || ''} ${m.groupItemTitle || ''}`, type = m.sportsMarketType || '';
    // Only full-game markets: no halves, quarters, team totals or player props, and only ones people are actually trading
    if (type && !['moneyline', 'spreads', 'totals'].includes(type)) continue;
    if (PERIOD.test(q) || /team total|player|passing|rushing|receiving|yards|touchdowns?\b|first to|safety|overtime|margin/i.test(q)) continue;
    const priced = (+m.bestBid > 0 && +m.bestAsk > 0 && +m.bestAsk < 1) || (+m.lastTradePrice > 0 && +m.lastTradePrice < 1);
    if (/total|o\/u|over/i.test(type + ' ' + q) && /over/i.test(outs[0] + outs[1])) {
      if (!priced) continue;
      const line = isFinite(+m.line) && +m.line > 0 ? +m.line : +((q.match(/o\/u\s*([\d.]+)/i) || q.match(/([\d]+\.5)\s*$/) || [])[1]);
      const pOver = /over/i.test(outs[0]) ? p0 : 1 - p0;
      if (isFinite(line) && line >= 20 && line <= 120) res.totals.push({ line, p: pOver, q: m.question });
    } else if (/spread/i.test(type + ' ' + q)) {
      if (!priced) continue;
      // "Spread: Ohio State (-14.5)" with outcomes [Ohio State, Iowa]: first outcome covers the number in parentheses
      const h = isFinite(+m.line) && +m.line !== 0 ? +m.line : +((q.match(/\(([-+]?[\d.]+)\)/) || [])[1]);
      const sd = side(outs[0]); if (sd && isFinite(h) && h !== 0 && Math.abs(h) <= 60) res.spreads.push({ side: sd, by: -h, p: p0, q: m.question });
    } else if (!res.A && (type === 'moneyline' || !/half|quarter|1h|2h/i.test(q))) {
      const s0 = side(outs[0]), s1 = side(outs[1]); if (!s0 || !s1 || s0 === s1) continue;
      const pA = s0 === 'A' ? p0 : 1 - p0;
      res.A = { p: pA, label: outs[s0 === 'A' ? 0 : 1], vol: +m.volume || null }; res.B = { p: 1 - pA, label: outs[s0 === 'A' ? 1 : 0] };
      if (pr0 && pr0.bid != null && pr0.ask != null) { res.A.bid = s0 === 'A' ? pr0.bid : 1 - pr0.ask; res.A.ask = s0 === 'A' ? pr0.ask : 1 - pr0.bid; }
      const toks = parseArr(m.clobTokenIds); token = toks[s0 === 'A' ? 0 : 1] || null;
    }
  }
  if (!res.A) res.found = false;
  if (token && t0) {
    try {
      const d = await get(`https://clob.polymarket.com/prices-history?market=${token}&startTs=${t0}&endTs=${t1}&fidelity=1`, 60000);
      res.hist = (d.history || []).map(h => [h.t * 1000, +h.p]).filter(h => h[1] >= 0 && h[1] <= 1);
    } catch (e) { res.histError = String(e.message || e); }
  }
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
  // Price history window: an hour before kickoff to now (or to a few hours after kickoff once it's over)
  const kick = comp.date ? Math.floor(new Date(comp.date).getTime() / 1000) : null;
  const t0 = kick ? kick - 3600 : null, t1 = kick ? Math.min(Math.floor(Date.now() / 1000), kick + 6 * 3600) : null;
  const [k, p] = await Promise.all([kalshiFor(A, B, kPin, t0, t1, comp.date).catch(e => ({ found: false, error: String(e.message || e) })),
    polyFor(A, B, pPin, comp.date, t0, t1).catch(e => ({ found: false, error: String(e.message || e) }))]);
  const flip = x => x === 'A' ? 'away' : 'home';
  const mirror = (x, y) => { if (x && y && x.bid != null && x.ask != null && y.bid == null) { y.bid = 1 - x.ask; y.ask = 1 - x.bid; } };
  const pack = r => !(r && r.found && r.A) ? r : (mirror(r.A, r.B), mirror(r.B, r.A), { ...r, away: r.A, home: r.B, A: undefined, B: undefined,
    spreads: (r.spreads || []).map(x => ({ ...x, side: flip(x.side) })).sort((a, b) => a.by - b.by),
    totals: (r.totals || []).sort((a, b) => a.line - b.line), hist: r.hist ? { away: r.hist } : null });
  const out = { at: new Date().toISOString(), awayId: A.id, homeId: B.id, kickoff: comp.date || null, kalshi: pack(k), poly: pack(p) };
  if (debug) {
    out.debug = { teams: [A, B] };
    try { out.debug.kalshiTitles = (await kalshiEvents()).map(e => `${e.event_ticker}: ${e.title}`).slice(0, 400); } catch (e) { out.debug.kalshiError = String(e.message || e); }
    try { out.debug.polyTitles = (await polyEvents()).map(e => `${e.slug}: ${e.title}`).slice(0, 400); } catch (e) { out.debug.polyError = String(e.message || e); }
  }
  return out;
}

// ---------- pregame read: three independent numbers, each turned into a home-team point spread ----------
const SIG = LG.sig; // SD of final margins around the spread (15.5 college, 13 NFL)
function invPhi(p) { // inverse normal CDF (Acklam)
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
    b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
    c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
    d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - 0.02425) return -invPhi(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const marginFromP = p => SIG * invPhi(Math.min(0.995, Math.max(0.005, p)));
async function pregame(event) {
  const d = await get(`${BASE}/summary?event=${event}`, 8000);
  const comp = d.header?.competitions?.[0] || {}, cs = comp.competitors || [];
  const home = cs.find(c => c.homeAway === 'home'), away = cs.find(c => c.homeAway === 'away');
  if (!home || !away) throw new Error('game not found');
  const hAbbr = String(home.team?.abbreviation || '').toUpperCase(), aAbbr = String(away.team?.abbreviation || '').toUpperCase();
  const sources = [];
  // 1. Sportsbooks: every book ESPN carries, averaged
  const books = [], totals = [];
  for (const pc of d.pickcenter || []) {
    let hm = null; const m = String(pc.details || '').match(/^(\S+)\s+([-+]?\d+(?:\.\d+)?)/);
    if (m) { const v = Math.abs(parseFloat(m[2])), t = m[1].toUpperCase(); hm = t === hAbbr ? v : t === aAbbr ? -v : null; }
    else if (/^\s*(even|pk|pick)/i.test(pc.details || '')) hm = 0;
    if (hm == null && isFinite(+pc.spread) && pc.spread !== null) hm = -(+pc.spread);
    if (hm != null) books.push({ hm, name: pc.provider?.name || 'book', details: pc.details });
    if (+pc.overUnder > 20) totals.push(+pc.overUnder);
  }
  if (books.length) sources.push({ key: 'book', name: books.length > 1 ? `Sportsbooks (${books.length})` : `Sportsbook${books[0].name !== 'book' ? ` (${books[0].name})` : ''}`,
    homeMargin: books.reduce((x, b) => x + b.hm, 0) / books.length, detail: books.map(b => b.details).filter(Boolean).join(', ') });
  // 2. ESPN's FPI matchup projection (a win chance, converted to a spread)
  const fp = parseFloat(d.predictor?.homeTeam?.gameProjection);
  if (isFinite(fp) && fp > 0 && fp < 100) sources.push({ key: 'fpi', name: 'ESPN FPI', homeMargin: marginFromP(fp / 100), detail: `${home.team?.abbreviation} ${fp.toFixed(1)}% to win` });
  // 3. Prediction markets: Kalshi and Polymarket's last price before kickoff, averaged, converted to a spread
  try {
    const mk = await markets(event);
    const kick = comp.date ? new Date(comp.date).getTime() : null, started = comp.status?.type?.state !== 'pre';
    const ps = [];
    for (const [nm, src] of [['Kalshi', mk.kalshi], ['Polymarket', mk.poly]]) {
      if (!src || !src.found) continue;
      let pAway = null;
      if (started && src.hist?.away?.length && kick) { const pre = src.hist.away.filter(h => h[0] <= kick); if (pre.length) pAway = pre[pre.length - 1][1]; }
      else if (!started) pAway = src.away?.p ?? null;
      if (pAway != null && pAway > 0 && pAway < 1) ps.push({ nm, pHome: 1 - pAway });
    }
    if (ps.length) { const pHome = ps.reduce((x, y) => x + y.pHome, 0) / ps.length;
      sources.push({ key: 'market', name: `Markets (${ps.map(x => x.nm).join(' + ')})`, homeMargin: marginFromP(pHome), detail: `${home.team?.abbreviation} ${(pHome * 100).toFixed(1)}% to win before kickoff` }); }
  } catch {}
  const n = sources.length, mean = n ? sources.reduce((x, y) => x + y.homeMargin, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(sources.reduce((x, y) => x + (y.homeMargin - mean) ** 2, 0) / (n - 1)) : 0;
  return { homeId: String(home.id ?? home.team?.id), awayId: String(away.id ?? away.team?.id), home: home.team?.abbreviation, away: away.team?.abbreviation,
    sources: sources.map(x => ({ ...x, homeMargin: +x.homeMargin.toFixed(2) })), homeMargin: mean == null ? null : +mean.toFixed(2), sd: +sd.toFixed(2),
    book: books.length ? +(books.reduce((x, b) => x + b.hm, 0) / books.length).toFixed(1) : null,
    total: totals.length ? +(totals.reduce((x, y) => x + y, 0) / totals.length).toFixed(1) : null };
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
    team: String(s.team?.id ?? driveTeam ?? ''), wc: p.wallclock || null,
  };
}
function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` },
  });
}

return handler;
}

export default createHandler(LEAGUES.cfb);
