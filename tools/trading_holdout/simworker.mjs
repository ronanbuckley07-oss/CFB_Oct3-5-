import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
const src=fs.readFileSync('engine.js','utf8');
const D=JSON.parse(fs.readFileSync(workerData.data,'utf8'));
const E=new Function('D0',src+`\nsetData(D0); return {runBatch};`)(D);
const CAL={a:42.2,b:0,k:1.345,d:36.2}, ESD=5.5;
function prep(st){const tilt=Math.max(-0.3,Math.min(0.5,(CAL.a+CAL.b*Math.abs(st.spread)-st.totalLine)/CAL.d)),k=CAL.k*(1+0.6*Math.abs(tilt));
  return Object.assign({},st,{neutral:true,spread:st.spread,total:st.totalLine,tilt,edge:st.spread*k,esd:ESD*k});}
parentPort.on('message',({i,st,N})=>{
  const A=E.runBatch(prep(st),N,null,false), MO=60;
  // P(home final margin > x) for x=-40..40 raw, P(total > t) for t=20..80 raw (for half-point lines)
  const mg=[]; for(let x=-40;x<=40;x++){let c=0;A.marH.forEach((v,j)=>{if(j-MO>x)c+=v;}); mg.push(+(c/A.n).toFixed(4));}
  const tt=[]; for(let t=20;t<=80;t++){let c=0;A.totH.forEach((v,j)=>{if(j>t)c+=v;}); tt.push(+(c/A.n).toFixed(4));}
  parentPort.postMessage({i,w:+((A.win+0.5*A.tie)/A.n).toFixed(4),mg,tt});
});
