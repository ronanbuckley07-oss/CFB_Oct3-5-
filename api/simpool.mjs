// Shared simulation pool. Every live game on the server queues its sims here, so the total compute is bounded by the
// thread count, not by how many people are watching. Jobs are split into chunks; a job whose game state has moved on
// (alive() false) stops getting chunks, and higher-priority work (the current play) jumps ahead of backfill.
import { Worker } from 'node:worker_threads';
import os from 'node:os';

const CHUNK = 2000;

export function createPool({ engineSrc, datas }) {
  // Main-thread engine copy, used only to merge results
  const E = new Function('D0', `${engineSrc}\nsetData(D0);\nreturn { mergeAgg, newAgg };`)(datas.cfb || datas.nfl);
  const cpu = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  const size = Math.max(1, +process.env.SIM_THREADS || Math.min(4, Math.max(1, cpu - 1)));
  const workers = [];
  const queue = []; // jobs
  let nextId = 1, simsRun = 0;

  function spawn() {
    const w = new Worker(new URL('./simworker.mjs', import.meta.url), { workerData: { engineSrc, datas }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
    w.busy = null;
    w.on('message', (msg) => {
      const job = w.busy; w.busy = null;
      if (job) {
        job.inflight--;
        if (msg.error) job.fail(new Error(msg.error));
        else { simsRun += msg.A.n; job.A = job.A ? E.mergeAgg(job.A, msg.A) : msg.A; job.done += msg.A.n; }
        settle(job);
      }
      dispatch();
    });
    w.on('error', (err) => { const job = w.busy; w.busy = null; if (job) { job.inflight--; job.fail(err); } const i = workers.indexOf(w); if (i >= 0) workers.splice(i, 1, spawn()); dispatch(); });
    return w;
  }
  for (let i = 0; i < size; i++) workers.push(spawn());

  function settle(job) {
    const dead = job.alive && !job.alive();
    if ((job.sent >= job.N || dead || job.failed) && job.inflight === 0 && !job.settled) {
      job.settled = true;
      const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1);
      if (job.failed) job.reject(job.err); else job.resolve(dead && job.done < job.N ? null : job.A);
    }
  }
  function dispatch() {
    for (const w of workers) {
      if (w.busy) continue;
      // highest priority first, oldest first within a priority
      for (const j of [...queue]) if (j.alive && !j.alive()) settle(j);
      queue.sort((a, b) => b.prio - a.prio || a.id - b.id);
      const job = queue.find(j => j.sent < j.N && !(j.alive && !j.alive()));
      if (!job) return;
      const n = Math.min(CHUNK, job.N - job.sent);
      job.sent += n; job.inflight++; w.busy = job;
      w.postMessage({ id: job.id, league: job.league, teams: job.teams, tk: job.tk, S: job.S, N: n, force: job.force, samp: job.sent === n, seed: null });
    }
  }
  // Run N sims of state S for one game. Resolves with the merged aggregate, or null if the job was abandoned.
  function run(league, teams, tk, S, N, { force = null, prio = 1, alive = null } = {}) {
    return new Promise((resolve, reject) => {
      const job = { id: nextId++, league, teams, tk, S, N, force, prio, alive, sent: 0, done: 0, inflight: 0, A: null, resolve, reject, settled: false,
        fail(err) { this.failed = true; this.err = err; } };
      queue.push(job); dispatch();
    });
  }
  return { run, stats: () => ({ threads: workers.length, queued: queue.length, busy: workers.filter(w => w.busy).length, simsRun }), mergeAgg: E.mergeAgg };
}
