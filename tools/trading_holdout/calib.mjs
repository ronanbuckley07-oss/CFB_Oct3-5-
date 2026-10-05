import { S, O, board } from './analyze.mjs';
const rows=[]; S.forEach((s,i)=>{ if(!O[i]||!((s.qtr===3&&s.secs<=450)||(s.qtr===4&&s.secs>=480))) return; for(const c of board(s,O[i],true)) if(c.type!=='ml'&&c.y!=null) rows.push({...c,g:s.g}); });
for(const t of ['spread','total']){ console.log(t); for(let b=0;b<10;b++){ const r=rows.filter(x=>x.type===t&&Math.min(9,Math.floor(x.mid*10))===b); if(!r.length) continue;
  const m=k=>(r.reduce((a,x)=>a+x[k],0)/r.length).toFixed(3); console.log(` bin${b} n=${r.length} market=${m('mid')} model=${m('model')} actual=${m('y')}`);}}
