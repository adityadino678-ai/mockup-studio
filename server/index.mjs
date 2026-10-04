/**
 * Printify proxy.
 *
 * The browser cannot call Printify directly: api.printify.com sends no CORS
 * headers (its preflight answers 405) and Printify demands a User-Agent header,
 * which browsers refuse to let scripts set. A Personal Access Token in page
 * script would also be readable by the user and by any injected code.
 *
 * So this process holds the token and adds the required headers. It is
 * deliberately dependency-free: Node's own http server, fetch, and a hand-rolled
 * .env reader.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const API = 'https://api.printify.com/v1';
const PORT = Number(process.env.PORT ?? 8787);
const USER_AGENT = 'mockup-studio/1.0 (+local printify proxy)';

/* ------------------------------------------------------------------ config */

/** Minimal .env reader: KEY=value lines, # comments, optional quotes. */
async function loadEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  const text = await readFile(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadEnv();

let TOKEN = process.env.PRINTIFY_TOKEN ?? '';

/* -------------------------------------------------------------- utilities */

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

/** One place where Printify is actually called, so headers are never forgotten. */
async function printify(path, { method = 'GET', body } = {}) {
  if (!TOKEN) {
    throw new HttpError(503, {
      error: 'No Printify token. Put PRINTIFY_TOKEN=... in .env next to package.json, then restart the server.',
    });
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': USER_AGENT,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    throw new HttpError(res.status, data ?? { error: res.statusText });
  }
  return data;
}

function send(res, status, payload) {
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

async function readBody(req, limitBytes = 40 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new HttpError(413, { error: 'Payload too large' });
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, { error: 'Body was not valid JSON' });
  }
}

/**
 * Catalog data changes slowly and is rate limited to 100 requests a minute, so
 * it is cached. `bust=1` forces a refresh.
 */
const catalogCache = new Map();

async function cached(key, loader) {
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const value = await loader();
  catalogCache.set(key, { at: Date.now(), value });
  return value;
}

/** `/v1/shops.json` answers with a bare array, unlike most other endpoints. */
async function listShops() {
  const raw = await printify('/shops.json');
  return Array.isArray(raw) ? raw : (raw?.shops ?? []);
}

/* ------------------------------------------------------------------ routes */

const routes = [
  // Is the token valid, and which shops can we reach?
  [
    'GET',
    /^\/api\/health$/,
    async () => {
      if (!TOKEN) return { ok: false, configured: false };
      return { ok: true, configured: true, shops: await listShops() };
    },
  ],

  ['GET', /^\/api\/shops$/, async () => ({ shops: await listShops() })],

  ['GET', /^\/api\/blueprints$/, async () => cached('blueprints', () => printify('/catalog/blueprints.json'))],

  [
    'GET',
    /^\/api\/blueprints\/(\d+)$/,
    async (m) => printify(`/catalog/blueprints/${m[1]}.json`),
  ],

  [
    'GET',
    /^\/api\/blueprints\/(\d+)\/providers$/,
    async (m) =>
      cached(`providers:${m[1]}`, () =>
        printify(`/catalog/blueprints/${m[1]}/print_providers.json`),
      ),
  ],

  /**
   * Variants carry the colour names and the placeholder pixel sizes that the
   * whole placement maths depends on, so they are cached hard.
   */
  [
    'GET',
    /^\/api\/blueprints\/(\d+)\/providers\/(\d+)\/variants$/,
    async (m, url) =>
      cached(`variants:${m[1]}:${m[2]}`, () =>
        printify(
          `/catalog/blueprints/${m[1]}/print_providers/${m[2]}/variants.json${
            url.searchParams.get('all') === '1' ? '?show-out-of-stock=1' : ''
          }`,
        ),
      ),
  ],

  /** One image per call, as Printify requires. Base64 or a public URL. */
  [
    'POST',
    /^\/api\/uploads$/,
    async (_m, _url, body) => {
      if (!body.file_name) throw new HttpError(400, { error: 'file_name is required' });
      if (!body.contents && !body.url) {
        throw new HttpError(400, { error: 'Provide either contents (base64) or url' });
      }
      const payload = { file_name: body.file_name };
      if (body.contents) payload.contents = body.contents;
      else payload.url = body.url;
      return printify('/uploads/images.json', { method: 'POST', body: payload });
    },
  ],

  ['GET', /^\/api\/products$/, async (_m, url) => printify(`/shops/${url.searchParams.get('shop_id')}/products.json?limit=${url.searchParams.get('limit') ?? 50}`)],

  ['GET', /^\/api\/products\/([\w-]+)$/, async (m, url) => printify(`/shops/${url.searchParams.get('shop_id')}/products/${m[1]}.json`)],

  ['POST', /^\/api\/products$/, async (_m, _url, body) => printify(`/shops/${body.shop_id}/products.json`, { method: 'POST', body: body.payload })],

  [
    'POST',
    /^\/api\/products\/([\w-]+)\/publish$/,
    async (m, url, body) =>
      printify(`/shops/${url.searchParams.get('shop_id')}/products/${m[1]}/publish.json`, {
        method: 'POST',
        body: body.payload,
      }),
  ],

  /**
   * Printify's own mockup images, re-served from here. The browser only ever
   * displays these, never reads their pixels, but proxying keeps the third
   * party off the page and sidesteps any hotlink or CORS surprise.
   */
  [
    'GET',
    /^\/api\/image$/,
    async (_m, url) => {
      const target = url.searchParams.get('url') ?? '';
      if (!/^https:\/\/(images|pfy-[a-z0-9\-]+)\.[a-z0-9.\-]+\//i.test(target)) {
        throw new HttpError(400, { error: 'Only Printify image hosts are proxied' });
      }
      const upstream = await fetch(target);
      if (!upstream.ok) throw new HttpError(upstream.status, { error: 'Image fetch failed' });
      const buf = Buffer.from(await upstream.arrayBuffer());
      return { __raw: buf, __type: upstream.headers.get('content-type') ?? 'image/jpeg' };
    },
  ],
];

/* ------------------------------------------------------------------ server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // The Vite dev server runs on a different port, so this has to be open.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, {});

  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;
    try {
      const body = method === 'POST' ? await readBody(req) : {};
      const result = await handler(match, url, body);
      if (result && result.__raw) {
        res.writeHead(200, { 'Content-Type': result.__type, 'Cache-Control': 'public, max-age=86400' });
        return res.end(result.__raw);
      }
      return send(res, 200, result ?? {});
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const payload = err instanceof HttpError ? err.body : { error: err.message };
      if (status >= 500) console.error(`[proxy] ${req.method} ${url.pathname}`, err);
      return send(res, status, payload);
    }
  }
  send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`  Printify proxy on http://localhost:${PORT}`);
  console.log(TOKEN ? '  token loaded from .env' : '  NO TOKEN — add PRINTIFY_TOKEN to .env');
});