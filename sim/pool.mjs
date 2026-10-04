// A small worker-thread pool with a priority queue. Every job is split into chunks, so a live game's next play can jump ahead of
// a half-finished backtest, and a job whose game state has already moved on can be cancelled between chunks.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as E from './engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRIORITY = { live: 0, fourth: 1, user: 2, backfill: 3, backtest: 4 };

export function createPool({ size, dataPath = path.join(HERE, 'data.json'), chunk = 2500 } = {}) {
  const n = Math.max(1, size || Math.min(4, Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 1)));
  const workers = [], idle = [], queue = [];
  let seq = 0, busyMs = 0, started = Date.now(), done = 0;
  const sent = new Map(); // worker -> Set of team keys it has
  for (let i = 0; i < n; i++) {
    const w = new Worker(path.join(HERE, 'worker.mjs'), { workerData: { dataPath } });
    w.unref(); sent.set(w, new Set());
    w.on('message', m => { const t = w._task; w._task = null; busyMs += Date.now() - t.t0; done++; t.cb(m); idle.push(w); pump(); });
    w.on('error', e => { console.error('sim worker error', e); const t = w._task; w._task = null; if (t) t.cb({ error: String(e) }); });
    workers.push(w); idle.push(w);
  }
  function pump() {
    while (idle.length && queue.length) {
      queue.sort((a, b) => a.pri - b.pri || a.seq - b.seq);
      const t = queue.shift();
      if (t.job.aborted) { t.cb({ aborted: true }); continue; }
      const w = idle.pop(); w._task = t; t.t0 = Date.now();
      const have = sent.get(w), msg = { id: t.seq, S: t.S, N: t.N, force: t.force, samp: t.samp, seed: t.seed, tk: t.tk };
      if (t.tk && !have.has(t.tk)) { msg.teams = t.teams; have.add(t.tk); if (have.size > 40) have.delete(have.values().next().value); }
      w.postMessage(msg);
    }
  }
  // run N sims from state S0. opts: {priority, force, teams, tk, signal}. Resolves to the merged aggregate, or null if aborted.
  function run(S0, N, opts = {}) {
    const job = { aborted: false };
    const pri = opts.priority ?? PRIORITY.user;
    const parts = Math.max(1, Math.ceil(N / chunk)), per = Math.ceil(N / parts);
    return new Promise((resolve, reject) => {
      let left = parts, acc = null, failed = false;
      const onAbort = () => { job.aborted = true; };
      if (opts.signal) { if (opts.signal.aborted) return resolve(null); opts.signal.addEventListener('abort', onAbort, { once: true }); }
      for (let i = 0; i < parts; i++) {
        queue.push({ job, pri, seq: seq++, S: S0, N: Math.min(per, N - i * per), force: opts.force || null, samp: i === 0, seed: null, tk: opts.tk || null, teams: opts.teams || null,
          cb: m => {
            if (failed) return;
            if (m.error) { failed = true; return reject(new Error(m.error)); }
            if (!m.aborted) acc = acc ? E.mergeAgg(acc, m.A) : m.A;
            if (--left === 0) { opts.signal?.removeEventListener('abort', onAbort); resolve(job.aborted ? null : acc); }
          } });
      }
      pump();
    });
  }
  const stats = () => ({ threads: n, queued: queue.length, running: n - idle.length, load: +(busyMs / Math.max(1, (Date.now() - started) * n)).toFixed(3), chunks: done });
  return { run, stats, size: n, queueLength: () => queue.length };
}
