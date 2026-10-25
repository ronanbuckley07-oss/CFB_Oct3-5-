// Run the site's Monte Carlo engine (straight from the game page, same as the live server) on a list of game states,
// so it can be scored against the ML models on the same plays.
//   node tools/ml/mc_run.mjs public/game.html snaps.json out.json [sims per state]
// A state is home-as-ND: poss, pos, down, dist, qtr, secs, nd, unc, toND, toUNC, half2Recv, spread (home expected
// margin), totalLine. Writes { index: home win probability }.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs'; import os from 'node:os';
if (isMainThread) {
  const [, , page, snapsF, outF, N0] = process.argv, N = +N0 || 1500;
  const html = fs.readFileSync(page, 'utf8'), i = html.indexOf('<script id="engine-src">') + '<script id="engine-src">'.length;
  const engineSrc = html.slice(i, html.indexOf('</script>', i)), data = JSON.parse(html.match(/const DATA=(\{.*?\});\n/s)[1]);
  const cal = new Function(`return ${html.match(/const LG=(\{.*?\});/)[1]};`)().cal;
  const S = JSON.parse(fs.readFileSync(snapsF, 'utf8')), out = fs.existsSync(outF) ? JSON.parse(fs.readFileSync(outF, 'utf8')) : {};
  const todo = S.map((s, i) => ({ ...s, i })).filter(s => out[s.i] == null), W = Math.max(1, Math.min(8, os.cpus().length));
  console.error('states', S.length, 'to run', todo.length, 'threads', W, 'sims each', N); const t0 = Date.now(); let k = 0, done = 0;
  await new Promise(res => { let live = W;
    for (let w = 0; w < W; w++) { const wk = new Worker(new URL(import.meta.url), { workerData: { engineSrc, data, cal } });
      const next = () => { if (k >= todo.length) { wk.terminate(); if (--live === 0) res(); return; } const s = todo[k++]; wk.postMessage({ i: s.i, st: s, N }); };
      wk.on('message', m => { out[m.i] = m.w; done++; if (done % 1000 === 0) { fs.writeFileSync(outF, JSON.stringify(out)); console.error(done, ((Date.now() - t0) / 1000).toFixed(0) + 's'); } next(); }); next(); } });
  fs.writeFileSync(outF, JSON.stringify(out)); console.error('done', done, ((Date.now() - t0) / 1000).toFixed(0) + 's');
} else {
  const { engineSrc, data, cal } = workerData;
  const E = new Function('D0', `${engineSrc}\nsetData(D0);\nreturn { runBatch };`)(data);
  // the same pregame tilt the live server applies (prepS0 in api/live.mjs)
  const prep = st => { const tilt = Math.max(-0.3, Math.min(0.5, (cal.a + cal.b * Math.abs(st.spread) - st.totalLine) / cal.d)), k = cal.k * (1 + 0.6 * Math.abs(tilt));
    return Object.assign({}, st, { neutral: true, spread: st.spread, total: st.totalLine, tilt, edge: st.spread * k, esd: 5.5 * k }); };
  parentPort.on('message', ({ i, st, N }) => { const A = E.runBatch(prep(st), N, null, false); parentPort.postMessage({ i, w: +((A.win + 0.5 * A.tie) / A.n).toFixed(4) }); });
}
