// A stand-in for SearXNG in the browser tests (phase 4 step 9): `GET /search?q=...&format=json`
// answers two results per query. Their URLs are on `.invalid`, so the server's page fetcher fails
// at once and keeps the snippet (no network in tests). `GET /queries` lists the queries received;
// a query with `#down` answers 503 (the search source is unavailable). Run with `node`.
import { createServer } from 'node:http';

const port = Number(process.env['FAKE_SEARXNG_PORT'] ?? 4176);
const received: string[] = [];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(200).end('ok');
    return;
  }
  if (url.pathname === '/queries') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ queries: received }));
    return;
  }
  if (url.pathname !== '/search' || url.searchParams.get('format') !== 'json') {
    response.writeHead(404).end();
    return;
  }
  const q = url.searchParams.get('q') ?? '';
  received.push(q);
  if (q.includes('#down')) {
    response.writeHead(503).end();
    return;
  }
  const slug = encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'));
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      results: [1, 2].map((n) => ({
        title: `Fake result ${n} for ${q}`,
        url: `https://fake-search-${n}.invalid/${slug}`,
        content: `Fake snippet ${n}: ${q} explained in plain words.`,
      })),
    }),
  );
});

server.listen(port, () => console.log(`fake SearXNG on ${port}`));
