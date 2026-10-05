// When the model says a spread line wins 85-98%, how often does it? And how does that depend on how far the line is
// from the current margin, and on time left? Replay = 2025-26 NFL holdout, tables from 1999-2024.
import { S, O } from './analyze.mjs';
const rows = [];
S.forEach((s, i) => { const o = O[i]; if (!o || s.qtr < 2 || s.qtr > 4) return;
  const tl = (4 - s.qtr) * 900 + s.secs, cur = s.nd - s.unc, fin = s.hf - s.af;
  for (let x = -20; x <= 20; x++) { const line = x + 0.5; // home margin > line
    const pH = o.mg[x + 40]; if (pH == null) continue;
    for (const [p, y, dist] of [[pH, fin > line ? 1 : 0, Math.abs(line - cur)], [1 - pH, fin > line ? 0 : 1, Math.abs(line - cur)]])
      if (p >= 0.85 && p <= 0.98) rows.push({ p, y, dist, tl, g: s.g, v: s.v, cur, line }); } });
const show = (lab, f) => { const r = rows.filter(f); if (!r.length) return; const m = r.reduce((a, x) => a + x.p, 0) / r.length, y = r.reduce((a, x) => a + x.y, 0) / r.length;
  console.log(lab.padEnd(46), `n=${String(r.length).padStart(6)} games=${new Set(r.map(x => x.g)).size} model says ${(m * 100).toFixed(1)}%  actually won ${(y * 100).toFixed(1)}%  gap ${((m - y) * 100).toFixed(1)}`); };
show('all lines the model puts at 85-98%', () => true);
for (const [a, b] of [[0.85, 0.9], [0.9, 0.94], [0.94, 0.98]]) show(`  model ${a * 100}-${b * 100}%`, r => r.p >= a && r.p < b);
for (const [a, b] of [[0, 3], [3, 7], [7, 11], [11, 99]]) show(`  line ${a}-${b} pts from the current margin`, r => r.dist >= a && r.dist < b);
for (const [a, b, l] of [[1500, 2700, 'Q2-early Q3'], [900, 1500, 'Q3 late'], [480, 900, 'Q4 15:00-8:00'], [0, 480, 'Q4 last 8:00']]) show(`  ${l}`, r => r.tl >= a && r.tl < b);
show('  like the screenshot: 6-10 pts away, 15-25 min left', r => r.dist >= 6 && r.dist <= 10 && r.tl >= 900 && r.tl <= 1500);
