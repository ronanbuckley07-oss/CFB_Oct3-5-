// Run the model on a snap set and write raw probabilities: win, cover (closing spread), over (closing total)
import fs from 'node:fs';
const [,, dataPath, snapsPath, outPath, calJSON, N0, esdArg] = process.argv;
const src=fs.readFileSync(new URL('./engine.js',import.meta.url),'utf8');
const D=JSON.parse(fs.readFileSync(dataPath,'utf8')); const CAL=JSON.parse(calJSON); const N=+N0||600, ESD=+esdArg||5.5;
const E=new Function('D0',src+`setData(D0); return {runBatch};`)(D);
const H=JSON.parse(fs.readFileSync(snapsPath,'utf8')); const out=[]; const t0=Date.now();
for(const h of H){
  const tilt=Math.max(-0.3,Math.min(0.5,(CAL.a+CAL.b*Math.abs(h.spread)-h.totalLine)/CAL.d)), k=CAL.k*(1+0.6*Math.abs(tilt));
  const A=E.runBatch(Object.assign({},h,{edge:h.spread*k,esd:ESD*k,tilt,spread:h.spread,total:h.totalLine}),N,null,false);
  let cn=0,cc=0; A.marH.forEach((v,i)=>{const m=i-60; if(m>h.spread) cc+=v; if(m!==h.spread) cn+=v;});
  let on=0,oc=0; A.totH.forEach((v,i)=>{ if(i>h.totalLine) oc+=v; if(i!==h.totalLine) on+=v;});
  out.push({w:A.win/A.n,c:cn?cc/cn:null,o:on?oc/on:null,t:((Math.min(4,h.qtr)-1)*900+(900-h.secs))/3600,yw:h.result>0?1:h.result===0?0.5:0,
    yc:h.result>h.spread?1:h.result===h.spread?null:0, yo:h.finalTotal>h.totalLine?1:h.finalTotal===h.totalLine?null:0, v:h.vegas,g:h.g});
}
fs.writeFileSync(outPath,JSON.stringify(out)); console.error('done',H.length,(Date.now()-t0)/1000,'s');
