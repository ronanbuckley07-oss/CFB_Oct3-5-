// AP poll projection and season simulator, served at /api/ap/*. The math lives in api/apmodel.mjs; this file feeds it
// live ESPN data and keeps it learning.
//   GET /api/ap/poll        -> this week's AP poll, the projected next poll (live, simulated), the backtest and the
//                              running record of projection vs. the real poll
//   GET /api/ap/teams       -> every name-brand team: record and the simulated spread of final regular-season wins
//   GET /api/ap/team?id=ID  -> one team: every game with its result, live state or win probability, and the win spread
//
// Learning: every time ESPN posts a new AP poll, last week's poll + last week's results -> the new poll becomes new
// training rows. They are added to the model's sufficient statistics and the model is refit, and what the model said
// once the week's games were final is logged next to the real poll. Saved to DATA_DIR/ap_state.json.
// If ESPN can't be reached, it runs on api/apdata.json (built by tools/ap/build.mjs from sportsdataverse's copy of
// ESPN's schedules), so the page still works, just not live.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { G, ratings, features, fitStats, stats, addStats, projectPoll, seasonSim, gameOutlook, rankFrom, predictValues, p4Of } from './apmodel.mjs';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';
// ESPN conference ids for FBS conferences
const CONF = { 1: 'ACC', 4: 'Big 12', 5: 'Big Ten', 8: 'SEC', 9: 'Pac-12', 12: 'Conference USA', 15: 'Mid-American', 17: 'Mountain West', 18: 'FBS Independents', 37: 'Sun Belt', 151: 'American Athletic' };
const val = r => (r ? 26 - r : 0);

export function createAP({ dataDir, fetchImpl = fetch } = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const D = JSON.parse(fs.readFileSync(path.join(here, 'apdata.json'), 'utf8'));
  const season = D.season, teams = { ...D.teams };
  const file = dataDir ? path.join(dataDir, 'ap_state.json') : null;
  let st = { season, polls: {}, live: null, learned: [], log: [] };
  try { if (file) { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s.season === season) st = { ...st, ...s }; } } catch {}
  const save = () => { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('ap: save failed', e.message); } };
  const modelNow = () => (st.live ? fitStats({ R: addStats(D.stats.R, st.live.R), U: addStats(D.stats.U, st.live.U) }) : D.model);
  let model = modelNow();

  // ---------- ESPN ----------
  const memo = new Map();
  const get = (url, ttl) => {
    const now = Date.now(), hit = memo.get(url); if (hit && hit.exp > now) return hit.p;
    const p = (async () => { const r = await fetchImpl(url, { headers: { 'User-Agent': 'cfb-sim/2.0' }, signal: AbortSignal.timeout(9000) }); if (!r.ok) throw new Error(`ESPN ${r.status}`); return r.json(); })();
    memo.set(url, { exp: now + ttl, p }); p.catch(() => memo.delete(url));
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    return p;
  };
  // The AP poll from ESPN's rankings: { week, ranks: {id: rank}, points: {id: pts}, others: {id: pts}, names }
  function parseAP(d) {
    const list = d.rankings || [], ap = list.find(r => /^ap$/i.test(r.type || '')) || list.find(r => /\bAP\b/.test(`${r.name} ${r.shortName}`));
    if (!ap || !(ap.ranks || []).length) return null;
    const week = +(ap.occurrence?.number ?? ap.occurrence?.value ?? (String(ap.headline || '').match(/Week (\d+)/i) || [])[1]);
    const ranks = {}, points = {}, others = {}, names = {};
    for (const r of ap.ranks) { const id = String(r.team?.id || ''); if (!id || !r.current) continue; ranks[id] = r.current; points[id] = r.points ?? null; names[id] = r.team.location || r.team.nickname || r.team.name; }
    for (const r of ap.others || []) { const id = String(r.team?.id || ''); if (id) { others[id] = r.points ?? null; names[id] = r.team.location || r.team.nickname || r.team.name; } }
    return Number.isFinite(week) ? { week, ranks, points, others, names, at: ap.lastUpdated || ap.date || null } : null;
  }
  // One week of FBS games from ESPN's scoreboard -> compact rows + live state
  function parseBoard(d, w) {
    const rows = [], live = {};
    for (const e of d.events || []) {
      const c = e.competitions?.[0]; if (!c) continue;
      const H = (c.competitors || []).find(x => x.homeAway === 'home'), A = (c.competitors || []).find(x => x.homeAway === 'away'); if (!H || !A) continue;
      const state = c.status?.type?.state || e.status?.type?.state || 'pre';
      const side = x => { const id = String(x.team?.id || x.id), conf = CONF[x.team?.conferenceId];
        if (!teams[id] && conf) teams[id] = { id, name: x.team.location || x.team.displayName, conf, p4: p4Of(conf, season, x.team.location) };
        const rk = x.curatedRank?.current; return { id, name: x.team?.location || x.team?.displayName || id, conf: teams[id]?.conf || conf || null, div: teams[id] ? 'fbs' : 'fcs', rank: rk && rk <= 25 ? rk : null, score: x.score != null ? +x.score : null, abbr: x.team?.abbreviation }; };
      const h = side(H), a = side(A), post = state === 'post';
      rows.push([season, w, String(e.date || '').slice(0, 10), +h.id, h.name, h.conf, h.div, +a.id, a.name, a.conf, a.div, post ? h.score : null, post ? a.score : null, c.neutralSite ? 1 : 0, h.rank, a.rank, String(e.id)]);
      // the betting line, from the home team's side: "ALA -7.5" means ALA is favored by 7.5
      let line = null; const det = c.odds?.[0]?.details || '';
      if (/^even/i.test(det)) line = 0; else { const m = det.match(/^(\S+)\s+(-?\d+(?:\.\d+)?)/); if (m) { const x = Math.abs(+m[2]); if (m[1] === h.abbr) line = x; else if (m[1] === a.abbr) line = -x; } }
      const per = c.status?.period || 0, clk = c.status?.clock ?? 0, left = state === 'in' ? (per > 4 ? 0.02 : ((4 - per) * 900 + clk) / 3600) : 1;
      const prob = c.situation?.lastPlay?.probability?.homeWinPercentage;
      live[String(e.id)] = { state, lead: (h.score || 0) - (a.score || 0), left, prob: typeof prob === 'number' ? prob : null, line, clock: c.status?.type?.shortDetail || '', hs: h.score, as: a.score };
    }
    return { rows, live };
  }
  // A past AP poll from ESPN's core API (team ids come as $ref links)
  async function pastAP(w) {
    const d = await get(`${CORE}/seasons/${season}/types/2/weeks/${w}/rankings/1`, 86400000);
    const ranks = {}; for (const r of d.ranks || []) { const id = (String(r.team?.$ref || '').match(/teams\/(\d+)/) || [])[1]; if (id && r.current) ranks[id] = r.current; }
    return Object.keys(ranks).length >= 20 ? { week: w, ranks, at: d.date || null } : null;
  }

  // ---------- state: games, polls ----------
  const games = new Map(D.games.map(g => [g[G.id], g]));
  let live = {}, source = 'saved data', apNow = null, lastErr = null, refreshing = null, refreshedAt = 0, weeksAt = 0;
  const all = () => [...games.values()];
  const playedShare = w => { const x = all().filter(g => g[G.week] === w); return x.length ? x.filter(g => g[G.hp] != null).length / x.length : 0; };
  // The poll the projection starts from: ESPN's current AP poll, or (offline) the last poll rebuilt from game ranks
  function currentPoll() {
    if (apNow) return apNow;
    const ws = Object.keys(D.polls).map(Number).sort((a, b) => a - b), w = ws[ws.length - 1];
    return { week: w, ranks: D.polls[w], points: {}, others: {}, names: {}, at: null, rebuilt: true };
  }

  async function refresh(force = false) {
    if (refreshing) return refreshing;
    if (!force && Date.now() - refreshedAt < 15000) return;
    refreshing = (async () => {
      try {
        const ap = parseAP(await get(`${BASE}/rankings`, 60000));
        if (ap) { apNow = ap; source = 'ESPN'; if (!st.polls[ap.week]) { st.polls[ap.week] = { ranks: ap.ranks, at: ap.at }; save(); } }
        const W = (ap || currentPoll()).week;
        // this week's games every 15s; the whole season's schedule and results hourly
        const weeks = Date.now() - weeksAt > 3600000 ? Array.from({ length: 16 }, (_, i) => i + 1) : [W - 1, W].filter(x => x >= 1);
        const boards = await Promise.all(weeks.map(w => get(`${BASE}/scoreboard?groups=80&limit=400&seasontype=2&week=${w}&dates=${season}`, w === W ? 15000 : 3600000).then(d => ({ w, d })).catch(() => null)));
        let got = 0;
        for (const b of boards) { if (!b) continue; const p = parseBoard(b.d, b.w); for (const r of p.rows) games.set(r[G.id], r); Object.assign(live, p.live); got += p.rows.length; }
        if (weeks.length > 2 && got) weeksAt = Date.now();
        if (got) source = 'ESPN';
        await learn();
        lastErr = null;
      } catch (e) { lastErr = String(e.message || e); }
      refreshedAt = Date.now(); refreshing = null; cache.clear();
    })();
    return refreshing;
  }

  // ---------- learning ----------
  async function learn() {
    const W = apNow ? apNow.week : null; if (!W) return;
    // fill in this season's earlier polls once (ESPN core API), so the track record and learning cover the whole season
    for (let w = 2; w < W; w++) if (!st.polls[w]) { const p = await pastAP(w).catch(() => null); if (p) { st.polls[w] = { ranks: p.ranks, at: p.at }; save(); } }
    for (let w = Math.max(1, D.trained.week + 1); w < W; w++) {
      if (st.learned.includes(w) || !st.polls[w] || !st.polls[w + 1] || playedShare(w) < 0.9) continue;
      const prev = st.polls[w].ranks, next = st.polls[w + 1].ranks, G0 = all();
      const R = ratings(G0.filter(g => g[G.week] <= w), { prior: D.prior }), X = features(G0, season, w, prev, R, teams);
      // what the model said once the week was over, before it learns from the answer
      const proj = rankFrom(predictValues(model, X, prev)), rows = [];
      for (const [id, x] of Object.entries(X)) { if (!prev[id] && x[16] > 3) continue; rows.push({ x, y: val(next[id]), ranked: !!prev[id] }); }
      const add = { R: stats(rows.filter(r => r.ranked)), U: stats(rows.filter(r => !r.ranked)) };
      st.live = st.live ? { R: addStats(st.live.R, add.R), U: addStats(st.live.U, add.U) } : add;
      const act = Object.entries(next), predTop = new Set(Object.entries(proj).filter(([, r]) => r <= 25).map(([id]) => id));
      const miss = act.reduce((a, [id, r]) => a + Math.min(15, Math.abs((proj[id] || 40) - r)), 0) / act.length;
      st.log = st.log.filter(l => l.week !== w + 1).concat([{ week: w + 1, avgMiss: +miss.toFixed(2), top25: +(act.filter(([id]) => predTop.has(id)).length / act.length).toFixed(3), n: act.length,
        rows: act.sort((a, b) => a[1] - b[1]).map(([id, r]) => ({ id, name: teams[id]?.name || id, actual: r, proj: proj[id] ?? null, prev: prev[id] || null })) }]).sort((a, b) => a.week - b.week);
      st.learned.push(w); model = modelNow(); save();
      console.log(`ap: learned from week ${w} -> ${w + 1}: projection missed by ${miss.toFixed(2)} spots`);
    }
  }

  // ---------- outputs ----------
  const cache = new Map();
  const memoOut = (k, ttl, f) => { const h = cache.get(k); if (h && h.exp > Date.now()) return h.v; const v = f(); cache.set(k, { exp: Date.now() + ttl, v }); return v; };
  const rate = () => memoOut('R', 20000, () => ratings(all().filter(g => g[G.hp] != null), { prior: D.prior }));
  const nameOf = id => teams[id]?.name || apNow?.names?.[id] || id;
  function poll() {
    return memoOut('poll', 15000, () => {
      const P = currentPoll(), W = P.week, R = rate(), G0 = all();
      const sim = projectPoll({ games: G0, season, week: W, poll: P.ranks, R, teams, model, live, sims: 300 });
      const wk = G0.filter(g => g[G.week] === W), byTeam = {};
      for (const g of wk) for (const [me, op, home] of [[g[G.hid], g[G.aid], true], [g[G.aid], g[G.hid], false]]) {
        const o = sim.outlook[g[G.id]], L = live[g[G.id]] || {}, myP = home ? o.p : 1 - o.p;
        byTeam[me] = { opp: teams[op] ? nameOf(String(op)) : (home ? g[G.away] : g[G.home]), oppId: String(op), oppRank: P.ranks[op] || null, home, neutral: !!g[G.neutral],
          state: o.final ? 'post' : o.live ? 'in' : 'pre', clock: L.clock || '', us: home ? g[G.hp] ?? L.hs : g[G.ap] ?? L.as, them: home ? g[G.ap] ?? L.as : g[G.hp] ?? L.hs, p: +myP.toFixed(3), date: g[G.date] };
      }
      const counts = { final: 0, live: 0, upcoming: 0 }; for (const g of wk) { const o = sim.outlook[g[G.id]]; o.final ? counts.final++ : o.live ? counts.live++ : counts.upcoming++; }
      return {
        season, week: W, next: W + 1, source, rebuilt: !!P.rebuilt, updated: new Date().toISOString(), error: lastErr,
        current: Object.entries(P.ranks).sort((a, b) => a[1] - b[1]).map(([id, r]) => ({ id, name: nameOf(id), rank: r, points: P.points?.[id] ?? null })),
        projection: sim.teams.slice(0, 32).map(t => ({ ...t, name: nameOf(t.id), conf: teams[t.id]?.conf || null, game: byTeam[t.id] || null, hist: t.hist.slice(0, 26) })),
        games: counts, sims: sim.sims,
        model: { rows: D.trained.rows, learnedWeeks: st.learned.slice().sort((a, b) => a - b), sd: +model.sdR.toFixed(2) },
        backtest: D.backtest, log: st.log,
      };
    });
  }
  const seasonOut = () => memoOut('season', 60000, () => seasonSim({ games: all(), season, R: rate(), teams, live, sims: 4000 }));
  function teamList() {
    return memoOut('teams', 30000, () => {
      const S = seasonOut(), P = currentPoll(), ids = new Set([...D.brand, ...Object.keys(P.ranks)]);
      return { season, week: P.week, sims: S.sims, teams: [...ids].filter(id => S.teams[id] && teams[id]).map(id => {
        const s = S.teams[id]; return { id, name: nameOf(id), conf: teams[id].conf, rank: P.ranks[id] || null, w: s.w, l: s.l, games: s.games, mean: +s.mean.toFixed(2), hist: s.hist.map(p => +p.toFixed(4)) };
      }).sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.mean - a.mean) };
    });
  }
  function team(id) {
    id = String(id); if (!teams[id]) return null;
    const R = rate(), S = seasonOut().teams[id], P = currentPoll();
    const list = all().filter(g => String(g[G.hid]) === id || String(g[G.aid]) === id).sort((a, b) => a[G.week] - b[G.week] || (a[G.date] < b[G.date] ? -1 : 1));
    const sched = list.map(g => {
      const home = String(g[G.hid]) === id, op = String(home ? g[G.aid] : g[G.hid]), o = gameOutlook(R, g, live[g[G.id]]), L = live[g[G.id]] || {};
      const us = home ? g[G.hp] ?? L.hs : g[G.ap] ?? L.as, them = home ? g[G.ap] ?? L.as : g[G.hp] ?? L.hs, p = home ? o.p : 1 - o.p;
      return { week: g[G.week], date: g[G.date], opp: teams[op] ? nameOf(op) : (home ? g[G.away] : g[G.home]) || op, oppId: op, oppRank: P.ranks[op] || null, oppFcs: !teams[op], home, neutral: !!g[G.neutral],
        state: o.final ? 'post' : o.live ? 'in' : 'pre', clock: L.clock || '', us: us ?? null, them: them ?? null, won: o.final ? (us > them) : null, p: +p.toFixed(3), margin: +((home ? 1 : -1) * o.mu).toFixed(1) };
    });
    return { season, id, name: nameOf(id), conf: teams[id].conf, rank: P.ranks[id] || null, rating: +(R[id] ?? 0).toFixed(1), w: S.w, l: S.l, mean: +S.mean.toFixed(2), hist: S.hist.map(p => +p.toFixed(4)), sims: seasonOut().sims, games: sched };
  }

  const send = (res, code, obj, maxAge = 10) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` }); res.end(JSON.stringify(obj)); };
  async function handle(req, res, u) {
    await refresh().catch(() => {});
    const r = u.pathname.replace('/api/ap', '') || '/';
    if (r === '/poll') return send(res, 200, poll());
    if (r === '/teams') return send(res, 200, teamList(), 30);
    if (r === '/team') { const t = team((u.searchParams.get('id') || '').replace(/\D/g, '')); return t ? send(res, 200, t) : send(res, 404, { error: 'unknown team' }); }
    return send(res, 404, { error: 'not found' });
  }
  // keep learning even when nobody has the page open: new polls show up Sunday afternoons
  setInterval(() => refresh(true).catch(() => {}), 5 * 60000).unref();
  return { handle, refresh, poll, teamList, team, _state: () => st };
}
