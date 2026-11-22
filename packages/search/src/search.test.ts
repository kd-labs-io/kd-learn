import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { Effect, Exit } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeExa } from './exa/index.ts';
import { FetchPageError, fetchPage, htmlToText, isPublicAddress } from './fetch/index.ts';
import { makeSearxng } from './searxng/index.ts';

let server: http.Server;
let base = '';
const loopback = { isAllowedAddress: (address: string) => address === '127.0.0.1' };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const port = (server.address() as AddressInfo).port;
    switch (url.pathname) {
      case '/page':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<html><head><title>Tìm kiếm &amp; sắp xếp</title><style>x{}</style></head><body>' +
            '<nav>Menu</nav><p>Tìm kiếm nhị phân cần mảng đã sắp xếp.</p><script>alert(1)</script>' +
            '<p>Mỗi bước chia đôi&nbsp;khoảng.</p></body></html>',
        );
        return;
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(gzipSync(Buffer.from('compressed text')));
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(5000));
        return;
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('png');
        return;
      case '/to-private':
        res.writeHead(302, { location: `http://[::1]:${port}/page` });
        res.end();
        return;
      case '/to-localhost':
        res.writeHead(302, { location: `http://localhost:${port}/page` });
        res.end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      case '/hop':
        res.writeHead(301, { location: '/page' });
        res.end();
        return;
      case '/slow':
        setTimeout(() => res.end('late'), 2000);
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof FetchPageError ? error.reason : String(error);
  }
};

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['::', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', true],
    ['64:ff9b::a9fe:a9fe', false],
    ['2606:4700:4700::1111', true],
    ['not an ip', false],
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe('fetchPage', () => {
  it('refuses a private address by default', async () => {
    expect(await reason(fetchPage(`${base}/page`))).toBe('BlockedAddress');
  });

  it('turns HTML into text, without scripts, styles or entities', async () => {
    const page = await fetchPage(`${base}/hop`, loopback);
    expect(page.title).toBe('Tìm kiếm & sắp xếp');
    expect(page.text).toBe(
      'Menu\n\nTìm kiếm nhị phân cần mảng đã sắp xếp.\n\nMỗi bước chia đôi khoảng.',
    );
    expect(page.url).toBe(`${base}/page`);
  });

  it('decompresses, and caps size, type and time', async () => {
    expect((await fetchPage(`${base}/gzip`, loopback)).text).toBe('compressed text');
    expect(await reason(fetchPage(`${base}/big`, { ...loopback, maxBytes: 1000 }))).toBe(
      'TooLarge',
    );
    expect(await reason(fetchPage(`${base}/image`, loopback))).toBe('NotText');
    expect(await reason(fetchPage(`${base}/slow`, { ...loopback, timeoutMs: 200 }))).toBe(
      'Timeout',
    );
  });

  it('checks every redirect: to a private address, to a name that resolves to one, in a loop', async () => {
    expect(await reason(fetchPage(`${base}/to-private`, loopback))).toBe('BlockedAddress');
    expect(await reason(fetchPage(`${base}/to-localhost`, loopback))).toBe('BlockedAddress');
    expect(await reason(fetchPage(`${base}/loop`, loopback))).toBe('TooManyRedirects');
  });

  it('refuses other schemes and credentials', async () => {
    expect(await reason(fetchPage('file:///etc/passwd', loopback))).toBe('BadUrl');
    expect(await reason(fetchPage('http://u:p@127.0.0.1/', loopback))).toBe('BadUrl');
    expect(await reason(fetchPage('not a url'))).toBe('BadUrl');
  });

  it('htmlToText keeps paragraphs', () => {
    expect(htmlToText('<div>a</div><div>b<br>c</div>')).toBe('a\n\nb\n\nc');
  });
});

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('SearXNG adapter', () => {
  const searxResults = {
    results: [
      { title: 'Page', url: `PAGE`, content: 'Short.', engines: ['ddg'] },
      { title: 'Dup', url: `PAGE`, content: 'Again.' },
      { title: 'Ftp', url: 'ftp://x', content: 'No.' },
      { title: 'Missing', url: `MISSING`, content: 'Snippet kept.' },
    ],
    unresponsive_engines: [],
  };
  const withUrls = () =>
    JSON.parse(
      JSON.stringify(searxResults)
        .replaceAll('PAGE', `${base}/page`)
        .replaceAll('MISSING', `${base}/missing`),
    );

  it('maps results, drops duplicates and non-http, fetches pages for content', async () => {
    const seen: string[] = [];
    const searx = makeSearxng({
      baseUrl: 'http://searxng:8080/',
      fetch: (async (url: URL) => {
        seen.push(String(url));
        return jsonResponse(200, withUrls());
      }) as typeof fetch,
      fetchOptions: loopback,
    });
    const results = await Effect.runPromise(
      searx.search({ query: 'tìm kiếm', limit: 5, language: 'vi' }),
    );
    expect(seen[0]).toBe(
      'http://searxng:8080/search?q=t%C3%ACm+ki%E1%BA%BFm&format=json&language=vi',
    );
    expect(results.map((r) => r.title)).toEqual(['Page', 'Missing']);
    expect(results[0]!.content).toContain('Tìm kiếm nhị phân');
    expect(results[1]).toEqual({
      title: 'Missing',
      url: `${base}/missing`,
      snippet: 'Snippet kept.',
    });
  });

  it('reports a source that answered nothing as Unavailable, a disabled JSON format too', async () => {
    const empty = makeSearxng({
      baseUrl: 'http://s',
      fetch: (async () =>
        jsonResponse(200, {
          results: [],
          unresponsive_engines: [['ddg', 'CAPTCHA']],
        })) as unknown as typeof fetch,
    });
    const exit = await Effect.runPromiseExit(empty.search({ query: 'q', limit: 3 }));
    expect(JSON.stringify(exit)).toContain('Unavailable');
    const forbidden = makeSearxng({
      baseUrl: 'http://s',
      fetch: (async () => new Response('no', { status: 403 })) as unknown as typeof fetch,
    });
    const refused = await Effect.runPromiseExit(forbidden.search({ query: 'q', limit: 3 }));
    expect(Exit.isFailure(refused)).toBe(true);
    expect(JSON.stringify(refused)).toContain('json format');
  });
});

describe('Exa adapter', () => {
  const KEY = 'exa-SECRET-key-0123456789';

  it('sends the key as a bearer token and maps highlights', async () => {
    let sent: RequestInit | undefined;
    const exa = makeExa({
      apiKey: KEY,
      fetch: (async (_url: string, init: RequestInit) => {
        sent = init;
        return jsonResponse(200, {
          results: [
            {
              title: 'A',
              url: 'https://a.test',
              publishedDate: '2026-01-01',
              highlights: ['First.', 'Second.'],
            },
            { title: '', url: 'javascript:alert(1)', highlights: ['x'] },
          ],
          costDollars: { total: 0.007 },
        });
      }) as unknown as typeof fetch,
    });
    const results = await Effect.runPromise(exa.search({ query: 'q', limit: 3 }));
    expect((sent?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(sent?.body))).toMatchObject({
      query: 'q',
      type: 'auto',
      numResults: 3,
      contents: { highlights: true },
    });
    expect(results).toEqual([
      {
        title: 'A',
        url: 'https://a.test',
        snippet: 'First.',
        content: 'First.\n\nSecond.',
        publishedAt: '2026-01-01',
      },
    ]);
  });

  it.each([
    [401, 'Unauthorized'],
    [402, 'PaymentRequired'],
    [429, 'RateLimited'],
    [400, 'Invalid'],
    [503, 'Unavailable'],
  ])('maps HTTP %s to %s without the key or the body', async (status, expected) => {
    const exa = makeExa({
      apiKey: KEY,
      fetch: (async () =>
        jsonResponse(
          status,
          { error: `bad key ${KEY}`, tag: 'X' },
          { 'retry-after': '7' },
        )) as unknown as typeof fetch,
    });
    const exit = await Effect.runPromiseExit(exa.search({ query: 'q', limit: 3 }));
    const text = JSON.stringify(exit);
    expect(text).toContain(expected);
    expect(text).not.toContain(KEY);
    if (status === 429) expect(text).toContain('"retryAfterSeconds":7');
  });
});
