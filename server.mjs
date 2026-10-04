// Render web service: static pages, the ESPN proxy, and the shared server-side simulator. No dependencies, Node 20+.
//   /api/espn                 ESPN proxy (memoized)
//   /api/live?event=ID        event stream for one game: a snapshot on connect, then updates as the server simulates
//   /api/live/snapshot?event  the same data as one JSON response (fallback when event streams are blocked)
//   /api/sim/run, /whatif     one-off runs from the manual entry and what-if panels (POST, rate limited, cached)
//   /api/sim/backtest         finished games, simulated once and kept
//   /api/ledger               the running record of every flagged bet; /api/trading the rule behind the flags
//   /api/status               what the server is doing right now
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import espn, { setModelHook } from './api/espn.mjs';
import { createPool } from './sim/pool.mjs';
import { createLive } from './sim/live.mjs';
import { createTrading } from './sim/trading.mjs';
import * as espnApi from './api/espn.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'public');
const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(HERE, 'sim', 'data.json');
const DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const pool = createPool({ size: +process.env.SIM_THREADS || 0, dataPath: DATA_PATH });
// The bet ledger has to outlive restarts. On Render, point LEDGER_PATH at a persistent disk (see render.yaml).
const trading = createTrading({ rulesFile: path.join(HERE, 'sim', 'trading.json'), ledgerFile: process.env.LEDGER_PATH || path.join(HERE, 'data', 'ledger.json'), espn: espnApi });
const live = createLive({ pool, data: DATA, trading });
setModelHook(id => live.modelFor(id));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const PAGES = { '/': 'index.html', '/game': 'game.html' };

const fileCache = new Map();
async function loadStatic(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) return null;
  let raw;
  try { raw = await readFile(full); } catch { return null; }
  const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const compressible = /text|json|svg|javascript/.test(type) && raw.length > 1024;
  const entry = {
    raw, type,
    br: compressible ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : null,
    gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null,
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"',
  };
  if (process.env.NODE_ENV !== 'development') fileCache.set(rel, entry);
  return entry;
}
function pickEncoding(req, entry) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (entry.br && /\bbr\b/.test(ae)) return ['br', entry.br];
  if (entry.gz && /\bgzip\b/.test(ae)) return ['gzip', entry.gz];
  return [null, entry.raw];
}
function sendJson(req, res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra };
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    headers['content-encoding'] = 'gzip'; headers.vary = 'Accept-Encoding'; res.writeHead(status, headers); res.end(zlib.gzipSync(body)); return;
  }
  res.writeHead(status, headers); res.end(body);
}
async function serveApi(req, res, u) {
  const r = await espn(new Request(u.href));
  const body = Buffer.from(await r.arrayBuffer());
  const headers = Object.fromEntries(r.headers);
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    headers['content-encoding'] = 'gzip'; headers.vary = 'Accept-Encoding';
    res.writeHead(r.status, headers); res.end(zlib.gzipSync(body)); return;
  }
  res.writeHead(r.status, headers); res.end(body);
}
// Event stream: one per open game page. The game object counts these to decide whether anyone is watching.
function serveLive(req, res, u) {
  const g = live.get(u.searchParams.get('event') || '');
  if (!g) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('missing event'); return; }
  const headers = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' };
  let out = res;
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    headers['content-encoding'] = 'gzip'; headers.vary = 'Accept-Encoding';
    out = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH }); out.pipe(res);
  }
  res.writeHead(200, headers);
  const client = { write: m => out.write(m) };
  client.write(`retry: 4000\nevent: snapshot\ndata: ${JSON.stringify(g.snapshot())}\n\n`);
  g.watch(client);
  const ping = setInterval(() => client.write(`: ping ${Date.now()}\n\n`), 20000);
  const done = () => { clearInterval(ping); g.unwatch(client); if (out !== res) out.end(); };
  req.on('close', done); res.on('error', done);
}
async function readBody(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > 32768) throw new Error('body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('bad JSON'); }
}
// Custom runs cost real CPU, so each visitor gets a small budget
const buckets = new Map();
function allow(req, cost = 1) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), b = buckets.get(ip) || { t: now, tokens: 20 };
  b.tokens = Math.min(20, b.tokens + (now - b.t) / 3000); b.t = now;
  if (b.tokens < cost) { buckets.set(ip, b); return false; }
  b.tokens -= cost; buckets.set(ip, b);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.t > 600000) buckets.delete(k);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    if (p === '/api/espn') return await serveApi(req, res, u);
    if (p === '/api/live') return serveLive(req, res, u);
    if (p === '/api/live/snapshot') {
      const g = live.get(u.searchParams.get('event') || ''); if (!g) return sendJson(req, res, 400, { error: 'missing event' });
      g.touch(); if (!g.info && g.ready) await g.ready.catch(() => {});
      return sendJson(req, res, 200, g.snapshot());
    }
    if (p === '/api/status') return sendJson(req, res, 200, live.stats());
    if (p === '/api/ledger') return sendJson(req, res, 200, trading.summary());
    if (p === '/api/trading') return sendJson(req, res, 200, trading.rules());
    if (p === '/api/sim/backtest') {
      const ev = (u.searchParams.get('event') || '').replace(/\D/g, ''); if (!ev) return sendJson(req, res, 400, { error: 'missing event' });
      return sendJson(req, res, 200, live.backtest(ev, u.searchParams.get('every'), u.searchParams.get('n')));
    }
    if (p === '/api/sim/run' || p === '/api/sim/whatif') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (!allow(req)) return sendJson(req, res, 429, { error: 'Too many custom runs. Try again in a few seconds.' });
      const b = await readBody(req);
      try {
        const out = p === '/api/sim/run' ? await live.custom(b) : await live.whatIf(b);
        return sendJson(req, res, 200, out);
      } catch (e) { return sendJson(req, res, 400, { error: String(e.message || e) }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

    let rel = PAGES[p.replace(/\/+$/, '') || '/'];
    if (!rel && /^\/game\/\d+\/?$/.test(p)) rel = 'game.html';
    if (!rel) rel = decodeURIComponent(p).replace(/^\/+/, '');
    const entry = await loadStatic(path.normalize(rel));
    if (!entry) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    const headers = {
      'content-type': entry.type, etag: entry.etag, vary: 'Accept-Encoding',
      'cache-control': entry.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return; }
    const [enc, body] = pickEncoding(req, entry);
    if (enc) headers['content-encoding'] = enc;
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Server error');
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT} with ${pool.size} sim thread${pool.size > 1 ? 's' : ''}`));
