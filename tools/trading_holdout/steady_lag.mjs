import { S, O, stats } from './analyze.mjs';
const fee = p => 0.0695 * p * (1 - p);
const byG = new Map(); S.forEach((s, i) => { if (O[i]) { if (!byG.has(s.g)) byG.set(s.g, []); byG.get(s.g).push(i); } });
for (const L of [0, 1, 2]) for (const mode of ['lateFeed', 'staleQuote']) { if (L === 0 && mode === 'staleQuote') continue; const out = [];
  for (const [g, idx] of byG) { for (let k = L; k < idx.length; k++) { const i = idx[k], j = idx[k - L], s = S[i]; if (s.qtr < 2) continue;
    const mdl = mode === 'lateFeed' ? O[j].w : O[i].w, mk = mode === 'staleQuote' ? S[j].v : s.v, sc = mode === 'lateFeed' ? S[j] : s; // model sees old score when the feed is late
    const hm = s.hf - s.af; let took = false;
    for (const side of [1, -1]) { const mid = side === 1 ? mk : 1 - mk, model = side === 1 ? mdl : 1 - mdl, y = side * hm > 0 ? 1 : side * hm < 0 ? 0 : null; if (y == null) continue;
      const ask = Math.ceil((mid + 0.01) * 100 - 1e-9) / 100, cost = ask + fee(ask), lead = side * (sc.nd - sc.unc);
      if (cost < 0.6 || cost > 0.85 || (model + mid) / 2 < cost || lead < 4) continue;
      const nowMid = side === 1 ? s.v : 1 - s.v, nAsk = Math.ceil((nowMid + 0.01) * 100 - 1e-9) / 100, real = nAsk + fee(nAsk);
      out.push({ g, y, cost: real, mid: nowMid, model, fair: (model + mid) / 2 }); took = true; break; }
    if (took) break; } }
  const x = stats(out); console.log(mode, 'L', L, `n=${x.n} hit=${x.hit} realCost=${x.cost} roi=${x.roi} [${x.lo},${x.hi}]`); }
