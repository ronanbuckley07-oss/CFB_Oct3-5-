// Server-side live mode. A game is tracked only while at least one browser is connected to it (Server-Sent Events).
// While someone watches, the server checks ESPN every 3 seconds, and when the game state changes it runs the sims
// once and pushes the same result to every viewer. Nobody watching: no polling, no sims.
//
// Viewers who picked opposite sides ("show win probability for") share a game but get their own orientation, so a game
// costs at most two sim streams no matter how many people are watching.
import { readFileSync } from 'node:fs';
import { createPool } from './simpool.mjs';
import { createPicks } from './picks.mjs';

const POLL_MS = 1000, IDLE_STOP_MS = 60000, FORGET_MS = 20 * 60000;
const N_QUICK = 3000, N_FULL = 25000, N_OPT = 8000, N_BACKFILL = 1500;
const ESD_BASE = 5.5;
const DEF = { poss: 'ND', pos: 25, down: 1, dist: 10, qtr: 1, secs: 900, nd: 0, unc: 0, half2Recv: 'UNC', toND: 3, toUNC: 3 };

// Engine, tables and league settings come straight from the pages, so the browser and server can never disagree.
function readPage(file) {
  const html = readFileSync(file, 'utf8');
  const i = html.indexOf('<script id="engine-src">') + '<script id="engine-src">'.length;
  const engineSrc = html.slice(i, html.indexOf('</script>', i));
  const data = JSON.parse(html.match(/const DATA=(\{.*?\});\n/s)[1]);
  const LG = new Function(`return ${html.match(/const LG=(\{.*?\});/)[1]};`)();
  return { engineSrc, data, LG };
}

export function createLive({ api, pages, dataDir }) {
  const picks = createPicks({ api, dir: dataDir });
  // A missing or broken page disables live mode for that league instead of taking the whole site down
  const load = f => { try { return readPage(f); } catch (e) { console.error(`live: couldn't read ${f}: ${e.message}`); return null; } };
  const cfb = load(pages.cfb), nfl = load(pages.nfl);
  const LGS = { cfb: cfb && cfb.LG, nfl: nfl && nfl.LG };
  const datas = {}; if (cfb) datas.cfb = cfb.data; if (nfl) datas.nfl = nfl.data;
  const pool = (cfb || nfl) ? createPool({ engineSrc: (cfb || nfl).engineSrc, datas }) : null;
  const games = new Map();

  function handle(req, res, u) {
    const league = u.searchParams.get('league') === 'nfl' ? 'nfl' : 'cfb';
    const event = String(u.searchParams.get('event') || '').replace(/\D/g, '');
    const side = String(u.searchParams.get('side') || '').replace(/\D/g, '');
    if (!event) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('missing event'); return; }
    if (!pool || !LGS[league]) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('live mode unavailable for this league'); return; }
    const key = `${league}:${event}:${side}`;
    let g = games.get(key);
    if (!g) { g = new LiveGame(league, event, side); games.set(key, g); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    g.addViewer(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); g.removeViewer(res); });
  }
  function status() {
    return { leagues: Object.keys(datas), pool: pool ? pool.stats() : null, games: [...games.values()].map(g => ({ league: g.league, event: g.event, side: g.side, viewers: g.viewers.size,
      polling: !!g.timer, state: g.state, key: g.key, histPoints: g.hist.length, error: g.error || null })) };
  }
  // forget games nobody has watched for a while
  setInterval(() => { const now = Date.now(); for (const [k, g] of games) if (!g.viewers.size && now - g.lastSeen > FORGET_MS) { g.stop(); games.delete(k); } }, 60000).unref();

  class LiveGame {
    constructor(league, event, side) {
      Object.assign(this, { league, event, side, viewers: new Set(), timer: null, run: 0, key: null, S: null, hist: [], last: {}, lastSeen: Date.now(), fails: 0 });
      this.ready = this.init().catch(e => { this.error = String(e.message || e); });
    }
    call(q) { return api[this.league](new Request(`http://local/api?${q}`)).then(r => r.json()); }
    async init() {
      const g = await this.call(`kind=find&event=${this.event}`);
      if (!g || g.error) throw new Error(g && g.error || 'game not found');
      if (this.side && String(g.B.id) === this.side) { const t = g.A; g.A = g.B; g.B = t; } // chosen team takes slot A ("ND")
      this.date = g.date; this.teams = { [g.A.id]: 'ND', [g.B.id]: 'UNC' }; this.slotId = { ND: String(g.A.id), UNC: String(g.B.id) };
      { const aHome = String(g.homeId) === String(g.A.id); this.title = aHome ? `${g.B.short} at ${g.A.short}` : `${g.A.short} at ${g.B.short}`; } this.abbr = { ND: g.A.abbr || g.A.short, UNC: g.B.abbr || g.B.short };
      this.homeSlot = String(g.homeId) === String(g.A.id) ? 'ND' : 'UNC';
      const [ua, ub] = await Promise.all([g.A, g.B].map(t => this.call(`kind=team&id=${t.id}`).catch(() => null)));
      this.rosters = { ND: fillUsage(ua && ua.usage || {}), UNC: fillUsage(ub && ub.usage || {}) };
      this.tk = `${this.league}:${this.event}:${this.side}:${Date.now()}`;
      const base = { edge: 0, total: 52, esd: ESD_BASE, edgeSet: false };
      try { // the same three-source pregame read the page shows
        const pre = await this.call(`kind=pregame&event=${this.event}`);
        if (pre && pre.homeMargin != null) {
          base.edge = +((this.homeSlot === 'ND' ? 1 : -1) * pre.homeMargin).toFixed(1);
          base.esd = +Math.sqrt(ESD_BASE * ESD_BASE + pre.sd * pre.sd).toFixed(1);
          if (pre.total != null) base.total = pre.total; base.edgeSet = true;
        }
      } catch {}
      this.base = base;
      this.S = Object.assign({}, DEF, { edge: base.edge, total: base.total, esd: base.esd });
      await this.refreshHalf2();
    }
    async refreshHalf2() { // who gets the ball in the 3rd: the team that didn't take the first snap
      try { const sm = await this.call(`kind=summary&event=${this.event}`); this.summary = sm;
        const first = (sm.plays || []).find(p => this.teams[String(p.team)] && p.down >= 1);
        if (first) { this.S.half2Recv = this.teams[String(first.team)] === 'ND' ? 'UNC' : 'ND'; this.half2Known = true; } } catch {}
    }
    setup() { return { edge: this.S.edge, esd: this.S.esd, total: this.S.total, half2Recv: this.S.half2Recv, edgeSet: this.base.edgeSet, teams: this.teams }; }

    async addViewer(res) {
      this.viewers.add(res); this.lastSeen = Date.now(); clearTimeout(this.idle);
      await this.ready;
      if (this.error) { send(res, 'fail', { error: this.error }); return; }
      send(res, 'hello', { setup: this.setup(), hist: this.hist, last: this.last, viewers: this.viewers.size });
      this.broadcast('viewers', { viewers: this.viewers.size });
      this.start();
    }
    removeViewer(res) {
      this.viewers.delete(res); this.lastSeen = Date.now();
      this.broadcast('viewers', { viewers: this.viewers.size });
      if (!this.viewers.size) this.idle = setTimeout(() => { if (!this.viewers.size) this.stop(); }, IDLE_STOP_MS);
    }
    broadcast(type, data) { for (const r of this.viewers) send(r, type, data); }
    start() { if (this.timer) return; this.poll(); this.timer = setInterval(() => this.poll(), POLL_MS); this.backfillTimer = setInterval(() => this.backfill(), 60000); this.backfill(); }
    stop() { clearInterval(this.timer); clearInterval(this.backfillTimer); this.timer = null; this.run++; }

    async poll() {
      if (this.polling) return; this.polling = true;
      try {
        if (Date.now() - (this.mkAt || 0) > 20000) { this.mkAt = Date.now(); this.call(`kind=markets&event=${this.event}`).then(m => { if (m && !m.error) this.mk = m; }).catch(() => {}); }
        const ev = await this.call(`event=${this.event}&date=${this.date}`);
        if (!ev || !ev.competitions) throw new Error(ev && ev.error || 'not in feed');
        this.fails = 0;
        const o = parseEspn(ev, this.teams, this.abbr, this.homeSlot);
        this.state = o.state;
        if (!this.base.edgeSet && (o.edge != null || o.total)) { if (o.edge != null) this.S.edge = o.edge; if (o.total) this.S.total = o.total; this.base.edgeSet = true; }
        for (const k of ['qtr', 'secs', 'nd', 'unc', 'poss', 'down', 'dist', 'pos', 'toND', 'toUNC']) if (o[k] != null) this.S[k] = o[k];
        if (this.S.pos != null) this.S.dist = Math.min(this.S.dist, 100 - this.S.pos);
        if (o.state === 'in' && !this.half2Known) this.refreshHalf2();
        // Re-simulate after every play (new down, spot, possession, score or play text), not every clock tick
        if (simDue(o, this.lastSim)) {
          this.lastSim = { pk: playKey(o), secs: o.secs, lp: o.lastPlay };
          this.key = JSON.stringify([o.qtr, o.secs, o.nd, o.unc, o.poss, o.down, o.dist, o.pos]);
          this.simulate(this.key, Object.assign({}, this.S));
        }
        const slim = trimEv(ev), sj = JSON.stringify(slim);
        if (sj !== this.lastEv) { this.lastEv = sj; this.last.ev = slim; this.last.skey = this.key; this.broadcast('ev', { ev: slim, skey: this.key }); }
        if (o.state === 'post') { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), 30000); }
      } catch (e) {
        if (++this.fails % 5 === 0) this.broadcast('warn', { error: String(e.message || e) });
      } finally { this.polling = false; }
    }

    async simulate(key, S) {
      const id = ++this.run, alive = () => id === this.run && this.viewers.size > 0;
      const S0 = prepS0(S, S.edge, S.total, LGS[this.league].cal);
      const sim = (N, prio, force) => pool.run(this.league, this.rosters, this.tk, S0, N, { prio, alive, force });
      const fields = { edge: S.edge, esd: S.esd, total: S.total, half2Recv: S.half2Recv };
      try {
        const a1 = await sim(N_QUICK, 3); if (!a1 || !alive()) return;
        this.last.result = { key, A: a1, final: false, S: fields }; this.broadcast('result', this.last.result);
        const a2 = await sim(N_FULL - N_QUICK, 3); if (!a2 || !alive()) return;
        const A = pool.mergeAgg(a1, a2);
        this.last.result = { key, A, final: true, S: fields }; this.last.fourth = null; this.broadcast('result', this.last.result);
        const pt = { k: JSON.stringify([S.poss, S.pos, S.down, S.dist, S.qtr, S.secs, S.nd, S.unc, S.edge]), wp: A.win / A.n, t: elapsed(S) };
        const at = this.hist.findIndex(h => h.k === pt.k); if (at >= 0) this.hist[at] = pt; else this.hist.push(pt);
        this.broadcast('hist', { pts: [pt] });
        if (this.mk && this.state !== 'post') {
          this.last.edges = { key, edges: picks.consider(this, A, this.mk, S), logged: picks.forEvent(this.league, this.event) };
          this.broadcast('edges', this.last.edges);
        }
        if (S.down === 4) { // the 4th-down decision bot: each option simulated separately
          const ytg = 100 - S.pos, fgd = ytg + 17, fgMax = (this.league === 'nfl' ? nfl : cfb).data.rules?.fgMax ?? 60;
          const opts = [['go', 'Go for it']]; if (ytg > 30) opts.push(['punt', 'Punt']); if (fgd <= fgMax) opts.push(['fg', `Field goal (${fgd} yds)`]);
          const res = [];
          for (const [k, lab] of opts) { const R = await sim(N_OPT, 2, k); if (!R || !alive()) return; const w = R.win / R.n; res.push({ k, lab, wp: S.poss === 'ND' ? w : 1 - w, n: R.n, mar: R.marSum / R.n }); }
          this.last.fourth = { key, res }; this.broadcast('fourth', this.last.fourth);
        }
      } catch (e) { this.broadcast('warn', { error: `sim failed: ${e.message || e}` }); }
    }

    // Fill in the model line for plays before anyone was watching, at low priority. Shared by every viewer.
    async backfill() {
      if (this.backfilling || !this.viewers.size) return; this.backfilling = true;
      try {
        const sm = await this.call(`kind=summary&event=${this.event}`); this.summary = sm;
        const states = histStates(sm, this.teams); const upTo = sm.state === 'post' ? 3601 : elapsed(this.S);
        const have = () => this.hist.map(h => h.t);
        const todo = states.filter((st, i) => i % 2 === 0).map(st => ({ st, t: elapsed(st) })).filter(x => x.t > 0 && x.t < upTo - 5 && !have().some(t => Math.abs(t - x.t) < 25));
        const batch = [];
        for (const x of todo) {
          if (!this.viewers.size) break;
          const st = Object.assign({}, x.st, { esd: this.S.esd });
          const A = await pool.run(this.league, this.rosters, this.tk, prepS0(st, this.S.edge, this.S.total, LGS[this.league].cal), N_BACKFILL, { prio: 1, alive: () => this.viewers.size > 0 });
          if (!A) break;
          const pt = { k: JSON.stringify([st.poss, st.pos, st.down, st.dist, st.qtr, st.secs, st.nd, st.unc, this.S.edge]), wp: A.win / A.n, t: x.t, bf: true };
          this.hist.push(pt); batch.push(pt);
          if (batch.length >= 6) { this.broadcast('hist', { pts: batch.splice(0) }); }
        }
        if (batch.length) this.broadcast('hist', { pts: batch });
        this.hist.sort((a, b) => a.t - b.t);
      } catch {} finally { this.backfilling = false; }
    }
  }
  return { handle, status, leagues: Object.keys(datas), picks };
}

// A new play changes the down, spot, possession, score or ESPN's play text. The clock alone only counts once 30 seconds
// have run off (5 seconds inside the last two minutes of a half, where the clock itself moves win probability).
const playKey = o => [o.qtr, o.nd, o.unc, o.poss, o.down, o.dist, o.pos].join('|');
function simDue(o, last) {
  if (!last || playKey(o) !== last.pk || (o.lastPlay && o.lastPlay !== last.lp)) return true;
  if (o.secs == null || last.secs == null) return false;
  const late = (o.qtr === 2 || o.qtr === 4) && o.secs <= 120;
  return Math.abs(last.secs - o.secs) >= (late ? 5 : 30);
}
// ---------- helpers ported from the page (kept identical so keys and states match the browser's) ----------
function send(res, type, data) { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
const elapsed = s => (Math.min(4, s.qtr) - 1) * 900 + (900 - s.secs);
function prepS0(st, spread, total, CAL) {
  const tilt = Math.max(-0.3, Math.min(0.5, (CAL.a + CAL.b * Math.abs(spread) - total) / CAL.d)), k = CAL.k * (1 + 0.6 * Math.abs(tilt));
  return Object.assign({}, st, { spread, total, tilt, edge: spread * k, esd: (st.esd ?? 5.5) * k });
}
function fillUsage(u) {
  const ok = a => Array.isArray(a) && a.length;
  return { qbs: ok(u.qbs) ? u.qbs : [['Starting QB', 1]], rush: ok(u.rush) ? u.rush : [['Lead back', 1, 4, 0]], recv: ok(u.recv) ? u.recv : [['Top receiver', 2, 1, 10]],
    games: u.games || 0, plays: u.plays || 0, ypp: u.ypp || 0, passrate: u.passrate || 0.49, opps: u.opps || [], source: 'espn' };
}
const lineNum = v => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[^\d.+-]/g, '')); return isFinite(n) ? n : null; };
function readOdds(o, homeSlot, abbr) {
  if (!o) return {}; const r = { line: o.details || null };
  r.total = lineNum(o.overUnder) ?? lineNum(o.total); if (!(r.total > 20)) r.total = null;
  const m = String(o.details || '').match(/^(\S+)\s+([-+]?\d+(?:\.\d+)?)/);
  if (m) { const v = -parseFloat(m[2]), a = m[1].toUpperCase(); if (a === String(abbr.ND).toUpperCase()) r.edge = v; else if (a === String(abbr.UNC).toUpperCase()) r.edge = -v; }
  else if (/^\s*(pk|even)/i.test(o.details || '')) r.edge = 0;
  if (r.edge == null) { const hs = lineNum(o.spread) ?? lineNum(o.pointSpread?.home); if (hs != null && homeSlot) { const hf = -hs; r.edge = homeSlot === 'ND' ? hf : -hf; } }
  return r;
}
function clockToSecs(c) { const m = String(c || '').match(/(\d+):(\d+)/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function parseEspn(ev, teams, abbr) {
  const comp = (ev.competitions || [])[0] || {}; const out = {};
  const st = comp.status || ev.status || {}; out.state = st.type && st.type.state; out.detail = st.type && (st.type.shortDetail || st.type.detail);
  if (st.period) out.qtr = Math.min(4, st.period); const cs = clockToSecs(st.displayClock); if (cs != null && st.period) out.secs = cs;
  const ha = {}; for (const c of comp.competitors || []) { const t = teams[String(c.id || (c.team && c.team.id))]; if (t) { out[t === 'ND' ? 'nd' : 'unc'] = parseInt(c.score) || 0; ha[c.homeAway] = t; } }
  const R = readOdds((comp.odds || [])[0], ha.home, abbr); if (R.total) out.total = R.total; if (R.edge != null) out.edge = R.edge;
  const sit = comp.situation;
  if (sit) {
    const pt = teams[String(sit.possession)]; if (pt) out.poss = pt;
    if (sit.down >= 1 && sit.down <= 4) { out.down = sit.down; if (sit.distance > 0) out.dist = sit.distance; }
    const p = String(sit.possessionText || '').match(/^(\w+)\s+(\d+)/);
    if (p && out.poss) { const sv = p[1].toUpperCase(), side = sv === String(abbr.ND).toUpperCase() ? 'ND' : sv === String(abbr.UNC).toUpperCase() ? 'UNC' : null; const yl = +p[2]; if (side) out.pos = side === out.poss ? yl : 100 - yl; }
    else if (/50/.test(String(sit.possessionText || '')) && out.poss) out.pos = 50;
    if (sit.lastPlay && sit.lastPlay.text) out.lastPlay = sit.lastPlay.text;
    for (const s of ['home', 'away']) { const v = sit[s + 'Timeouts']; if (ha[s] && v != null && v >= 0 && v <= 3) out[ha[s] === 'ND' ? 'toND' : 'toUNC'] = +v; }
  }
  return out;
}
// Only what the page reads from a scoreboard entry, so each push stays small
function trimEv(ev) {
  const c = (ev.competitions || [])[0] || {};
  return { id: ev.id, status: ev.status, competitions: [{ status: c.status, odds: c.odds, situation: c.situation,
    competitors: (c.competitors || []).map(x => ({ id: x.id, homeAway: x.homeAway, score: x.score, team: x.team && { id: x.team.id, abbreviation: x.team.abbreviation } })) }] };
}
function histStates(g, teams) {
  const slot = id => teams[String(id)] || null, home = (g.comps || []).find(c => c.homeAway === 'home');
  if (!home) return [];
  const homeSlot = slot(home.id); if (!homeSlot) return [];
  const firstTeam = slot((g.plays || []).find(p => slot(p.team) && p.down >= 1)?.team), half2Recv = firstTeam === 'ND' ? 'UNC' : 'ND';
  let hs = 0, as = 0; const out = [];
  for (const p of g.plays || []) {
    const poss = slot(p.team), cs = clockToSecs(p.clock), skip = /kickoff|timeout|end of|extra point|two-point|conversion|coin toss/i.test(p.type + ' ' + p.text);
    if (!skip && poss && p.period >= 1 && p.period <= 4 && p.down >= 1 && p.down <= 4 && p.ytez >= 1 && p.ytez <= 99 && cs != null && p.dist >= 1) {
      const nd = homeSlot === 'ND' ? hs : as, unc = homeSlot === 'ND' ? as : hs;
      out.push({ poss, pos: 100 - p.ytez, down: p.down, dist: Math.min(p.dist, p.ytez), qtr: p.period, secs: Math.max(1, cs), nd, unc, half2Recv, toND: 3, toUNC: 3 });
    }
    if (p.hs != null) hs = +p.hs; if (p.as != null) as = +p.as;
  }
  return out;
}
