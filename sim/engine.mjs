// ===== NFL resampling engine: every simulated play is drawn from a real NFL play in a matching situation =====
// Slots: 'A' is the home team, 'B' the away team. Positions are yards from the offense's own goal line.
// Runs inside worker threads (sim/worker.mjs) and, for tests, on the main thread.
let D = null, CALL = null, POOL = null, CLK = null, YBT = null, PUNT = null;
const CODES = 'gisxXfF';
export function setData(d) {
  D = d;
  YBT = new Uint8Array(101); for (let y = 0; y <= 100; y++) { let b = d.YB.length - 2; for (let i = 1; i < d.YB.length; i++) if (y <= d.YB[i]) { b = i - 1; break; } YBT[y] = b; }
  // call table: index ((down-1)*6+db)*8+yb, *4+cx -> [n,run,pass,punt,fg]
  CALL = new Array(4 * 6 * 8 * 4);
  for (let dn = 1; dn <= 4; dn++) for (let db = 0; db < 6; db++) for (let yb = 0; yb < 8; yb++) for (let cx = 0; cx < 4; cx++) {
    let r = d.calls.k4[`${dn}_${db}_${yb}_${cx}`], lvl = 4;
    if (!r) { r = d.calls.k3[`${dn}_${db}_${yb}`]; lvl = 3; }
    if (!r) { r = d.calls.k2[`${dn}_${db}`] || [1, 1, 1, 0, 0]; lvl = 2; }
    CALL[(((dn - 1) * 6 + db) * 8 + yb) * 4 + cx] = { r, lvl, cx: lvl === 4 ? cx : 0 };
  }
  POOL = new Array(2 * 6 * 8 * 2);
  for (let dg = 0; dg < 2; dg++) for (let db = 0; db < 6; db++) for (let yb = 0; yb < 8; yb++) for (let ci = 0; ci < 2; ci++) {
    const cls = ci ? 'pass' : 'run'; const p = d.pools[`${dg}_${db}_${yb}_${cls}`] || d.pools[`y${yb}_${cls}`];
    const a = p.slice(1); const c = new Uint8Array(a.length), y = new Int16Array(a.length);
    a.forEach((o, i) => { c[i] = CODES.indexOf(o[0]); y[i] = o[1]; }); POOL[((dg * 6 + db) * 8 + yb) * 2 + ci] = { c, y, n: p[0] };
  }
  passOdds();
  CLK = {}; for (const ci of [0, 1]) for (let k = 0; k < 7; k++) for (const h of [0, 1]) { const cls = ci ? 'pass' : 'run'; CLK[(ci * 7 + k) * 2 + h] = d.clk[`${cls}_${CODES[k]}_${h}`] ?? d.clk[`${cls}_${CODES[k]}_0`] ?? 25; }
  // punts: receiving team's start, bucketed by the punting team's distance to the end zone
  PUNT = new Array(101); const keys = Object.keys(d.punt).map(Number).sort((a, b) => a - b);
  for (let y = 0; y <= 100; y++) { const k = keys.find(k => y <= k) ?? keys[keys.length - 1]; PUNT[y] = d.punt[String(k)]; }
}
export const getData = () => D;
// Team pass tendency vs. the league, as an odds multiplier shrunk toward 1 by sample size
function passOdds() {
  let lr = 0, lp = 0; for (const k in D.calls.k2) { lr += D.calls.k2[k][1]; lp += D.calls.k2[k][2]; } const L = lp / (lr + lp);
  for (const t in D.teams) { const u = D.teams[t]; const w = (u.plays || 0) / ((u.plays || 0) + 400); const pr = Math.min(.8, Math.max(.2, u.passrate || L));
    u.passOdds = Math.pow((pr / (1 - pr)) / (L / (1 - L)), w); }
}
// Swap in one game's rosters without rebuilding the play tables
export function setTeams(t) { D.teams = t; passOdds(); }
export const leaguePassRate = () => { let lr = 0, lp = 0; for (const k in D.calls.k2) { lr += D.calls.k2[k][1]; lp += D.calls.k2[k][2]; } return lp / (lr + lp); };
let rnd = Math.random;
export function seedRng(seed) {
  if (seed == null || seed === '' || !isFinite(seed)) { rnd = Math.random; return; } let a = (+seed) >>> 0;
  rnd = function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss() { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
export const distB = x => x <= 1 ? 0 : x <= 2 ? 1 : x <= 4 ? 2 : x <= 7 ? 3 : x <= 10 ? 4 : 5;
export const ytgB = y => YBT[Math.max(0, Math.min(100, y))];
export const ctxName = ['normal game state', 'trailing late', 'leading late', 'end of half'];
const flip = t => t === 'A' ? 'B' : 'A';
function margin(s) { return s.poss === 'A' ? s.a - s.b : s.b - s.a; }
function totalLeft(s) { return s.qtr >= 5 ? s.secs : (4 - s.qtr) * 900 + s.secs; }
function ctx(s) { const m = margin(s); if (s.qtr >= 4 && s.secs <= 480) { if (m < 0 && m >= -16) return 1; if (m > 0 && m <= 16) return 2; } if (s.qtr === 2 && s.secs <= 120) return 3; return 0; }
export function callRow(s) { const e = CALL[(((s.down - 1) * 6 + distB(s.dist)) * 8 + ytgB(100 - s.pos)) * 4 + ctx(s)]; return { row: e.r, level: e.lvl, cx: e.cx }; }
function wpick(items, wf) { let t = 0; for (const it of items) t += wf(it); let r = rnd() * t; for (const it of items) { r -= wf(it); if (r <= 0) return it; } return items[items.length - 1]; }
const FG_MAX = 64;
function choosePlay(s, force) {
  const m = margin(s), tl = totalLeft(s), r = CALL[(((s.down - 1) * 6 + distB(s.dist)) * 8 + ytgB(100 - s.pos)) * 4 + ctx(s)].r;
  const po = (!s.neutral && D.teams[s.poss] && D.teams[s.poss].passOdds) || 1;
  if (force) { if (force === 'go') return rnd() * (r[1] + r[2] * po) < r[1] ? 'run' : 'pass'; return force; }
  if (s.qtr >= 4 && m > 0 && s.down < 4) { // kneel out the clock if the defense can't stop it
    const dto = tos(s, flip(s.poss)); if (tl <= (4 - s.down) * 40 - dto * 38 + 5) return 'kneel'; }
  let wr = r[1], wp = r[2] * po, wu = r[3], wf = r[4]; const fgd = 117 - s.pos;
  if (fgd > FG_MAX) wf = 0;
  if (s.qtr === 4 && m < 0 && tl < 150) { wu = 0; if (m < -3 || fgd > 57) wf = 0; }
  if (s.qtr >= 4 && m <= 0 && m >= -3 && tl < 40 && fgd <= 57) return 'fg';
  if (s.qtr >= 5) { // overtime: a team that's behind can't punt, and a field goal only helps if it ties or wins
    if (m < 0) { wu = 0; if (m < -3) wf = 0; }
    if (m >= 0 && s.ot && (s.ot.sudden || s.ot.had[flip(s.poss)]) && s.down === 4 && fgd <= 55) return 'fg';
  }
  let x = rnd() * (wr + wp + wu + wf); if ((x -= wr) < 0) return 'run'; if ((x -= wp) < 0) return 'pass'; if ((x -= wu) < 0) return 'punt'; return 'fg';
}
function drawPool(s, ci) { const P = POOL[(((s.down <= 2 ? 0 : 1) * 6 + distB(s.dist)) * 8 + ytgB(100 - s.pos)) * 2 + ci]; const i = (rnd() * P.c.length) | 0; return [P.c[i], P.y[i]]; }
function val(c, y) { return c === 0 || c === 2 ? y : c === 1 ? 0 : -25; }
export const EK = 0.0125;
function outcome(s, ci) {
  const a = (s.poss === 'A' ? 1 : -1) * s.edge * EK; let o = drawPool(s, ci);
  if (rnd() < Math.min(0.7, a < 0 ? -a : a)) { const o2 = drawPool(s, ci); if (a > 0 ? val(o2[0], o2[1]) > val(o[0], o[1]) : val(o2[0], o2[1]) < val(o[0], o[1])) o = o2; }
  const t = s.tilt || 0; // scoring-level tilt: >0 favors defenses (lower scoring), <0 favors offenses
  if (t && rnd() < (t < 0 ? -t : t)) { const o3 = drawPool(s, ci); if (t > 0 ? val(o3[0], o3[1]) < val(o[0], o[1]) : val(o3[0], o3[1]) > val(o[0], o[1])) o = o3; }
  return o;
}
function chooseRusher(s) { const u = D.teams[s.poss]; const rz = 100 - s.pos <= 10; return wpick(u.rush, r => r[1] + (rz ? 3 * r[3] : 0))[0]; }
function chooseTarget(s, caught) { const u = D.teams[s.poss]; return wpick(u.recv, r => caught ? r[2] + 0.2 : (r[1] - r[2]) + 0.3)[0]; }
const qb = s => D.teams[s.poss].qbs[0][0];
const pickA = a => a[(rnd() * a.length) | 0];
function addPts(s, t, p) { if (t === 'A') s.a += p; else s.b += p; }
function newPoss(s, t, pos) { s.poss = t; s.pos = pos < 1 ? 1 : pos > 99 ? 99 : Math.round(pos); s.down = 1; s.dist = Math.min(10, 100 - s.pos); }
function tos(s, t) { return t === 'A' ? (s.toA ?? 3) : (s.toB ?? 3); }
function useTO(s, t) { if (t === 'A') s.toA = tos(s, t) - 1; else s.toB = tos(s, t) - 1; }
// Kickoff, including the onside kick a trailing team tries late, and the occasional return touchdown
function kickoff(s, kicker) {
  const recv = flip(kicker), m = kicker === 'A' ? s.a - s.b : s.b - s.a;
  if (s.qtr >= 4 && s.qtr < 5 && m < 0 && m >= -16 && totalLeft(s) <= 180) {
    if (rnd() < D.onside.p) { newPoss(s, kicker, 52); return; } newPoss(s, recv, 52); return; }
  const k = pickA(D.kick);
  if (k <= 0) { addPts(s, recv, rnd() < D.pat.xp ? 7 : 6); s.lastScore = recv + ' TD'; kickoff(s, recv); return; }
  newPoss(s, recv, 100 - k);
}
// Defense trailing late in the 4th burns a timeout to stop the clock after a running-clock play
function defStop(s) { const d = flip(s.poss); return (s.qtr === 4 || s.qtr === 5) && totalLeft(s) <= 240 && margin(s) > 0 && margin(s) <= 16 && tos(s, d) > 0 ? d : null; }
function hurry(s) { const m = margin(s), tl = totalLeft(s); return (s.qtr >= 4 && ((m < 0 && tl < 360) || (m === 0 && tl <= 150))) || (s.qtr === 2 && s.secs <= 120); }
// The offense stops its own clock with a timeout when it needs points and time is short
function offStop(s) { const m = margin(s), tl = totalLeft(s);
  return ((s.qtr >= 4 && m <= 0 && m >= -16 && tl <= 120) || (s.qtr === 2 && s.secs <= 45 && s.pos >= 45)) && tos(s, s.poss) > 0 ? s.poss : null; }
export function fgProb(d) { const a = D.fg[0], b = D.fg[1]; return 1 / (1 + Math.exp(-(a + b * d))); }
const CNAME = ['g', 'i', 's', 'x', 'X', 'f', 'F'];
// After a touchdown: kick the extra point, or go for two in the spots the standard chart says to, late in the game
function tryAfter(s, off) {
  const m = margin(s);
  if ((s.qtr >= 4 && totalLeft(s) < 600 && (m === -2 || m === -5 || m === -10 || m === 1 || m === 5)) || (s.qtr >= 5 && m === -1 && s.ot && s.ot.sudden === false && s.ot.first !== off)) { if (rnd() < D.pat.two) addPts(s, off, 2); }
  else if (rnd() < D.pat.xp) addPts(s, off, 1);
}
// one play. det only filled when wantDetail. returns event string or null; sets s.lastScore when points scored
function playOnce(s, wantDetail, force) {
  const call = choosePlay(s, force), off = s.poss, ytg = 100 - s.pos; let ev = null, secs = 0, det = null;
  if (wantDetail) det = { call, off, force: force || null, pre: { down: s.down, dist: s.dist, pos: s.pos } };
  if (call === 'kneel') { if (det) { det.res = 'kneel'; det.y = -1; } s.pos = Math.max(1, s.pos - 1); s.down++; s.dist++; secs = 40; { const d = defStop(s); if (d && s.secs > 3) { useTO(s, d); secs = 3; } } if (s.down > 4) { ev = 'Downs'; newPoss(s, flip(off), 100 - s.pos); } }
  else if (call === 'punt') {
    const r = pickA(PUNT[ytg]); secs = 9;
    if (det) { det.res = 'punt'; det.y = r >= 100 ? 0 : 100 - r - s.pos; }
    ev = 'Punt';
    if (r >= 100) { addPts(s, flip(off), 7); s.lastScore = flip(off) + ' TD'; if (det) det.res = 'punt_td'; kickoff(s, flip(off)); }
    else newPoss(s, flip(off), r);
  }
  else if (call === 'fg') { const d = ytg + 17; secs = 5; if (det) det.y = d; if (rnd() < fgProb(d)) { if (det) det.res = 'fg_good'; ev = 'FG'; addPts(s, off, 3); s.lastScore = off + ' FG'; kickoff(s, off); } else { if (det) det.res = 'fg_miss'; ev = 'Missed FG'; newPoss(s, flip(off), Math.max(20, 100 - (s.pos - 7))); } }
  else {
    const ci = call === 'pass' ? 1 : 0; const o = outcome(s, ci); const c = o[0]; let y = o[1]; secs = CLK[(ci * 7 + c) * 2 + (hurry(s) ? 1 : 0)];
    if ((c === 0 || c === 2) && secs > 12) { const d = defStop(s) || offStop(s); if (d) { useTO(s, d); secs = c === 0 && ci === 0 ? 6 : 7; } }
    if (det) { det.code = CNAME[c]; det.y = y; if (ci === 0 && c !== 1) det.who = chooseRusher(s); else if (ci === 1) { det.qb = qb(s); if (c === 0 || c === 5) det.who = chooseTarget(s, true); else if (c === 1 || c === 3 || c === 4) det.who = chooseTarget(s, false); } }
    if (c === 4 || c === 6) { if (det) det.res = 'to_td'; addPts(s, flip(off), rnd() < D.pat.xp ? 7 : 6); s.lastScore = flip(off) + ' TD'; ev = 'Turnover'; kickoff(s, flip(off)); }
    else if (c === 3 || c === 5) { // interception or lost fumble: y is where the other team takes over, measured from the line of scrimmage
      if (det) det.res = c === 3 ? 'int' : 'fum'; ev = 'Turnover'; const spot = s.pos + y; newPoss(s, flip(off), spot >= 100 ? 20 : 100 - Math.max(1, spot)); }
    else if (c === 1) { if (det) det.res = 'inc'; s.down++; if (s.down > 4) { ev = 'Downs'; newPoss(s, flip(off), 100 - s.pos); } }
    else {
      if (y >= ytg) { if (det) { det.res = 'td'; det.y = ytg; } addPts(s, off, 6); tryAfter(s, off); s.lastScore = off + ' TD'; ev = 'TD'; kickoff(s, off); }
      else if (s.pos + y <= 0) { if (det) det.res = 'safety'; addPts(s, flip(off), 2); s.lastScore = flip(off) + ' Safety'; ev = 'Safety'; newPoss(s, flip(off), D.safetyPos || 40); }
      else { if (det) det.res = c === 2 ? 'sack' : 'gain'; s.pos += y; if (y >= s.dist) { s.down = 1; s.dist = Math.min(10, 100 - s.pos); if (det) det.fd = true; } else { s.dist -= y; s.down++; if (s.down > 4) { ev = 'Downs'; newPoss(s, flip(off), 100 - s.pos); } } }
    }
  }
  // Two-minute warning stops the clock in the 2nd and 4th quarters and overtime
  const before = s.secs;
  s.secs -= secs;
  if ((s.qtr === 2 || s.qtr === 4 || s.qtr === 5) && before > 120 && s.secs < 120) s.secs = 120;
  if (s.secs <= 0 && s.qtr <= 4) {
    if (s.qtr === 2 && !ev) ev = 'End of half'; if (s.qtr === 4 && !ev) ev = 'End of game';
    s.qtr++; s.secs += 900; if (s.qtr === 3) { s.toA = 3; s.toB = 3; kickoff(s, flip(s.half2Recv)); }
  }
  return { det, ev, off };
}
// ===== NFL overtime (2025 rules): 10 minutes in the regular season, 15-minute periods in the playoffs.
// Both teams get a possession even if the first scores a touchdown, unless the defense scores on that first possession.
// After both have had the ball, the next score wins. A regular-season game still tied at the end is a tie.
function startOT(s) {
  s.qtr = 5; s.secs = s.post ? 900 : 600; s.toA = 2; s.toB = 2;
  const recv = rnd() < 0.5 ? 'A' : 'B';
  s.ot = { first: recv, had: { A: 0, B: 0 }, sudden: false };
  const k = pickA(D.kick); newPoss(s, recv, 100 - Math.max(1, k));
}
// returns true when the game is over
function otAfterPlay(s, off, a0, b0) {
  const o = s.ot, offPts = off === 'A' ? s.a - a0 : s.b - b0, defPts = off === 'A' ? s.b - b0 : s.a - a0;
  if (!o.had.A && !o.had.B && defPts > 0) return true; // defense scored on the opening possession
  if (s.poss !== off || offPts > 0) o.had[off] = 1;      // that possession is over
  if (o.had.A && o.had.B) { if (o.sudden && s.a !== s.b) return true; if (!o.sudden) { if (s.a !== s.b) return true; o.sudden = true; } }
  else if (o.sudden && s.a !== s.b) return true;
  if (s.secs <= 0) { if (s.post) { s.secs += 900; return false; } return true; }
  return false;
}
export function simulate(s0, force) {
  // Team strength is uncertain: each simulated game draws its own edge around the line
  const edge = s0.esd ? s0.edge + s0.esd * gauss() : s0.edge;
  const s = { poss: s0.poss, pos: s0.pos, down: s0.down, dist: s0.dist, qtr: s0.qtr, secs: s0.secs, a: s0.a, b: s0.b, half2Recv: s0.half2Recv, edge, tilt: s0.tilt || 0, lastScore: null,
    toA: s0.toA ?? 3, toB: s0.toB ?? 3, neutral: !!s0.neutral, post: !!s0.post, ot: null };
  if (s.qtr >= 5) s.ot = s0.ot ? { first: s0.ot.first, had: { ...s0.ot.had }, sudden: !!s0.ot.sudden } : { first: s.poss, had: { A: 0, B: 0 }, sudden: false };
  const team = s.poss, a0 = s.a, b0 = s.b; let first = null, drive = null, n = 0, next = null, done = false, ot = s.qtr >= 5;
  while (!done && n < 500) {
    if (s.qtr === 5 && !s.ot) { if (s.a !== s.b) break; startOT(s); ot = true; }
    const pa = s.a, pb = s.b;
    const r = playOnce(s, !first, first ? null : force); n++; if (!first) first = r.det;
    if (!next && s.lastScore) next = s.qtr >= 5 ? s.lastScore.split(' ')[0] + ' OT' : s.lastScore;
    if (!drive && r.ev) { const net = team === 'A' ? (s.a - a0) - (s.b - b0) : (s.b - b0) - (s.a - a0); drive = { result: r.ev, pts: net, plays: n }; }
    if (s.ot) done = otAfterPlay(s, r.off, pa, pb);
    else if (s.qtr > 4 && s.a !== s.b) done = true;
  }
  if (!drive) drive = { result: 'End of game', pts: 0, plays: n };
  const winner = s.a > s.b ? 'A' : s.b > s.a ? 'B' : null;
  return { first, drive, a: s.a, b: s.b, winner, ot, next: next || 'No more scoring' };
}

// ===== Aggregation =====
// Histogram offsets: margins run -80..80 (index m+80) so the two teams mirror cleanly
export const MOFF = 80;
const CK = { pass: 'Pass', run: 'Run', punt: 'Punt', fg: 'Field goal', kneel: 'Kneel' };
export function newAgg() { return { n: 0, ot: 0, tie: 0, call: {}, go4: 0, out: {}, fd: 0, car: {}, tgt: {}, cat: {}, endHist: new Array(101).fill(0), drv: {}, ep: 0, dpl: 0, win: 0, aH: new Array(151).fill(0), bH: new Array(151).fill(0), mar: {}, next: {}, cover: 0, over: 0, samp: [], marSum: 0, yH: new Array(120).fill(0), marH: new Array(2 * MOFF + 1).fill(0), totH: new Array(151).fill(0) }; }
function inc(o, k, v) { o[k] = (o[k] || 0) + (v == null ? 1 : v); }
export function runBatch(S, N, force, wantSamp) {
  const A = newAgg();
  for (let i = 0; i < N; i++) {
    const r = simulate(S, force), f = r.first; A.n++;
    inc(A.call, CK[f.call]); if (S.down === 4 && (f.call === 'run' || f.call === 'pass')) A.go4++;
    const to = f.res === 'int' || f.res === 'fum' || f.res === 'to_td'; let ok;
    if (f.res === 'td') ok = 'Touchdown'; else if (to) ok = 'Turnover'; else if (f.res === 'fg_good') ok = 'FG good'; else if (f.res === 'fg_miss') ok = 'FG missed';
    else if (f.res === 'punt' || f.res === 'punt_td') ok = 'Punt'; else if (f.res === 'safety') ok = 'Safety'; else if (f.fd) ok = 'First down';
    else if (f.res === 'inc' || f.y === 0) ok = 'No gain / incomplete'; else if (f.y < 0) ok = 'Loss / sack'; else ok = 'Short of the sticks';
    inc(A.out, ok); if (f.fd || f.res === 'td') A.fd++;
    if (f.who) { if (f.call === 'run') inc(A.car, f.who); else { inc(A.tgt, f.who); if (f.res === 'gain' || f.res === 'td') inc(A.cat, f.who); } }
    if ((f.call === 'run' || f.call === 'pass') && !to) { const yy = f.res === 'inc' ? 0 : f.y; A.yH[yy < -20 ? 0 : yy > 99 ? 119 : yy + 20]++; }
    if (f.res === 'gain' || f.res === 'sack' || f.res === 'td' || f.res === 'safety' || f.res === 'kneel') { const e = S.poss === 'A' ? S.pos + f.y : 100 - (S.pos + f.y); A.endHist[e < 0 ? 0 : e > 100 ? 100 : e]++; }
    inc(A.drv, r.drive.result); A.ep += r.drive.pts; A.dpl += r.drive.plays;
    if (r.winner === 'A') A.win++; else if (!r.winner) A.tie++;
    A.aH[Math.min(150, r.a)]++; A.bH[Math.min(150, r.b)]++;
    const m = r.a - r.b; A.marSum += m; A.marH[m < -MOFF ? 0 : m > MOFF ? 2 * MOFF : m + MOFF]++; A.totH[Math.min(150, r.a + r.b)]++;
    inc(A.mar, m <= -15 ? 'B by 15+' : m <= -8 ? 'B by 8–14' : m < 0 ? 'B by 1–7' : m === 0 ? 'Tie' : m <= 7 ? 'A by 1–7' : m <= 14 ? 'A by 8–14' : 'A by 15+'); if (r.ot) A.ot++;
    inc(A.next, r.next);
    if (m > S.spread) A.cover++; if (r.a + r.b > S.total) A.over++;
    if (wantSamp && A.samp.length < 5 && i % 5 === 0) A.samp.push(f);
  }
  return A;
}
export function mergeAgg(a, b) {
  const o = newAgg(); for (const k of ['n', 'ot', 'tie', 'go4', 'fd', 'ep', 'dpl', 'win', 'cover', 'over', 'marSum']) o[k] = a[k] + b[k];
  for (const k of ['call', 'out', 'car', 'tgt', 'cat', 'drv', 'mar', 'next']) { o[k] = Object.assign({}, a[k]); for (const j in b[k]) inc(o[k], j, b[k][j]); }
  for (const k of ['endHist', 'aH', 'bH', 'yH', 'marH', 'totH']) o[k] = a[k].map((v, i) => v + b[k][i]);
  o.samp = a.samp.length ? a.samp : b.samp; return o;
}
// Turn a line and total into engine settings. CAL is fit by scripts/calibrate.mjs so pregame sims average the spread and total.
export function prepS0(st, spread, total, CAL) {
  const c = CAL || (D && D.cal) || { a: 44, b: 0.06, c: 44, k: 1.1 };
  const tilt = Math.max(-0.35, Math.min(0.5, (c.a + c.b * Math.abs(spread) - total) / c.c)), k = c.k * (1 + 0.6 * Math.abs(tilt));
  return Object.assign({}, st, { spread, total, tilt, edge: spread * k, esd: (st.esd ?? (c.esd || 4)) * k });
}
