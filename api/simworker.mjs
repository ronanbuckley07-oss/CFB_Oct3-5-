// One simulation thread. Holds an engine instance per league (same engine source the browser uses) and runs chunks.
import { parentPort, workerData } from 'node:worker_threads';

const engines = {};
for (const [league, data] of Object.entries(workerData.datas)) {
  // new Function gives each league its own copy of the engine's globals (tables, rosters, RNG)
  engines[league] = new Function('D0', `${workerData.engineSrc}\nsetData(D0);\nreturn { runBatch, setTeams, seedRng };`)(data);
}
const rosterKey = {};

parentPort.on('message', (m) => {
  try {
    const e = engines[m.league];
    if (rosterKey[m.league] !== m.tk) { e.setTeams(m.teams); rosterKey[m.league] = m.tk; }
    e.seedRng(m.seed ?? null);
    parentPort.postMessage({ id: m.id, A: e.runBatch(m.S, m.N, m.force || null, !!m.samp) });
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String(err && err.stack || err) });
  }
});
