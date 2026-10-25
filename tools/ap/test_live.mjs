// Feeds api/ap.mjs fake ESPN responses (same shapes as ESPN's site and core APIs) to check parsing, the live
// projection, and learning when a new poll appears.  node tools/ap/test_live.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert';
import { createAP } from '../../api/ap.mjs';
import { G } from '../../api/apmodel.mjs';
const D = JSON.parse(fs.readFileSync(new URL('../../api/apdata.json', import.meta.url), 'utf8'));
const W = Math.max(...Object.keys(D.polls).map(Number)); // the bootstrap's current week (8)
const team = id => ({ id: String(id), location: D.teams[id]?.name || 'FCS ' + id, abbreviation: 'T' + id, conferenceId: { SEC: 8, 'Big Ten': 5, ACC: 1, 'Big 12': 4 }[D.teams[id]?.conf] || 18 });
let r = 1; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
// week W played: favorite by rank wins; week W+1 in progress
const wk = w => D.games.filter(g => g[G.week] === w);
const scores = {}; for (const g of wk(W)) { const h = 10 + Math.floor(rnd() * 35), a = 10 + Math.floor(rnd() * 35); scores[g[G.id]] = [h, a === h ? a + 3 : a]; }
const poll = (ranks, week) => ({ rankings: [{ name: 'AP Top 25', shortName: 'AP Poll', type: 'ap', occurrence: { number: week, value: String(week) }, ranks: Object.entries(ranks).map(([id, cur]) => ({ current: cur, points: 1600 - cur * 60, team: team(id) })), others: [] }] });
const pollW = D.polls[W];
// the next poll: shuffle the week W poll a bit
const next = Object.fromEntries(Object.entries(pollW).sort((a, b) => a[1] - b[1] + (rnd() - 0.5) * 6).map(([id], i) => [id, i + 1]));
const board = (w, state) => ({ events: wk(w).map(g => ({ id: g[G.id], date: g[G.date] + 'T19:00Z', competitions: [{ neutralSite: !!g[G.neutral],
  status: { period: state === 'in' ? 3 : 0, clock: 420, type: { state, shortDetail: state === 'in' ? '7:00 - 3rd' : '' } },
  situation: state === 'in' ? { lastPlay: { probability: { homeWinPercentage: 0.7 } } } : undefined,
  odds: [{ details: `T${g[G.hid]} -6.5` }],
  competitors: [{ homeAway: 'home', score: String(state === 'post' ? scores[g[G.id]][0] : state === 'in' ? 21 : 0), curatedRank: { current: (state === 'post' ? pollW : next)[g[G.hid]] || 99 }, team: team(g[G.hid]) },
                { homeAway: 'away', score: String(state === 'post' ? scores[g[G.id]][1] : state === 'in' ? 14 : 0), curatedRank: { current: (state === 'post' ? pollW : next)[g[G.aid]] || 99 }, team: team(g[G.aid]) }] }] })) });
const calls = [];
const fakeFetch = async url => { calls.push(url); const u = String(url);
  let body;
  if (u.endsWith('/rankings')) body = poll(next, W + 1);
  else if (u.includes('/weeks/')) { const w = +u.match(/weeks\/(\d+)/)[1]; body = w === W ? { ranks: Object.entries(pollW).map(([id, c]) => ({ current: c, team: { $ref: `http://x/teams/${id}?lang=en` } })) } : { ranks: [] }; }
  else if (u.includes('/scoreboard')) { const w = +u.match(/week=(\d+)/)[1]; body = board(w, w < W ? 'post' : w === W ? 'post' : w === W + 1 ? 'in' : 'pre'); }
  else return { ok: false, status: 404 };
  return { ok: true, json: async () => body };
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
const ap = createAP({ dataDir: dir, fetchImpl: fakeFetch });
await ap.refresh(true);
const p = ap.poll();
assert.equal(p.source, 'ESPN'); assert.equal(p.week, W + 1); assert.equal(p.current.length, Object.keys(next).length);
assert.ok(p.games.live > 0, 'week W+1 games show as live');
const lv = p.projection.find(t => t.game && t.game.state === 'in'); assert.ok(lv, 'a projected team has a live game'); assert.ok(lv.game.us != null && lv.game.clock);
const s = ap._state(); assert.deepEqual(s.learned, [W], 'learned from week W'); assert.equal(s.log.length, 1); assert.equal(s.log[0].week, W + 1);
console.log('learned week', W, '-> poll', W + 1, 'projection missed by', s.log[0].avgMiss, 'top25', s.log[0].top25);
assert.ok(fs.existsSync(path.join(dir, 'ap_state.json')));
// a second server reads the saved state and doesn't learn the same week twice
const ap2 = createAP({ dataDir: dir, fetchImpl: fakeFetch }); await ap2.refresh(true); assert.deepEqual(ap2._state().learned, [W]);
const t = ap.team('333'); assert.ok(t.games.length >= 10); assert.ok(t.hist.reduce((a, b) => a + b, 0) > 0.99);
const tl = ap.teamList(); assert.ok(tl.teams.length > 60);
// what-if: force a live game the other way and the poll changes
const sl = p.slate.find(x => x.state === 'in' || x.state === 'pre'); assert.ok(sl, 'slate has an open game');
const flip = ap.poll(`${sl.id}:${sl.p >= 0.5 ? 'a' : 'h'}`); assert.equal(Object.keys(flip.force).length, 1);
assert.equal(flip.slate.find(x => x.id === sl.id).state, 'forced');
assert.ok(p.swing.length > 0 && p.chaos.top10Losses.length === 11);
const h = ap.history(); assert.ok(h.weeks.length >= 2); assert.equal(h.weeks[h.weeks.length - 1].week, W + 1); assert.equal(h.weeks.find(x => x.week === W).source, 'ESPN');
const m = ap.matchup('333', '61', 'n'); assert.ok(m.p > 0 && m.p < 1); assert.equal(m.sims.length, 100); assert.ok(m.score[0] > 0 && m.common.length >= 0);
const mh = ap.matchup('333', '61', 'a'), ma = ap.matchup('333', '61', 'b'); assert.ok(mh.p > m.p && m.p > ma.p, 'home field moves it');
assert.ok(Math.abs(m.sims.filter(x => x[0] > x[1]).length / 100 - m.p) < 0.2);
console.log('matchup', m.a.name, m.score[0], '-', m.score[1], m.b.name, 'p', m.p, 'common', m.common.length, '| swing top', p.swing[0].awayName, '@', p.swing[0].homeName);
const mlo = ap.ml(); assert.ok(mlo.exp && mlo.exp.poll.ablation.length === 8); assert.equal(mlo.weightHist.length, 2, 'shipped weights + one learned week'); assert.ok(mlo.play.length > 20 && mlo.values[mlo.play[0].id] != null);
console.log('ok:', p.projection.slice(0, 5).map(x => `${x.name} (${x.prev}->${x.mean.toFixed(1)})`).join(', '), '| fetches', calls.length);
process.exit(0);
