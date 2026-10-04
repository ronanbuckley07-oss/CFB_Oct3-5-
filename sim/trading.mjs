// Trading signals and the public bet ledger.
//
// For every market the site can see (Kalshi and Polymarket winner, spread and total contracts), the edge is the model's
// probability minus what it would cost to buy that contract, fees included. A signal fires when the edge reaches the threshold
// the historical study picked (scripts/trading_study.mjs -> sim/trading.json). The first signal on each market in each game is
// written to the ledger, settled when the game ends, and counted in the running record on the home page.
//
// Prices are probabilities: a contract that pays $1 if it happens costs `price`. Profit per $1 staked on a win is (1 - price) / price.
import fs from 'node:fs';
import path from 'node:path';

export function createTrading({ rulesFile, ledgerFile, espn }) {
  let rules = { threshold: null, cost: 0.02, priceRange: [0.1, 0.9] };
  try { rules = { ...rules, ...JSON.parse(fs.readFileSync(rulesFile, 'utf8')) }; } catch {}
  // With no threshold that survived the study, the menu still shows edges, against a provisional bar, and says so
  const T = rules.threshold ?? rules.provisional ?? 0.08, tested = rules.threshold != null;
  const FEE = 0.01; // exchange fee on top of the ask, in probability points
  let ledger = { bets: [], since: new Date().toISOString() };
  try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch {}
  let saveT = null;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(ledgerFile), { recursive: true }); const tmp = ledgerFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(ledger)); fs.renameSync(tmp, ledgerFile); }
      catch (e) { console.error('ledger save failed', e.message); }
    }, 200);
  }

  // ---- model probabilities from a home-oriented aggregate ----
  const wpHome = A => (A.win + 0.5 * A.tie) / A.n;
  function cover(A, side, by) { // P(that side's final margin > by), pushes removed
    let n = 0, c = 0; A.marH.forEach((v, i) => { const m = i - 80, mm = side === 'home' ? m : -m; n += v; if (mm > by) c += v; else if (mm === by) n -= v; });
    return n ? c / n : null;
  }
  function over(A, line) { let n = 0, c = 0; A.totH.forEach((v, i) => { n += v; if (i > line) c += v; else if (i === line) n -= v; }); return n ? c / n : null; }
  // What it costs to buy: the ask when the market shows one, otherwise the midpoint plus half a typical spread
  const askOf = (q, flip) => { if (!q) return null; if (flip) { if (q.bid != null) return 1 - q.bid; return q.p != null ? 1 - q.p + 0.01 : null; } if (q.ask != null) return q.ask; return q.p != null ? q.p + 0.01 : null; };

  // Every tradeable contract for one game, scored against the model
  function opportunities(g) {
    const A = g.agg, MK = g.MK; if (!A || !MK || !g.info) return [];
    const out = [], names = { home: g.info.teams.A.abbr, away: g.info.teams.B.abbr };
    const add = (o) => {
      if (o.model == null || o.price == null || !(o.price > 0 && o.price < 1)) return;
      const cost = Math.min(0.999, o.price + FEE), edge = o.model - cost;
      const inRange = cost >= rules.priceRange[0] && cost <= rules.priceRange[1];
      out.push({ ...o, cost: +cost.toFixed(4), model: +o.model.toFixed(4), edge: +edge.toFixed(4), need: +(T - edge).toFixed(4), close: +Math.max(0, Math.min(1, edge / T)).toFixed(3),
        status: !inRange ? 'out' : edge >= T ? 'signal' : edge >= T / 2 ? 'near' : 'watch' });
    };
    for (const [src, m] of [['Kalshi', MK.kalshi], ['Polymarket', MK.poly]]) {
      if (!m || !m.found) continue;
      const pH = wpHome(A);
      for (const side of ['home', 'away']) {
        const q = m[side]; if (!q) continue;
        add({ src, kind: 'win', side, line: null, label: `${names[side]} to win`, model: side === 'home' ? pH : 1 - pH, price: askOf(q), url: m.url });
      }
      for (const s of m.spreads || []) {
        add({ src, kind: 'spread', side: s.side, line: s.by, label: `${names[s.side]} by more than ${s.by}`, model: cover(A, s.side, s.by), price: s.p + 0.01, url: m.url });
        const other = s.side === 'home' ? 'away' : 'home';
        add({ src, kind: 'spread', side: other, line: -s.by, label: `${names[other]} ${s.by > 0 ? `+${s.by}` : `within ${-s.by}`}`, model: cover(A, other, -s.by), price: 1 - s.p + 0.01, url: m.url });
      }
      for (const t of m.totals || []) {
        add({ src, kind: 'total', side: 'over', line: t.line, label: `Over ${t.line}`, model: over(A, t.line), price: t.p + 0.01, url: m.url });
        const u = over(A, t.line); add({ src, kind: 'total', side: 'under', line: t.line, label: `Under ${t.line}`, model: u == null ? null : 1 - u, price: 1 - t.p + 0.01, url: m.url });
      }
    }
    // Best price per contract across the two exchanges, closest to a signal first
    const best = new Map();
    for (const o of out) { const k = `${o.kind}|${o.side}|${o.line}`; const b = best.get(k); if (!b || o.edge > b.edge) best.set(k, { ...o, alt: b ? [b.src] : [] }); else b.alt.push(o.src); }
    return [...best.values()].sort((a, b) => (a.status === 'out') - (b.status === 'out') || b.edge - a.edge);
  }

  // Record the first signal on each contract in each game. Only in-game, on a full run, which is what the study tested.
  function consider(g, opps) {
    if (!g.aggFinal || g.status.state !== 'in') return [];
    const added = [];
    for (const o of opps) {
      if (o.status !== 'signal') continue;
      const key = `${g.id}|${o.kind}|${o.side}|${o.line}`;
      if (ledger.bets.some(b => b.key === key)) continue;
      // One bet per market type per game, like the historical study: never both sides, and not every rung of one ladder
      if (ledger.bets.some(b => b.event === g.id && b.kind === o.kind)) continue;
      const S = g.S, b = { key, event: g.id, title: g.info.title, home: g.info.teams.A.abbr, away: g.info.teams.B.abbr, kind: o.kind, side: o.side, line: o.line, label: o.label,
        src: o.src, price: o.cost, model: o.model, edge: o.edge, threshold: T, tested, at: new Date().toISOString(),
        when: `${S.qtr >= 5 ? 'OT' : 'Q' + S.qtr} ${Math.floor(S.secs / 60)}:${String(S.secs % 60).padStart(2, '0')}`, score: [S.a, S.b], result: null };
      ledger.bets.push(b); added.push(b);
    }
    if (added.length) save();
    return added;
  }
  function settleWith(event, home, away) {
    let n = 0;
    for (const b of ledger.bets) {
      if (b.event !== event || b.result) continue;
      const m = b.side === 'home' ? home - away : away - home, tot = home + away;
      let r;
      if (b.kind === 'win') r = home === away ? 'push' : m > 0 ? 'win' : 'loss';
      else if (b.kind === 'spread') r = m > b.line ? 'win' : m === b.line ? 'push' : 'loss';
      else { const o = b.side === 'over' ? tot - b.line : b.line - tot; r = o > 0 ? 'win' : o === 0 ? 'push' : 'loss'; }
      b.result = r; b.final = [home, away]; b.settled = new Date().toISOString(); n++;
    }
    if (n) save();
    return n;
  }
  // Games can end with nobody watching, so open bets are checked against ESPN on a slow timer (no simulation involved)
  async function sweep() {
    const open = [...new Set(ledger.bets.filter(b => !b.result).map(b => b.event))];
    for (const ev of open) {
      try {
        const s = espn.trimSummary(await espn.get(`${espn.BASE}/summary?event=${ev}`, 60000));
        if (s.state !== 'post') continue;
        const h = s.comps.find(c => c.homeAway === 'home'), a = s.comps.find(c => c.homeAway === 'away');
        if (h && a) settleWith(ev, h.score, a.score);
      } catch {}
    }
  }
  setInterval(sweep, 10 * 60000).unref(); setTimeout(sweep, 15000).unref();

  function summary() {
    const done = ledger.bets.filter(b => b.result).sort((a, b) => a.settled < b.settled ? -1 : a.settled > b.settled ? 1 : a.at < b.at ? -1 : 1);
    const w = done.filter(b => b.result === 'win').length, l = done.filter(b => b.result === 'loss').length, p = done.filter(b => b.result === 'push').length;
    let units = 0, staked = 0; for (const b of done) { if (b.result === 'push') continue; staked += 1; units += b.result === 'win' ? (1 - b.price) / b.price : -1; }
    // streaks ignore pushes
    const seq = done.filter(b => b.result !== 'push').map(b => b.result);
    let cur = 0, curType = null; for (let i = seq.length - 1; i >= 0; i--) { if (!curType) curType = seq[i]; if (seq[i] !== curType) break; cur++; }
    let bestW = 0, run = 0; for (const r of seq) { run = r === 'win' ? run + 1 : 0; bestW = Math.max(bestW, run); }
    const expected = done.filter(b => b.result !== 'push').reduce((s, b) => s + b.model, 0);
    return { since: ledger.since, record: { w, l, p }, open: ledger.bets.filter(b => !b.result).length, streak: curType ? { type: curType, n: cur } : null, bestWinStreak: bestW,
      units: +units.toFixed(2), roi: staked ? +(units / staked).toFixed(3) : null, expectedWins: +expected.toFixed(1),
      threshold: T, tested, study: rules.chosen ? { n: rules.chosen.fit.n, roi: rules.chosen.fit.roi, test: rules.chosen.test } : null,
      recent: ledger.bets.slice(-30).reverse() };
  }
  return { opportunities, consider, settleWith, summary, rules: () => ({ ...rules, T, tested, fee: FEE }) };
}
