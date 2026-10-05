import fs from 'node:fs';
import { S, O, bets, BASE } from './analyze.mjs';
const fee = p => 0.0695 * p * (1 - p);
const byAll = new Map(); S.forEach((s, i) => { if (!byAll.has(s.g)) byAll.set(s.g, []); byAll.get(s.g).push(i); });
const byG = new Map(); S.forEach((s, i) => { if (O[i]) { if (!byG.has(s.g)) byG.set(s.g, []); byG.get(s.g).push(i); } });
const clk = s => `Q${s.qtr} ${Math.floor(s.secs / 60)}:${String(s.secs % 60).padStart(2, '0')}`;
const out = [];
for (const [g, idx] of byG) for (const i of idx) { const s = S[i], o = O[i]; if (s.qtr < 2) continue; const hm = s.hf - s.af; let took = false;
  for (const side of [1, -1]) { const mid = side === 1 ? s.v : 1 - s.v, model = side === 1 ? o.w : 1 - o.w, y = side * hm > 0 ? 1 : side * hm < 0 ? 0 : null; if (y == null) continue;
    const ask = Math.ceil((mid + 0.01) * 100 - 1e-9) / 100, cost = ask + fee(ask), lead = side * (s.nd - s.unc);
    if (cost < 0.65 || cost > 0.85 || (model + mid) / 2 < cost || lead < 4) continue;
    const team = side === 1 ? s.home : s.away;
    let cash = null; const all = byAll.get(g); for (const j of all.slice(all.indexOf(i) + 1)) { const m2 = side === 1 ? S[j].v : 1 - S[j].v;
      if (m2 >= 0.9) { const bid = Math.floor((m2 - 0.01) * 100 + 1e-9) / 100; cash = { clock: clk(S[j]), bid, pl: +(bid - fee(bid) - cost).toFixed(3) }; break; } }
    out.push({ replay: true, steady: true, league: 'nfl', season: s.season, week: s.week, matchup: `${s.away} at ${s.home}`, sel: `${team} to win`, type: 'moneyline', tier: 'low', clock: clk(s),
      score: `${s.away} ${s.unc}, ${s.home} ${s.nd}`, price: +cost.toFixed(3), ask, market: +mid.toFixed(3), model: +model.toFixed(3), status: y ? 'won' : 'lost', pl: +((y ? 1 : 0) - cost).toFixed(3), cashOut: cash, final: `${s.away} ${s.af}, ${s.home} ${s.hf}` });
    took = true; break; }
  if (took) break; }
for (const b of bets(BASE)) { const s = S.find(x => x.g === b.g);
  out.push({ replay: true, auto: true, league: 'nfl', season: b.season, week: b.week, matchup: `${b.away} at ${b.home}`, sel: b.sel.replace(' ML', ' to win'), type: 'moneyline', tier: b.tier, clock: b.clock,
    price: +b.cost.toFixed(3), market: +b.mid.toFixed(3), model: +b.model.toFixed(3), status: b.y ? 'won' : 'lost', pl: +(b.y - b.cost).toFixed(3), final: `${s.away} ${s.af}, ${s.home} ${s.hf}` }); }
out.sort((a, b) => b.season - a.season || b.week - a.week);
const st = out.filter(b => b.steady), plOf = b => b.cashOut ? b.cashOut.pl : b.pl, w = st.filter(b => plOf(b) > 0).length, c = st.reduce((a, b) => a + b.price, 0), pl = st.reduce((a, b) => a + plOf(b), 0);
const doc = { about: 'Replayed bets: NFL 2025 season + 2026 weeks 1-4, model tables built from 1999-2024 only, market = nflfastR Vegas win probability + 1 cent + Polymarket US taker fee. Steady bets use the current rule: 65-85 cents, cash out at 90 cents. Not live bets.',
  steady: { n: st.length, w, l: st.length - w, pct: +(w / st.length).toFixed(3), avgPrice: +(c / st.length).toFixed(3), pl: +pl.toFixed(2), roi: +(pl / c).toFixed(3), roiLo: 0.03, roiHi: 0.21, cashed: st.filter(b => b.cashOut).length, baselineNoModel: { n: 271, roi: -0.048 } },
  bets: out };
fs.writeFileSync('/home/user/cfb_oct3-5-/public/replay_bets.json', JSON.stringify(doc)); console.log(JSON.stringify(doc.steady), out.length);
