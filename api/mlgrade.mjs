// Live scorekeeping for the two win-probability systems. Every live read (the Monte Carlo, the ML model and, when there
// is one, the market) is noted from the home team's point of view, once per play; when the game goes final, every note
// is scored against who actually won. Saved to DATA_DIR/mlgrade.json and served at /api/ml/live.
// This is about predictions, not bets, so it is public.
import fs from 'node:fs';
import path from 'node:path';
const cl = p => Math.min(0.995, Math.max(0.005, p));
const ll = (p, y) => -(y ? Math.log(cl(p)) : Math.log(1 - cl(p)));

export function createGrader({ api, dataDir }) {
  const file = dataDir ? path.join(dataDir, 'mlgrade.json') : null;
  let db = { games: {} };
  try { if (file) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  db.games ||= {};
  let dirty = false;
  const save = () => { if (!dirty || !file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); dirty = false; } catch {} };
  setInterval(save, 15000).unref();

  // g: a tracked game (league, event, title, homeSlot, slotId); S: engine state; mc / ml / mkt: the ND team's chance
  function note(g, S, { mc, ml, mkt }) {
    if (mc == null || ml == null || !g.homeSlot || !(S.qtr >= 1 && S.qtr <= 4)) return;
    const key = `${g.league}:${g.event}`, h = g.homeSlot === 'ND', toHome = p => (p == null ? null : +(h ? p : 1 - p).toFixed(4));
    const G = db.games[key] ||= { league: g.league, event: String(g.event), matchup: g.title, homeId: g.slotId && g.slotId[g.homeSlot], pts: [], y: null, at: Date.now() };
    const tl = (4 - S.qtr) * 900 + (S.secs ?? 0), k = `${S.qtr}|${S.secs}|${S.nd}|${S.unc}|${S.poss}|${S.down}`;
    const last = G.pts[G.pts.length - 1];
    const row = [tl, toHome(mc), toHome(ml), toHome(mkt), k];
    if (last && last[4] === k) G.pts[G.pts.length - 1] = row; else if (G.pts.length < 400) G.pts.push(row);
    G.at = Date.now(); dirty = true;
  }
  // grade games that have gone quiet: ask ESPN whether they're final
  async function grade() {
    const now = Date.now();
    for (const [key, G] of Object.entries(db.games)) {
      if (G.y != null || now - G.at < 15 * 60000) continue;
      try {
        const sm = await api[G.league](new Request(`http://local/api?kind=summary&event=${G.event}`)).then(r => r.json());
        if (sm.state !== 'post') { if (now - G.at > 3 * 86400000) { delete db.games[key]; dirty = true; } continue; }
        const home = (sm.comps || []).find(c => c.homeAway === 'home'), away = (sm.comps || []).find(c => c.homeAway === 'away');
        if (!home || !away || home.score === away.score) { delete db.games[key]; dirty = true; continue; }
        G.y = home.score > away.score ? 1 : 0; G.final = `${away.abbr} ${away.score}, ${home.abbr} ${home.score}`; G.gradedAt = new Date().toISOString(); dirty = true;
      } catch {}
    }
    save();
  }
  setInterval(grade, 10 * 60000).unref(); setTimeout(grade, 30000).unref();

  function summary(league = 'all') {
    const gs = Object.values(db.games).filter(G => G.y != null && G.pts.length && (league === 'all' || G.league === league));
    const agg = () => ({ n: 0, mc: 0, ml: 0, avg: 0, mkt: 0, nm: 0, bmc: 0, bml: 0 });
    const tot = agg(), byPhase = {}, games = [];
    const phaseOf = tl => tl > 2700 ? 'Q1' : tl > 1800 ? 'Q2' : tl > 900 ? 'Q3' : tl > 300 ? 'Q4' : 'Last 5 min';
    for (const G of gs) {
      const gA = agg();
      for (const [tl, mc, ml, mkt] of G.pts) for (const a of [tot, gA, byPhase[phaseOf(tl)] ||= agg()]) {
        a.n++; a.mc += ll(mc, G.y); a.ml += ll(ml, G.y); a.avg += ll((mc + ml) / 2, G.y); a.bmc += (mc - G.y) ** 2; a.bml += (ml - G.y) ** 2;
        if (mkt != null) { a.nm++; a.mkt += ll(mkt, G.y); }
      }
      games.push({ league: G.league, event: G.event, matchup: G.matchup, final: G.final, plays: gA.n, mc: +(gA.mc / gA.n).toFixed(4), ml: +(gA.ml / gA.n).toFixed(4), at: G.gradedAt });
    }
    const fin = a => (a.n ? { n: a.n, mc: +(a.mc / a.n).toFixed(4), ml: +(a.ml / a.n).toFixed(4), avg: +(a.avg / a.n).toFixed(4), brierMc: +(a.bmc / a.n).toFixed(4), brierMl: +(a.bml / a.n).toFixed(4), mkt: a.nm ? +(a.mkt / a.nm).toFixed(4) : null, nMkt: a.nm } : { n: 0 });
    games.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    return { league, games: gs.length, open: Object.values(db.games).filter(G => G.y == null && (league === 'all' || G.league === league)).length,
      overall: fin(tot), phase: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, fin(v)])), mlWins: games.filter(g => g.ml < g.mc).length, recent: games.slice(0, 30) };
  }
  return { note, grade, summary, flush: () => { dirty = true; save(); } };
}
