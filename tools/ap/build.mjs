// Builds api/apdata.json, everything the live AP projection and season simulator start from:
//   the poll model fit on every season's AP weeks (2020 left out: the COVID season's polls behaved differently),
//   the sufficient statistics behind it (so the server can keep adding weeks and refitting), last season's ratings
//   as this season's prior, this season's games so far (used only if ESPN can't be reached), and the backtest.
//   python3 tools/ap/fetch.py  (writes games.json from the sportsdataverse cfb_schedules releases)
//   node tools/ap/build.mjs games.json
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { G, PRIOR_SHRINK, ratings, rebuildPolls, teamsOf, samplesFor, stats, fitStats, FEATS } from '../../api/apmodel.mjs';
const src = process.argv[2] || 'games.json', games = JSON.parse(fs.readFileSync(src, 'utf8'));
const seasons = [...new Set(games.map(g => g[G.season]))].sort(), season = seasons[seasons.length - 1];
const priors = {};
for (const s of seasons) { const R = ratings(games.filter(g => g[G.season] === s), { prior: priors[s] || {} }); priors[s + 1] = Object.fromEntries(Object.entries(R).map(([k, v]) => [k, +(v * PRIOR_SHRINK).toFixed(2)])); }
const all = seasons.filter(s => s !== 2020).flatMap(s => samplesFor(games, s, { prior: priors[s] || {} }));
const st = { R: stats(all.filter(x => x.ranked)), U: stats(all.filter(x => !x.ranked)) }, model = fitStats(st);
const cur = all.filter(x => x.season === season), trainedWeek = cur.length ? Math.max(...cur.map(x => x.week)) : 0;
const out = `${process.env.TMPDIR || '/tmp'}/ap_backtest.json`;
execFileSync('node', [new URL('./backtest.mjs', import.meta.url).pathname, src], { env: { ...process.env, OUT: out }, stdio: ['ignore', 'ignore', 'inherit'] });
const backtest = JSON.parse(fs.readFileSync(out, 'utf8'));
const polls = rebuildPolls(games, season), teams = teamsOf(games, season);
// "Name-brand" teams for the season simulator: power conferences, Notre Dame, and anyone ranked in the last three seasons
const ranked = new Set(games.filter(g => g[G.season] >= season - 2).flatMap(g => [g[G.hr] ? String(g[G.hid]) : null, g[G.ar] ? String(g[G.aid]) : null]).filter(Boolean));
const brand = Object.values(teams).filter(t => t.p4 || ranked.has(t.id)).map(t => t.id);
const round = a => a.map(v => +v.toFixed(5));
const data = {
  built: new Date().toISOString(), season, trained: { season, week: trainedWeek, rows: all.length },
  feats: FEATS, model: { R: round(model.R), U: round(model.U), sdR: +model.sdR.toFixed(3), sdU: +model.sdU.toFixed(3) },
  stats: { R: { A: st.R.A.map(round), b: round(st.R.b), yy: +st.R.yy.toFixed(2), n: st.R.n }, U: { A: st.U.A.map(round), b: round(st.U.b), yy: +st.U.yy.toFixed(2), n: st.U.n } },
  prior: priors[season], teams, brand,
  polls: Object.fromEntries(Object.entries(polls).map(([w, p]) => [w, p.poll])),
  games: games.filter(g => g[G.season] === season),
  backtest,
};
const dest = new URL('../../api/apdata.json', import.meta.url).pathname;
fs.writeFileSync(dest, JSON.stringify(data));
console.log('wrote', dest, (fs.statSync(dest).size / 1024).toFixed(0) + ' KB', 'season', season, 'trained through week', trainedWeek, 'rows', all.length, 'brand teams', brand.length);
console.log('backtest', JSON.stringify(backtest.all));
