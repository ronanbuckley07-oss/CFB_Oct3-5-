// When in a game do model-vs-market bets pay? Replays NFL snaps (tools: build timing.json from nflverse, see README) against Vegas win probability.
import fs from 'node:fs';
const src=fs.readFileSync(new URL('./engine.js',import.meta.url),'utf8');
const D=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); const CAL={a:42.2,b:0,k:1.345,d:36.2};
const E=new Function('D0',src+`setData(D0); return {runBatch};`)(D);
const H=JSON.parse(fs.readFileSync(new URL('./timing.json',import.meta.url),'utf8')); const N=+process.argv[3]||500;
const bucket=h=>h.qtr<4?'Q'+h.qtr+(h.secs>450?' first half':' second half'):h.secs>480?'Q4 15:00-8:00':h.secs>180?'Q4 8:00-3:00':'Q4 last 3:00';
const B={}; const t0=Date.now();
for(const h of H){
  const tilt=Math.max(-0.3,Math.min(0.5,(CAL.a+CAL.b*Math.abs(h.spread)-h.total)/CAL.d)), k=CAL.k*(1+0.6*Math.abs(tilt));
  const A=E.runBatch(Object.assign({},h,{edge:h.spread*k,esd:5.5*k,tilt}),N,null,false); const p=A.win/A.n;
  const b=B[bucket(h)]||(B[bucket(h)]={n:0,bm:0,bv:0,bets:0,wins:0,pl:0,cost:0,exp:0});
  b.n++; b.bm+=(p-h.y)**2; b.bv+=(h.vegas-h.y)**2;
  // bet against the Vegas-based price when the model disagrees by 5+ points (1 cent of cost assumed)
  for(const [mp,price,y] of [[p,h.vegas,h.y],[1-p,1-h.vegas,1-h.y]]){
    if(mp-price>=0.05&&y!==0.5){ const c=price+0.01; b.bets++; b.cost+=c; b.exp+=mp; if(y===1){b.wins++; b.pl+=1-c;} else b.pl-=c; }
  }
}
const rows=Object.entries(B).sort().map(([k,b])=>({window:k,snaps:b.n,brierModel:+(b.bm/b.n).toFixed(4),brierVegas:+(b.bv/b.n).toFixed(4),bets:b.bets,hit:+(b.wins/b.bets).toFixed(3),modelSaid:+(b.exp/b.bets).toFixed(3),roi:+(b.pl/b.cost).toFixed(3)}));
console.log(JSON.stringify(rows,null,0)); console.error('s',(Date.now()-t0)/1000);
