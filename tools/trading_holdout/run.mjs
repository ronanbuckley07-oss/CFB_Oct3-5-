// node run.mjs data.json snaps.json out.json N filter
import { Worker } from 'node:worker_threads'; import fs from 'node:fs';
const [,,data,snapsF,outF,N0,filt]=process.argv; const N=+N0||4000;
let S=JSON.parse(fs.readFileSync(snapsF,'utf8'));
const keep={ all:()=>true,
  // the live auto window plus a margin either side, and every 3rd snap elsewhere for the phase table
  study:(s,i)=>(s.qtr===3&&s.secs<=600)||(s.qtr===4&&s.secs>=300)||i%3===0 }[filt||'study'];
S=S.map((s,i)=>({...s,i})).filter((s,i)=>keep(s,i));
const out=fs.existsSync(outF)?JSON.parse(fs.readFileSync(outF,'utf8')):{}; const todo=S.filter(s=>!out[s.i]);
console.error('snaps',S.length,'todo',todo.length); const t0=Date.now(); let k=0,done=0;
const W=4; await new Promise(res=>{ let live=W;
 for(let w=0;w<W;w++){const wk=new Worker('./simworker.mjs',{workerData:{data}});
  const next=()=>{ if(k>=todo.length){wk.terminate(); if(--live===0)res(); return;} const s=todo[k++]; wk.postMessage({i:s.i,st:s,N}); };
  wk.on('message',m=>{out[m.i]=m; done++; if(done%500===0){fs.writeFileSync(outF,JSON.stringify(out)); console.error(done,((Date.now()-t0)/1000).toFixed(0)+'s');} next();}); next();}
});
fs.writeFileSync(outF,JSON.stringify(out)); console.error('done',done,(Date.now()-t0)/1000);
