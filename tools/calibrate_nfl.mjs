// Usage: copy the <script id="engine-src"> contents of public/game.html to tools/engine.js, then: node calibrate_nfl.mjs nfl_data.json fit|snaps|check
import fs from 'node:fs';
const src=fs.readFileSync(new URL('./engine.js',import.meta.url),'utf8');
const D=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const mk=new Function('D0',src+`
setData(D0);
function regSnaps(s0,N){ let tot=0; for(let i=0;i<N;i++){ const s=Object.assign({},s0,{lastScore:null,toND:3,toUNC:3}); s.edge=s0.esd?s0.edge+s0.esd*gauss():s0.edge; let n=0; while(s.qtr<=4&&n<400){playOnce(s,false,null);n++;} tot+=n;} return tot/N; }
return {simulate,regSnaps,setData};`);
const E=mk(D);
const base={poss:'ND',pos:30,down:1,dist:10,qtr:1,secs:900,nd:0,unc:0,half2Recv:'UNC',toND:3,toUNC:3};
function run(edge,esd,tilt,N){ let m=0,t=0,w=0,ties=0,ot=0; for(let i=0;i<N;i++){ const r=E.simulate(Object.assign({},base,{edge,esd,tilt}),null); m+=r.nd-r.unc; t+=r.nd+r.unc; if(r.winner==='ND')w++; if(r.winner==='TIE')ties++; if(r.ot)ot++; } return {m:m/N,t:t/N,w:w/N,tie:ties/N,ot:ot/N}; }
const mode=process.argv[3];
const t0=Date.now();
if(mode==='snaps'){ console.log(JSON.stringify({snaps:E.regSnaps(Object.assign({},base,{edge:0,esd:5.5,tilt:0}),20000),ms:Date.now()-t0})); }
else if(mode==='fit'){
  const N=+process.argv[4]||20000; const out={};
  // margin per point of edge, natural totals, total per unit tilt
  for(const e of [0,3,7,10,14]) out['e'+e]=run(e,5.5,0,N);
  out.tp=run(0,5.5,0.2,N); out.tm=run(0,5.5,-0.2,N);
  console.log(JSON.stringify(out)); console.error('ms',Date.now()-t0);
} else if(mode==='check'){
  const CAL=JSON.parse(process.argv[4]); const N=+process.argv[5]||20000; const res=[];
  for(const [sp,tot] of [[0,44],[3,45],[7,43],[10,47],[14,42],[3,50],[7,38]]){
    const tilt=Math.max(-0.3,Math.min(0.5,(CAL.a+CAL.b*Math.abs(sp)-tot)/CAL.d)), k=CAL.k*(1+0.6*Math.abs(tilt));
    const r=run(sp*k,5.5*k,tilt,N); res.push({sp,tot,m:+r.m.toFixed(2),t:+r.t.toFixed(2),w:+r.w.toFixed(3),tie:+r.tie.toFixed(4),ot:+r.ot.toFixed(3)}); }
  console.log(JSON.stringify(res)); console.error('ms',Date.now()-t0);
}
