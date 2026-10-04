// Worker thread: loads the play tables once, then runs batches of simulations on request.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import * as E from './engine.mjs';
const D = JSON.parse(fs.readFileSync(workerData.dataPath, 'utf8'));
const BASE_TEAMS = D.teams;
E.setData(D);
const teamCache = new Map(); // a few games' rosters, keyed by the pool's team version
parentPort.on('message', m => {
  try {
    if (m.teams) teamCache.set(m.tk, m.teams);
    const t = teamCache.get(m.tk) || BASE_TEAMS;
    if (D.teams !== t) E.setTeams(t);
    if (teamCache.size > 40) teamCache.delete(teamCache.keys().next().value);
    E.seedRng(m.seed);
    parentPort.postMessage({ id: m.id, A: E.runBatch(m.S, m.N, m.force, m.samp) });
  } catch (e) { parentPort.postMessage({ id: m.id, error: String(e && e.stack || e) }); }
});
