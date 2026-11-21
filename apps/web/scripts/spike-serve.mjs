// SPIKE (phase 1 step 1): serves a build of apps/web with optional COOP/COEP headers.
//   node scripts/spike-serve.mjs spa <port> [--isolate]            serves dist/client
//   node scripts/spike-serve.mjs ssr <port> <upstream> [--isolate]  proxies a running `pnpm start`
// Extra paths for the sandboxed iframe test: /__frame/plain (no COEP), /__frame/coep (COEP).
import { createServer, request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, portArg, ...rest] = process.argv.slice(2);
const isolate = rest.includes('--isolate');
const upstream = rest.find((a) => a.startsWith('http'));
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist', 'client');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const isolation = isolate
  ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
  : {};

const frameBody =
  '<!doctype html><title>frame</title><script>parent.postMessage("frame-ran","*")</script>';

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__img.gif') {
    // 1x1 gif without CORP: a stand-in for a third-party image in generated HTML.
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    return;
  }
  if (url.pathname.startsWith('/__frame/')) {
    const coep = url.pathname.endsWith('/coep');
    res.writeHead(200, {
      'content-type': 'text/html',
      ...(coep ? { 'Cross-Origin-Embedder-Policy': 'require-corp' } : {}),
    });
    res.end(frameBody);
    return;
  }
  if (mode === 'ssr') {
    const up = new URL(upstream);
    const proxied = request(
      { host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, ...isolation });
        upRes.pipe(res);
      },
    );
    proxied.on('error', (e) => res.writeHead(502).end(String(e)));
    req.pipe(proxied);
    return;
  }
  let file = normalize(join(root, url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    // SPA fallback: client router handles unknown paths.
    if (!extname(file)) file = join(root, 'index.html');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      ...isolation,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(Number(portArg), () =>
  console.log(`${mode} ${isolate ? 'isolated' : 'plain'} on ${portArg}`),
);
