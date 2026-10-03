// Render web service: serves /public and runs the ESPN proxy at /api/espn. No dependencies, Node 20+.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import espn from './api/espn.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = process.env.PORT || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
// Clean URLs: /game/401858250 and /game?event=401858250 both open the simulator
const PAGES = { '/': 'index.html', '/game': 'game.html' };

// Static files are read and compressed once, then served from memory. The sim page is ~1 MB raw, ~150 KB gzipped.
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

async function serveApi(req, res, u) {
  const r = await espn(new Request(u.href));
  const body = Buffer.from(await r.arrayBuffer());
  const headers = Object.fromEntries(r.headers);
  const ae = String(req.headers['accept-encoding'] || '');
  if (body.length > 1024 && /\bgzip\b/.test(ae)) {
    headers['content-encoding'] = 'gzip'; headers.vary = 'Accept-Encoding';
    res.writeHead(r.status, headers); res.end(zlib.gzipSync(body)); return;
  }
  res.writeHead(r.status, headers); res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    if (u.pathname === '/api/espn' || u.pathname === '/.netlify/functions/espn') return await serveApi(req, res, u);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

    let rel = PAGES[u.pathname.replace(/\/+$/, '') || '/'];
    if (!rel && /^\/game\/\d+\/?$/.test(u.pathname)) rel = 'game.html';
    if (!rel) rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
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

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
