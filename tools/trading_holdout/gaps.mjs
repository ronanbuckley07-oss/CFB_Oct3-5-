import { S, O } from './analyze.mjs';
const g = []; S.forEach((s, i) => { const o = O[i]; if (!o || s.qtr < 2) return; g.push(Math.abs(o.w - s.v)); }); g.sort((a, b) => a - b);
const q = p => (g[Math.floor(p * g.length)] * 100).toFixed(1);
console.log(`moneyline |model - market| in Q2-Q4, n=${g.length}: median ${q(.5)}  90th ${q(.9)}  95th ${q(.95)}  99th ${q(.99)} points`);
