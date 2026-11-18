// Grids web server: static files + the AI endpoint. Zero dependencies (Node >= 22).
//
//   GET  /                      -> public/index.html
//   GET  /shared/python/*.py    -> ../shared/python (the Python runtime Pyodide loads)
//   GET  /api/ai/status         -> key names + today's usage per key (never the keys)
//   POST /api/ai                -> {messages, sheet, key?, provider?} -> {reply, actions, model, key}
//   POST /api/ai/keys           -> {action: add|remove|select, ...}  edits the local .env
//                                  (only when running on this machine, see keyEditAllowed)
//
// Run: npm run dev   (keys live in ../.env, see shared/KEYS.md)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAssistant, allowCustomProvider, AiError } from './lib/ai.js';
import { KeyRing } from './lib/keyring.js';
import { KINDS, detect } from './lib/subscriptions.js';
import { localOnly, keyEditAllowed as keyEditAllowedFor } from './lib/local-guard.js';

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const SHARED_PY_DIR = fileURLToPath(new URL('../shared/python/', import.meta.url));
const MAX_BODY = 2 * 1024 * 1024;
// Subscriptions run the vendor CLI on this machine with the owner's account, so a
// server reachable by other people must not offer them (ALLOW_SUBSCRIPTIONS=1 overrides).
const ALLOW_SUBS = localOnly(process.env.ALLOW_SUBSCRIPTIONS, HOST);
const CAN_EDIT_KEYS = localOnly(process.env.ALLOW_KEY_EDIT, HOST);
const ring = new KeyRing(process.env, Date.now, { allowSubs: ALLOW_SUBS }); // one instance: usage survives a read-only FS
const keyEditAllowed = (req) => keyEditAllowedFor(req, { bindHost: HOST, flag: process.env.ALLOW_KEY_EDIT });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Pyodide (Python in the browser) loads its wasm + packages from jsDelivr and needs
// 'wasm-unsafe-eval'. Everything else is same-origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** Resolve a URL path inside root; null if it escapes (../ traversal). */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const p = normalize(join(root, decoded));
  return p.startsWith(root.endsWith(sep) ? root : root + sep) ? p : null;
}

async function serveFile(res, root, urlPath) {
  const file = safeJoin(root, urlPath);
  if (!file) return send(res, 400, { error: 'bad path' });
  try {
    const s = await stat(file);
    if (!s.isFile()) return send(res, 404, { error: 'not found' });
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AiError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new AiError(400, 'Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Small in-memory rate limit so a public deploy can't burn the AI key. Per process,
// which is fine for one server; a multi-instance deploy needs a shared store.
const hits = new Map();
function rateLimited(ip, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > limit;
}

async function handleAi(req, res) {
  if (rateLimited(req.socket.remoteAddress ?? '?')) return send(res, 429, { error: 'Too many AI requests, wait a minute.' });
  try {
    const body = await readJson(req);
    send(res, 200, await runAssistant(body, process.env, fetch, ring));
  } catch (e) {
    if (e instanceof AiError) return send(res, e.status, { error: e.message });
    console.error('AI request failed:', e.message);
    send(res, 500, { error: 'Internal error' });
  }
}

async function handleKeys(req, res) {
  if (!keyEditAllowed(req)) return send(res, 403, { error: 'Key editing is only available on a local Grids server (or set ALLOW_KEY_EDIT=1).' });
  try {
    const body = await readJson(req);
    if (body.action === 'add') ring.addKey(body);
    else if (body.action === 'add-sub') ring.addSubscription(body);
    else if (body.action === 'remove') ring.removeKey(String(body.name ?? ''));
    else if (body.action === 'select') ring.setSelection(String(body.name ?? ''));
    else return send(res, 400, { error: 'unknown action' });
    send(res, 200, { keys: ring.summary(), selection: ring.defaultSelection() });
  } catch (e) {
    send(res, e.status ?? 500, { error: e.status ? e.message : 'Could not update the key file.' });
    if (!e.status) console.error('key edit failed:', e.message);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/ai' && req.method === 'POST') return handleAi(req, res);
  if (path === '/api/ai/keys' && req.method === 'POST') return handleKeys(req, res);
  if (path === '/api/ai/status' && req.method === 'GET') {
    const keys = ring.summary();
    return send(res, 200, {
      configured: keys.length > 0,
      keys,
      selection: ring.defaultSelection(),
      allowCustom: allowCustomProvider(),
      allowSubscriptions: ALLOW_SUBS,
      subscriptionTypes: ALLOW_SUBS ? Object.entries(KINDS).map(([kind, k]) => ({ kind, label: k.label, installed: Boolean(detect(k.bin)), login: k.login })) : [],
      canEditKeys: CAN_EDIT_KEYS,
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  if (path.startsWith('/shared/python/')) return serveFile(res, SHARED_PY_DIR, path.slice('/shared/python/'.length));
  return serveFile(res, PUBLIC_DIR, path === '/' ? 'index.html' : path);
});

server.listen(PORT, HOST, () => {
  const keys = ring.summary();
  console.log(`Grids running at http://${HOST}:${PORT}`);
  console.log(keys.length
    ? `AI keys: ${keys.map((k) => `${k.name} (${k.model})`).join(', ')}; selection: ${ring.defaultSelection()}`
    : `AI: no keys yet. Add one in the AI panel's settings or in ${ring.path}`);
});
