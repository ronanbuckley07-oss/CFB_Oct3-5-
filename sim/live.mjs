// Server-side live simulation. One LiveGame per ESPN event, shared by everyone watching it.
//
// Nothing runs for a game nobody is watching. A game wakes when the first viewer connects (an open event stream, or a
// snapshot request in the last 45 seconds), polls ESPN on one shared timer, and runs the Monte Carlo once per new game
// state. Every viewer gets the same result pushed to them. When the last viewer leaves, polling and simulating stop after a
// short grace period; the game's history stays in memory for a few hours so the next viewer starts with the full chart.
//
// Orientation: engine slot 'A' is always the home team and 'B' the away team. Browsers flip to their chosen side.
import * as espn from '../api/espn.mjs';
import * as E from './engine.mjs';
import { PRIORITY } from './pool.mjs';

const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? +process.env[k] : d);
export const CFG = {
  pollLive: env('POLL_MS', 8000),      // ESPN check while a watched game is in progress
  pollPre: env('POLL_PRE_MS', 60000),  // before kickoff
  grace: env('IDLE_GRACE_MS', 30000),  // keep polling this long after the last viewer leaves
  touchTtl: 45000,                     // a snapshot request counts as watching for this long
  evict: env('EVICT_MS', 6 * 3600000), // forget an unwatched game after this
  nQuick: env('SIM_QUICK', 6000), nFull: env('SIM_N', 25000), nOpt: env('SIM_OPT', 8000), nFill: env('SIM_FILL', 1500),
  marketsEvery: 30000,
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const flipT = t => t === 'A' ? 'B' : 'A';
const clockToSecs = c => { const m = String(c || '').match(/(\d+):(\d+)/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const elapsed = s => s.qtr >= 5 ? 3600 + ((s.post ? 900 : 600) - s.secs) + (s.qtr - 5) * 900 : (Math.min(4, s.qtr) - 1) * 900 + (900 - s.secs);
const coreKey = s => JSON.stringify([s.poss, s.pos, s.down, s.dist, s.qtr, s.secs, s.a, s.b]);
const ord = n => ['', '1st', '2nd', '3rd', '4th'][n] || (n === 5 ? 'OT' : n + 'th');
const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const qLabel = s => s.qtr >= 5 ? 'OT' : `Q${s.qtr}`;

export function createLive({ pool, data, trading }) {
  E.setData(data); // main-thread copy, used for the situation tables and pure helpers
  const ESD_BASE = data.cal?.esd ?? 4;
  const games = new Map();
  let backtestQ = Promise.resolve();
  const btCache = new Map(), customCache = new Map();

  class LiveGame {
    constructor(id) {
      this.id = id; this.watchers = new Set(); this.touched = 0; this.lastActive = Date.now(); this.loopOn = false; this.v = 0;
      this.status = { state: null, detail: null, msg: 'Loading the game from ESPN…', level: 'warn' };
      this.ready = null; this.info = null; this.S = null; this.agg = null; this.aggFinal = false; this.pred = null; this.fourth = null;
      this.wpHist = []; this.plog = []; this.espnWP = []; this.WALL = []; this.MK = null; this.mkh = { k: [], p: [] }; this.mkHist = [];
      this.lastKey = ''; this.lastPlayText = null; this.lastWP = null; this.job = null; this.simKey = null; this.simInfo = null;
      this.trade = []; this.tradeNew = []; this.mkAt = 0; this.summary = null; this.bfBusy = false; this.done = false; this.under = null; this.edgeSet = false;
    }
    // ---------- viewers ----------
    watch(c) { this.watchers.add(c); this.lastActive = Date.now(); this.start(); }
    unwatch(c) { this.watchers.delete(c); this.lastActive = Date.now(); }
    touch() { this.touched = Date.now(); this.lastActive = Date.now(); this.start(); }
    active() { return this.watchers.size > 0 || Date.now() - this.touched < CFG.touchTtl; }
    viewers() { return this.watchers.size + (Date.now() - this.touched < CFG.touchTtl ? 1 : 0); }
    send(type, obj) {
      if (!this.watchers.size) return; const msg = `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
      for (const c of this.watchers) { try { c.write(msg); } catch { this.watchers.delete(c); } }
    }
    push(keys) { this.v++; const o = { v: this.v }; for (const k of keys) o[k] = this.field(k); this.send('update', o); }
    field(k) {
      switch (k) {
        case 'wpHist': return this.wpHist;
        case 'plog': return this.plog.slice(-60);
        case 'viewers': return this.viewers();
        default: return this[k];
      }
    }
    snapshot() {
      const keys = ['status', 'info', 'S', 'PRE', 'line', 'usage', 'agg', 'aggFinal', 'simInfo', 'fourth', 'wpHist', 'plog', 'espnWP', 'MK', 'mkh', 'under', 'viewers', 'trade', 'tradeNew'];
      const o = { v: this.v, event: this.id, cal: data.cal, meta: data.meta, tradeRules: trading ? trading.rules() : null }; for (const k of keys) o[k] = this.field(k); return o;
    }
    // ---------- lifecycle ----------
    start() {
      if (this.loopOn) return; this.loopOn = true;
      (async () => {
        try {
          if (!this.info) { this.ready = this.ready || this.init(); await this.ready; }
          while (!this.done) {
            if (!this.active() && Date.now() - this.lastActive > CFG.grace) break;
            const t0 = Date.now();
            await this.poll().catch(e => { this.setStatus(`Can't reach ESPN right now (${e.message}). Retrying.`, 'bad'); this.push(['status']); });
            const wait = this.status.state === 'in' ? CFG.pollLive : CFG.pollPre;
            while (Date.now() - t0 < wait && !this.done) { await sleep(500); if (!this.active() && Date.now() - this.lastActive > CFG.grace) break; if (this.kick) { this.kick = false; break; } }
          }
        } catch (e) {
          this.setStatus(`Couldn't load this game (${e.message}).`, 'bad'); this.ready = null; this.info = null; this.push(['status']);
        } finally { this.loopOn = false; this.job?.abort(); }
      })();
    }
    setStatus(msg, level) { this.status = { ...this.status, msg, level }; }
    async init() {
      this.setStatus('Loading rosters and the line…', 'warn');
      await espn.allTeams();
      const sm = await espn.get(`${espn.BASE}/summary?event=${this.id}`, 8000);
      const comp = sm.header?.competitions?.[0] || {}, cs = comp.competitors || [];
      const home = cs.find(c => c.homeAway === 'home'), away = cs.find(c => c.homeAway === 'away');
      if (!home || !away) throw new Error('game not found');
      const teamOf = c => { const t = c.team || {}, logos = t.logos || [];
        return { id: String(c.id ?? t.id), abbr: t.abbreviation, name: t.displayName || t.name, short: t.shortDisplayName || t.name, nick: t.name || t.abbreviation,
          location: t.location || '', color: t.color ? '#' + t.color : '#4A5568', alt: t.alternateColor ? '#' + t.alternateColor : '#ffffff', logo: t.logo || logos[0]?.href || null }; };
      const A = teamOf(home), B = teamOf(away);
      const date = comp.date || null, etDate = date ? new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '') : null;
      const post = (sm.header?.season?.type ?? 2) === 3;
      this.info = { teams: { A, B }, homeId: A.id, awayId: B.id, title: `${B.short} ${comp.neutralSite ? 'vs.' : 'at'} ${A.short}`, neutral: !!comp.neutralSite, post, kickoff: date, etDate };
      const [ua, ub] = await Promise.all([A.id, B.id].map(id => espn.teamUsage(id).catch(() => null)));
      this.usage = { A: fillUsage(ua?.usage), B: fillUsage(ub?.usage) };
      this.tk = `${this.id}:${Date.now()}`;
      this.S = { poss: 'B', pos: 30, down: 1, dist: 10, qtr: 1, secs: 900, a: 0, b: 0, half2Recv: 'A', toA: 3, toB: 3, edge: 0, total: 44, esd: ESD_BASE, post, neutral: this.info.neutral };
      // Starting point: the average of the sportsbook line, ESPN's FPI and the prediction markets, all as a home spread
      const od = espn.trimSummary(sm).odds;
      const R = readOdds(od.raw || od, A.abbr, B.abbr); if (R.total) this.S.total = R.total; if (R.edge != null) { this.S.edge = R.edge; this.edgeSet = true; }
      this.line = R.line || null;
      try {
        const pre = await espn.pregame(this.id); this.PRE = pre;
        if (pre.homeMargin != null) { this.S.edge = +pre.homeMargin.toFixed(1); this.S.esd = +Math.sqrt(ESD_BASE * ESD_BASE + pre.sd * pre.sd).toFixed(1); this.edgeSet = true; }
        if (pre.total != null) this.S.total = pre.total;
      } catch { this.PRE = null; }
      this.S.spread = this.S.edge;
      this.setStatus(`Loaded ${this.info.title}.`, 'ok');
      this.send('snapshot', this.snapshot());
    }
    // ---------- one ESPN check ----------
    async poll() {
      const sb = await espn.scoreboard(this.info.etDate, 4000);
      const ev = (sb.events || []).find(e => String(e.id) === this.id);
      if (!ev) throw new Error('game not in ESPN scoreboard');
      const o = parseEspn(ev, this.info);
      this.status.state = o.state; this.status.detail = o.detail;
      const changed = [];
      if (!this.edgeSet && (o.edge != null || o.total)) { if (o.edge != null) this.S.edge = this.S.spread = o.edge; if (o.total) this.S.total = o.total; this.edgeSet = true; }
      if (o.line && !this.line) { this.line = o.line; changed.push('line'); }
      // play-by-play: ESPN's own win probability, wall clock times for market history, and the state history for backfill
      if (o.state !== 'pre') await this.pullSummary(o).catch(() => {});
      const key = JSON.stringify([o.qtr, o.secs, o.a, o.b, o.poss, o.down, o.dist, o.pos]);
      if (o.state === 'pre') {
        this.setStatus(`Game hasn't started (${o.detail || 'scheduled'}).`, 'ok');
        if (key !== this.lastKey || !this.agg) { this.lastKey = key; this.runSims(true); }
        changed.push('status');
      } else if (o.state === 'post') {
        this.applyLive(o); this.setStatus(`Final: ${this.info.teams.B.abbr} ${o.b}, ${this.info.teams.A.abbr} ${o.a}.`, 'ok');
        if (key !== this.lastKey || !this.agg) { this.lastKey = key; this.runSims(); }
        changed.push('status', 'S'); this.done = true; if (trading) trading.settleWith(this.id, o.a, o.b); this.pullMarkets().catch(() => {});
        this.backfill();
      } else {
        if (!o.hasSit) this.setStatus(`Live score and clock (${o.detail}). ESPN isn't sending down and distance right now.`, 'warn');
        else this.setStatus(`Live: ${o.detail}${o.downText ? ', ' + o.downText : ''}.`, 'ok');
        const newPlay = o.lastPlay && o.lastPlay !== this.lastPlayText;
        if (key !== this.lastKey || newPlay) {
          const pre = { ...this.S }; this.lastKey = key; this.applyLive(o);
          if (newPlay) {
            // timeouts, the two-minute warning and quarter breaks change nothing on the field, so they aren't logged as plays
            if (this.lastPlayText !== null && !/^(timeout|two-minute|end of|end quarter|official timeout)/i.test(cleanText(o.lastPlay))) {
              const evl = this.pred && this.pred.key === coreKey(pre) ? evaluate(this.pred, observeLive(pre, this.S, o.lastPlay)) : null;
              this.plog.push({ when: `${qLabel(pre)} ${fmt(pre.secs)}`, text: cleanText(o.lastPlay), before: this.lastWP, after: null, ev: evl, poss: pre.poss });
              if (this.plog.length > 400) this.plog.splice(0, this.plog.length - 400);
              changed.push('plog');
            }
            this.lastPlayText = o.lastPlay;
          }
          changed.push('S'); this.runSims();
        }
        changed.push('status');
        if (Date.now() - this.mkAt > CFG.marketsEvery) this.pullMarkets().catch(() => {});
      }
      changed.push('viewers');
      this.push([...new Set(changed)]);
    }
    applyLive(o) {
      for (const k of ['qtr', 'secs', 'a', 'b', 'poss', 'down', 'dist', 'pos', 'toA', 'toB']) if (o[k] != null) this.S[k] = o[k];
      if (this.S.pos != null) this.S.dist = Math.max(1, Math.min(this.S.dist, 100 - this.S.pos));
      if (this.S.qtr >= 5 && this.summary) this.S.ot = otFromPlays(this.summary, this.slot.bind(this)); else delete this.S.ot;
    }
    slot(id) { id = String(id); return id === this.info.homeId ? 'A' : id === this.info.awayId ? 'B' : null; }
    async pullSummary(o) {
      const g = espn.trimSummary(await espn.get(`${espn.BASE}/summary?event=${this.id}`, 6000));
      this.summary = g;
      const tOf = {}; for (const p of g.plays || []) if (p.period) { const c = clockToSecs(p.clock); if (c != null) tOf[p.id] = elapsed({ qtr: Math.min(p.period, 5), secs: c, post: this.info.post }); }
      const es = (g.wp || []).filter(w => tOf[w.id] != null && w.home != null).map(w => ({ t: tOf[w.id], wp: w.home }));
      if (es.length !== this.espnWP.length) { this.espnWP = es; this.pushLater('espnWP'); }
      this.WALL = (g.plays || []).filter(p => p.wc && tOf[p.id] != null).map(p => [Date.parse(p.wc), tOf[p.id]]).filter(x => isFinite(x[0])).sort((a, b) => a[0] - b[0]);
      const first = (g.plays || []).find(p => this.slot(p.team) && p.down >= 1 && p.period === 1);
      if (first) this.S.half2Recv = flipT(this.slot(first.team));
      this.buildMarketHist();
    }
    pushLater(k) { (this._later ||= new Set()).add(k); clearTimeout(this._lt); this._lt = setTimeout(() => { const ks = [...this._later]; this._later.clear(); this.push(ks); }, 50); }
    async pullMarkets() {
      this.mkAt = Date.now();
      try {
        const j = await espn.markets(this.id); this.MK = j;
        const hp = x => x && x.found && x.home ? x.home.p : null, k = hp(j.kalshi), p = hp(j.poly), t = elapsed(this.S), last = this.mkHist[this.mkHist.length - 1];
        if ((k != null || p != null) && !(last && last.t === t && last.k === k && last.p === p)) this.mkHist.push({ t, k, p });
        if (this.mkHist.length > 800) this.mkHist.splice(0, this.mkHist.length - 800);
        this.buildMarketHist();
      } catch (e) { this.MK = { error: String(e.message || e) }; }
      this.pushLater('MK'); this.pushLater('mkh'); this.scoreTrades();
    }
    buildMarketHist() {
      const out = { k: [], p: [] };
      for (const [key, src] of [['k', this.MK?.kalshi], ['p', this.MK?.poly]]) {
        const h = src && src.hist && src.hist.away;
        if (h && h.length && this.WALL.length >= 2) {
          const pts = []; for (const [ms, v] of h) { const t = wallToT(this.WALL, ms, this.status.state === 'post'); if (t != null) pts.push({ t, v: 1 - v }); }
          for (const p of pts) { const L = out[key]; if (L.length && Math.abs(L[L.length - 1].t - p.t) < 1) L[L.length - 1] = p; else L.push(p); }
        } else out[key] = this.mkHist.filter(x => x[key] != null).map(x => ({ t: x.t, v: x[key] }));
      }
      this.mkh = out;
    }
    // Score every market against the latest full run; log new signals to the ledger
    scoreTrades() {
      if (!trading) return;
      this.trade = trading.opportunities(this);
      const added = trading.consider(this, this.trade);
      if (added.length) this.tradeNew = [...this.tradeNew, ...added].slice(-20);
      this.pushLater('trade'); if (added.length) this.pushLater('tradeNew');
    }
    teamsFor() { return { A: this.usage.A, B: this.usage.B }; }
    // ---------- the simulation itself: once per game state, for everyone ----------
    runSims(pregame) {
      this.job?.abort(); const ac = new AbortController(); this.job = ac;
      const S = { ...this.S }, key = coreKey(S);
      this.under = situation(S);
      (async () => {
        const t0 = Date.now();
        const base = E.prepS0(S, S.edge, S.total, data.cal);
        const nFull = pool.queueLength() > 30 ? Math.round(CFG.nFull / 2) : CFG.nFull;
        const opt = { priority: PRIORITY.live, signal: ac.signal, teams: this.teamsFor(), tk: this.tk };
        // Before kickoff nobody has the ball yet, so half the sims give each team the opening kickoff
        const runAt = (n) => pregame
          ? Promise.all([pool.run(base, Math.ceil(n / 2), opt), pool.run({ ...base, poss: 'A', half2Recv: 'B' }, Math.floor(n / 2), opt)]).then(([x, y]) => x && y ? E.mergeAgg(x, y) : null)
          : pool.run(base, n, opt);
        const a1 = await runAt(CFG.nQuick); if (!a1 || ac.signal.aborted) return;
        this.agg = slimAgg(a1); this.aggFinal = false; this.simInfo = { n: a1.n, ms: Date.now() - t0, at: Date.now(), threads: pool.size };
        this.push(['agg', 'aggFinal', 'simInfo', 'under', 'S']);
        const a2 = await runAt(nFull - CFG.nQuick); if (!a2 || ac.signal.aborted) return;
        const A = E.mergeAgg(a1, a2), wp = (A.win + 0.5 * A.tie) / A.n;
        this.agg = slimAgg(A); this.aggFinal = true; this.simInfo = { n: A.n, ms: Date.now() - t0, at: Date.now(), threads: pool.size };
        this.pred = makePred(A, S); this.lastWP = wp; this.simKey = key;
        const k = JSON.stringify([S.poss, S.pos, S.down, S.dist, S.qtr, S.secs, S.a, S.b, S.edge]);
        const t = elapsed(S), last = this.wpHist[this.wpHist.length - 1];
        if (!last || last.k !== k) this.wpHist.push({ k, wp, t, sc: [S.a, S.b] }); else { last.wp = wp; last.t = t; }
        this.wpHist.sort((x, y) => x.t - y.t);
        for (const en of this.plog) if (en.after == null) en.after = wp;
        this.fourth = S.down === 4 && this.status.state !== 'post' ? { pending: true, key, poss: S.poss, dist: S.dist, ytg: 100 - S.pos } : null;
        this.push(['agg', 'aggFinal', 'simInfo', 'wpHist', 'plog', 'fourth']); this.scoreTrades();
        if (S.down === 4 && this.status.state === 'in') await this.runFourth(S, base, ac.signal, key);
        if (!ac.signal.aborted) this.backfill();
      })().catch(e => { if (!ac.signal.aborted) { console.error('sim error', e); this.setStatus(`Simulation error (${e.message}).`, 'bad'); this.push(['status']); } });
    }
    async runFourth(S, base, signal, key) {
      const ytg = 100 - S.pos, fgd = ytg + 17, opts = [['go', 'Go for it']];
      if (ytg > 30) opts.push(['punt', 'Punt']); if (fgd <= 64) opts.push(['fg', `Field goal (${fgd} yds)`]);
      const res = [];
      for (const [k, lab] of opts) {
        const A = await pool.run(base, CFG.nOpt, { priority: PRIORITY.fourth, signal, force: k, teams: this.teamsFor(), tk: this.tk }); if (!A || signal.aborted) return;
        const w = (A.win + 0.5 * A.tie) / A.n; res.push({ k, lab, wp: S.poss === 'A' ? w : 1 - w, n: A.n });
      }
      const r = E.callRow(S).row;
      this.fourth = { key, poss: S.poss, dist: S.dist, ytg, res: res.sort((a, b) => b.wp - a.wp), coach: { n: r[0], go: r[1] + r[2], punt: r[3], fg: r[4] } };
      this.push(['fourth']);
    }
    // Fill in the model's line for plays from before anyone was watching (or between polls), at lower priority
    async backfill() {
      if (this.bfBusy || !this.summary) return; this.bfBusy = true;
      try {
        const states = histStates(this.summary, this.slot.bind(this), this.info.post); if (!states.length) return;
        const have = this.wpHist.map(h => h.t), upTo = this.status.state === 'post' ? 1e9 : elapsed(this.S);
        const todo = states.filter((st, i) => i % 2 === 0).map(st => ({ st, t: elapsed(st) })).filter(x => x.t > 0 && x.t < upTo - 5 && !have.some(t => Math.abs(t - x.t) < 25));
        let n = 0;
        for (const x of todo) {
          if (!this.active() || (this.job && !this.aggFinal)) break; // a viewer-facing run always comes first
          const st = { ...x.st, esd: this.S.esd };
          const A = await pool.run(E.prepS0(st, this.S.edge, this.S.total, data.cal), CFG.nFill, { priority: PRIORITY.backfill, teams: this.teamsFor(), tk: this.tk });
          if (!A) break;
          this.wpHist.push({ k: JSON.stringify([st.poss, st.pos, st.down, st.dist, st.qtr, st.secs, st.a, st.b, this.S.edge]), wp: (A.win + 0.5 * A.tie) / A.n, t: x.t, sc: [st.a, st.b], bf: true });
          if (++n % 6 === 0) { this.wpHist.sort((a, b) => a.t - b.t); this.push(['wpHist']); }
        }
        if (n) { this.wpHist.sort((a, b) => a.t - b.t); this.push(['wpHist']); }
      } finally { this.bfBusy = false; }
    }
  }

  function get(id) { id = String(id).replace(/\D/g, ''); if (!id) return null; let g = games.get(id); if (!g) { g = new LiveGame(id); games.set(id, g); } return g; }
  setInterval(() => { const now = Date.now(); for (const [id, g] of games) if (!g.active() && !g.loopOn && now - g.lastActive > CFG.evict) games.delete(id); }, 60000).unref();
  function modelFor(id) { const g = games.get(String(id)); if (!g || !g.aggFinal || !g.agg || g.lastWP == null) return null; if (Date.now() - g.simInfo.at > 20 * 60000 && g.status.state !== 'post') return null;
    return { wpHome: +g.lastWP.toFixed(4), at: g.simInfo.at, viewers: g.viewers() }; }
  function stats() { return { games: [...games.values()].map(g => ({ id: g.id, title: g.info?.title, state: g.status.state, viewers: g.viewers(), polling: g.loopOn, plays: g.plog.length, points: g.wpHist.length })), pool: pool.stats() }; }

  // ---------- one-off runs from the manual entry and what-if panels, shared through a short cache ----------
  async function ensureGame(id) { const g = get(id); if (!g) throw new Error('missing event'); if (!g.info) { g.ready = g.ready || g.init(); await g.ready; } return g; }
  async function custom({ event, state, n }) {
    const g = await ensureGame(event);
    const S = sanitizeState(state, g.S), N = Math.min(25000, Math.max(2000, +n || 12000));
    const key = JSON.stringify([event, coreKey(S), S.edge, S.total, S.esd, S.toA, S.toB, S.half2Recv, N]);
    return cached(customCache, key, 120000, async () => {
      const A = await pool.run(E.prepS0(S, S.edge, S.total, data.cal), N, { priority: PRIORITY.user, teams: g.teamsFor(), tk: g.tk });
      return { agg: slimAgg(A), under: situation(S), n: A.n };
    });
  }
  async function whatIf({ event, dE, dT }) {
    const g = await ensureGame(event); dE = +dE || 0; dT = +dT || 0;
    const S = { ...g.S }, key = JSON.stringify([event, coreKey(S), S.edge, S.total, dE, dT]);
    return cached(customCache, key, 120000, async () => {
      const opt = { priority: PRIORITY.user, teams: g.teamsFor(), tk: g.tk };
      const base = g.aggFinal && g.simKey === coreKey(S) ? g.agg : slimAgg(await pool.run(E.prepS0(S, S.edge, S.total, data.cal), CFG.nOpt, opt));
      const alt = await pool.run(E.prepS0(S, S.edge + dE, Math.max(10, S.total + dT), data.cal), 12000, opt);
      return { base: summ(base), alt: summ(alt), qbs: { A: g.usage.A.qbs.slice(0, 2), B: g.usage.B.qbs.slice(0, 2) } };
    });
  }
  // ---------- backtests: a finished game never changes, so each one is simulated once and kept ----------
  function backtest(event, every = 2, n = 1000) {
    every = Math.max(1, Math.min(10, +every || 2)); n = Math.max(250, Math.min(3000, +n || 1000));
    const key = `${event}:${every}:${n}`; let b = btCache.get(key);
    if (b) return b.public();
    const st = { status: 'queued', done: 0, total: 0, result: null, error: null, at: Date.now(), public() { return { status: this.status, done: this.done, total: this.total, result: this.result, error: this.error }; } };
    btCache.set(key, st);
    if (btCache.size > 500) btCache.delete(btCache.keys().next().value);
    backtestQ = backtestQ.then(async () => {
      try {
        st.status = 'running';
        const g = espn.trimSummary(await espn.get(`${espn.BASE}/summary?event=${event}`, 3600000));
        if (g.state !== 'post') throw new Error('game is not final');
        const P = btStates(g); if (P.err) throw new Error(P.err);
        const pick = P.states.filter((_, i) => i % every === 0); st.total = pick.length; const rec = [];
        for (const x of pick) {
          const A = await pool.run(E.prepS0({ ...x.st, esd: ESD_BASE, neutral: true }, P.edge, P.total, data.cal), n, { priority: PRIORITY.backtest });
          rec.push({ q: x.q, m: +((A.win + 0.5 * A.tie) / A.n).toFixed(4), e: x.e == null ? null : +(+x.e).toFixed(4) }); st.done++;
        }
        st.result = { name: P.name, y: P.y, edge: P.edge, lineSrc: P.lineSrc, s: rec }; st.status = 'done';
      } catch (e) { st.status = 'error'; st.error = String(e.message || e); setTimeout(() => btCache.delete(key), 60000); }
    });
    return st.public();
  }
  return { get, modelFor, stats, custom, whatIf, backtest, ensureGame };
}

// ===================== helpers =====================
async function cached(map, key, ttl, fn) {
  const hit = map.get(key); if (hit && hit.exp > Date.now()) return hit.p;
  const p = fn(); map.set(key, { exp: Date.now() + ttl, p }); p.catch(() => map.delete(key));
  if (map.size > 300) for (const [k, v] of map) if (v.exp < Date.now()) map.delete(k);
  return p;
}
function summ(A) { let t = 0; A.totH.forEach((c, i) => t += c * i); return { wp: (A.win + 0.5 * A.tie) / A.n, mar: A.marSum / A.n, tot: t / A.n, n: A.n }; }
function fillUsage(u) {
  u = u || {}; const ok = a => Array.isArray(a) && a.length;
  return { qbs: ok(u.qbs) ? u.qbs : [['Starting QB', 1]], rush: ok(u.rush) ? u.rush : [['Lead back', 1, 4, 0]], recv: ok(u.recv) ? u.recv : [['Top receiver', 2, 1, 10]],
    games: u.games || 0, plays: u.plays || 0, ypp: u.ypp || 0, passrate: u.passrate || 0.58, opps: u.opps || [], source: 'espn', targets: !!u.targets };
}
// Aggregates are already small; samples drop the bulky pre-state
function slimAgg(A) { return { ...A, samp: A.samp.map(f => ({ ...f, pre: undefined })) }; }
function situation(S) {
  const c = E.callRow(S), D = E.getData();
  const pk = `${S.down <= 2 ? 0 : 1}_${E.distB(S.dist)}_${E.ytgB(100 - S.pos)}`;
  return { row: c.row, level: c.level, cx: c.cx, db: E.distB(S.dist), yb: E.ytgB(100 - S.pos), pr: (D.pools[pk + '_run'] || [0])[0], pp: (D.pools[pk + '_pass'] || [0])[0] };
}
function sanitizeState(s, base) {
  const n = (v, lo, hi, d) => { v = Math.round(+v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const f = (v, lo, hi, d) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const t = x => x === 'A' || x === 'B' ? x : null;
  const S = { poss: t(s.poss) || 'A', pos: n(s.pos, 1, 99, 25), down: n(s.down, 1, 4, 1), dist: n(s.dist, 1, 99, 10), qtr: n(s.qtr, 1, 4, 1), secs: n(s.secs, 1, 900, 900),
    a: n(s.a, 0, 150, 0), b: n(s.b, 0, 150, 0), half2Recv: t(s.half2Recv) || 'A', toA: n(s.toA, 0, 3, 3), toB: n(s.toB, 0, 3, 3),
    edge: f(s.edge, -40, 40, base.edge), total: f(s.total, 20, 80, base.total), esd: f(s.esd, 0, 12, base.esd), post: !!base.post, neutral: !!base.neutral };
  S.dist = Math.min(S.dist, 100 - S.pos); S.spread = S.edge; return S;
}
function lineNum(x) { if (x == null) return null; if (typeof x === 'number') return isFinite(x) ? x : null; if (typeof x === 'string') { if (/^\s*(pk|even)/i.test(x)) return 0; const m = x.match(/[-+]?\d+(\.\d+)?/); return m ? +m[0] : null; }
  if (typeof x === 'object') return lineNum(x.close?.line ?? x.current?.line ?? x.open?.line ?? x.line ?? x.value ?? x.over); return null; }
// -> {total, edge (points the home team is favored by), line text}
function readOdds(o, hAbbr, aAbbr) {
  if (!o) return {}; const r = { line: o.details || null };
  r.total = lineNum(o.overUnder) ?? lineNum(o.total); if (!(r.total > 20)) r.total = null;
  const m = String(o.details || '').match(/^(\S+)\s+([-+]?\d+(?:\.\d+)?)/);
  if (m) { const v = -parseFloat(m[2]), a = m[1].toUpperCase(); if (a === String(hAbbr).toUpperCase()) r.edge = v; else if (a === String(aAbbr).toUpperCase()) r.edge = -v; }
  else if (/^\s*(pk|even)/i.test(o.details || '')) r.edge = 0;
  if (r.edge == null) { const hs = lineNum(o.spread) ?? lineNum(o.pointSpread?.home); if (hs != null) r.edge = -hs; }
  return r;
}
// ESPN scoreboard entry -> partial game state in engine terms (home = A)
export function parseEspn(ev, info) {
  const comp = (ev.competitions || [])[0] || {}, out = {};
  const st = comp.status || ev.status || {}; out.state = st.type && st.type.state; out.detail = st.type && (st.type.shortDetail || st.type.detail);
  const per = st.period; if (per) out.qtr = Math.min(5, per);
  const cs = clockToSecs(st.displayClock); if (cs != null && per) out.secs = cs;
  const slot = id => String(id) === info.homeId ? 'A' : String(id) === info.awayId ? 'B' : null;
  for (const c of comp.competitors || []) { const t = slot(c.id ?? c.team?.id); if (t) out[t === 'A' ? 'a' : 'b'] = parseInt(c.score) || 0; }
  const R = readOdds((comp.odds || [])[0], info.teams.A.abbr, info.teams.B.abbr); if (R.total) out.total = R.total; if (R.edge != null) out.edge = R.edge; if (R.line) out.line = R.line;
  const sit = comp.situation; out.hasSit = !!sit;
  if (sit) {
    const pt = slot(sit.possession); if (pt) out.poss = pt;
    if (sit.down >= 1 && sit.down <= 4) { out.down = sit.down; if (sit.distance > 0) out.dist = sit.distance; }
    const p = String(sit.possessionText || '').match(/^(\w+)\s+(\d+)/);
    if (p && out.poss) { const sv = p[1].toUpperCase(), side = sv === String(info.teams.A.abbr).toUpperCase() ? 'A' : sv === String(info.teams.B.abbr).toUpperCase() ? 'B' : null; const yl = +p[2]; if (side) out.pos = side === out.poss ? yl : 100 - yl; }
    else if (/\b50\b/.test(String(sit.possessionText || '')) && out.poss) out.pos = 50;
    if (sit.lastPlay && sit.lastPlay.text) out.lastPlay = sit.lastPlay.text;
    out.downText = sit.shortDownDistanceText || sit.downDistanceText || '';
    if (sit.homeTimeouts != null && sit.homeTimeouts >= 0 && sit.homeTimeouts <= 3) out.toA = +sit.homeTimeouts;
    if (sit.awayTimeouts != null && sit.awayTimeouts >= 0 && sit.awayTimeouts <= 3) out.toB = +sit.awayTimeouts;
  }
  return out;
}
const cleanText = t => String(t || '').replace(/^\(\s*\d*:\d+[^)]*\)\s*/, '').replace(/^\((Shotgun|No Huddle[^)]*)\)\s*/gi, '').replace(/^\((Shotgun|No Huddle[^)]*)\)\s*/gi, '').replace(/\s+/g, ' ').trim();
// Which team has had an overtime possession, from the play-by-play
function otFromPlays(g, slot) {
  const runs = []; for (const p of g.plays || []) { if (!(p.period >= 5)) continue; const t = slot(p.team); if (!t || !(p.down >= 1)) continue; if (!runs.length || runs[runs.length - 1] !== t) runs.push(t); }
  const had = { A: 0, B: 0 }; runs.slice(0, -1).forEach(t => had[t] = 1);
  return { first: runs[0] || 'A', had, sudden: !!(had.A && had.B) };
}
function wallToT(W, ms, final) {
  if (W.length < 2 || ms < W[0][0] - 20 * 60000) return null;
  if (ms <= W[0][0]) return 0;
  if (ms >= W[W.length - 1][0]) return final ? null : W[W.length - 1][1];
  let lo = 0, hi = W.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (W[m][0] <= ms) lo = m; else hi = m; }
  const [a, ta] = W[lo], [b, tb] = W[hi]; return b > a ? ta + (tb - ta) * (ms - a) / (b - a) : ta;
}
const SKIP = /kickoff|timeout|end of|extra point|two-point|conversion|coin toss|two-minute/i;
function histStates(g, slot, post) {
  const first = (g.plays || []).find(p => slot(p.team) && p.down >= 1 && p.period === 1), half2Recv = first ? flipT(slot(first.team)) : 'A';
  let hs = 0, as = 0; const out = [];
  for (const p of g.plays || []) {
    const poss = slot(p.team), cs = clockToSecs(p.clock);
    if (!SKIP.test(p.type + ' ' + p.text) && poss && p.period >= 1 && p.period <= 4 && p.down >= 1 && p.down <= 4 && p.ytez >= 1 && p.ytez <= 99 && cs != null && p.dist >= 1)
      out.push({ poss, pos: 100 - p.ytez, down: p.down, dist: Math.min(p.dist, p.ytez), qtr: p.period, secs: Math.max(1, cs), a: hs, b: as, half2Recv, toA: 3, toB: 3, post });
    if (p.hs != null) hs = +p.hs; if (p.as != null) as = +p.as;
  }
  return out;
}
// Finished game -> sampled pre-snap states with the home team in slot A
function btStates(g) {
  const home = (g.comps || []).find(c => c.homeAway === 'home'), away = (g.comps || []).find(c => c.homeAway === 'away');
  if (!home || !away) return { err: 'missing teams' };
  let edge = null; const det = g.odds && g.odds.details, m = det && String(det).match(/^(\S+)\s+(-?[\d.]+)/);
  if (m) { const v = -parseFloat(m[2]); if (m[1] === home.abbr) edge = v; else if (m[1] === away.abbr) edge = -v; }
  else if (det && /even|pk|pick/i.test(det)) edge = 0;
  if (edge == null && g.odds && g.odds.spread != null) edge = -(+g.odds.spread);
  let lineSrc = 'book';
  if (edge == null) { const w0 = (g.wp || []).find(w => w.home != null); if (w0) { const pw = Math.min(.995, Math.max(.005, +w0.home)); edge = +(espn.SIG * invPhi(pw)).toFixed(1); lineSrc = 'espn'; } }
  if (edge == null) return { err: 'no line or pregame odds' };
  const total = +(g.odds && g.odds.overUnder) || 44;
  const slot = id => String(id) === home.id ? 'A' : String(id) === away.id ? 'B' : null;
  const wp = {}; for (const w of g.wp || []) wp[w.id] = w.home;
  const first = (g.plays || []).find(p => slot(p.team) && p.down >= 1); const half2Recv = first && slot(first.team) === 'A' ? 'B' : 'A';
  let hs = 0, as = 0, espnPrev = null; const out = [];
  for (const p of g.plays || []) {
    const poss = slot(p.team), cs = clockToSecs(p.clock);
    if (!SKIP.test(p.type + ' ' + p.text) && poss && p.period >= 1 && p.period <= 4 && p.down >= 1 && p.down <= 4 && p.ytez >= 1 && p.ytez <= 99 && cs != null && p.dist >= 1)
      out.push({ st: { poss, pos: 100 - p.ytez, down: p.down, dist: Math.min(p.dist, p.ytez), qtr: p.period, secs: Math.max(1, cs), a: hs, b: as, half2Recv, toA: 3, toB: 3, post: g.seasonType === 3 }, q: p.period, e: espnPrev });
    if (p.hs != null) hs = +p.hs; if (p.as != null) as = +p.as; if (wp[p.id] != null) espnPrev = wp[p.id];
  }
  if (out.length < 20) return { err: 'too few plays' };
  const y = home.score > away.score ? 1 : home.score < away.score ? 0 : 0.5;
  return { edge, total, lineSrc, y, name: `${away.abbr} at ${home.abbr}`, states: out };
}
function invPhi(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
    b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
    c = [-.007784894002430293, -.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
    d = [.007784695709041462, .3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = .02425; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - .5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
// ---------- model check: each play scored against the prediction made right before it ----------
function makePred(A, S) {
  let n = 0, s = 0, s2 = 0; A.yH.forEach((c, i) => { n += c; s += c * (i - 20); s2 += c * (i - 20) * (i - 20); });
  const mu = n ? s / n : 0, sd = n ? Math.sqrt(Math.max(1e-6, s2 / n - mu * mu)) : 0, out = {};
  for (const k in A.out) out[k] = A.out[k] / A.n;
  return { key: coreKey(S), poss: S.poss, N: A.n, out, pFD: A.fd / A.n, yH: A.yH.slice(), yN: n, mu, sd };
}
function evaluate(pred, obs) {
  if (!pred || !obs) return null;
  const pCat = Math.max(pred.out[obs.cat] || 0, 0.5 / pred.N); const ev = { team: pred.poss, cat: obs.cat, pCat, pFD: pred.pFD, fdHit: obs.fd ? 1 : 0, scrim: obs.y != null };
  if (obs.y != null && pred.yN > 0 && pred.sd > 0) {
    const i = Math.max(0, Math.min(119, obs.y + 20)); let below = 0; for (let j = 0; j < i; j++) below += pred.yH[j];
    const eq = pred.yH[i]; ev.y = obs.y; ev.mu = pred.mu; ev.sd = pred.sd; ev.pit = (below + 0.5 * eq) / pred.yN; ev.up = (pred.yN - below) / pred.yN; ev.down = (below + eq) / pred.yN; ev.z = (obs.y - pred.mu) / pred.sd;
  }
  ev.rare = ev.y != null ? Math.min(1, 2 * Math.min(ev.up, ev.down)) : pCat;
  return ev;
}
function observeLive(pre, post, text) {
  const t = String(text || '').toLowerCase();
  if (/kickoff|kicks|timeout|end of (quarter|half|game)|extra point|two-point|2-pt|\bpat\b|two-minute/.test(t)) return null;
  if (/penalty/.test(t) && !/declined/.test(t)) return null;
  const offPts = pre.poss === 'A' ? post.a - pre.a : post.b - pre.b, defPts = pre.poss === 'A' ? post.b - pre.b : post.a - pre.a;
  if (/punts?\b/.test(t)) return { cat: 'Punt', y: null, fd: false };
  if (/field goal/.test(t)) return { cat: (offPts >= 3 || /good/.test(t)) ? 'FG good' : 'FG missed', y: null, fd: false };
  if (offPts >= 6) return { cat: 'Touchdown', y: 100 - pre.pos, fd: true };
  if (defPts >= 6 || (/intercept|fumble/.test(t) && post.poss !== pre.poss)) return { cat: 'Turnover', y: null, fd: false };
  if (defPts === 2) return { cat: 'Safety', y: null, fd: false };
  if (post.poss === pre.poss) { const y = post.pos - pre.pos, fd = post.down === 1 && y >= pre.dist; return { cat: fd ? 'First down' : y < 0 ? 'Loss / sack' : y === 0 ? 'No gain / incomplete' : 'Short of the sticks', y, fd }; }
  if (pre.down === 4) { const y = (100 - post.pos) - pre.pos; return { cat: y < 0 ? 'Loss / sack' : y === 0 ? 'No gain / incomplete' : 'Short of the sticks', y, fd: false }; }
  return null;
}
