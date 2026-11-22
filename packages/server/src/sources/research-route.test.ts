// `POST /api/research` (phase 4 A5, A9): guest and demo research over fake model and search.
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeSseParser } from '@kd-learn/api';
import { SearchError, type SearchRequest, type SearchService } from '@kd-learn/search/port';
import { ADMIN, make } from '../auth/test-support.ts';
import { makeRateLimiter } from '../auth/rate-limit.ts';
import { createHandlers, type Handlers } from '../index.ts';
import type { SearchAdapters } from '../search/config.ts';
import { scriptedAi, say, structured } from '../sessions/fake-ai.ts';

const GUEST_KEY = 'sk-ant-guest-SECRET-0123456789';
const DEMO_KEY = 'sk-ant-demo-SERVER-KEY-0123456789';
const EXA_KEY = 'exa-SECRET-key-0123456789';
const demoEnv = (budget: number) => ({
  KD_SEARXNG_URL: 'http://searxng:8080',
  KD_LEARN_DEMO_MODE: 'on',
  KD_LEARN_DEMO_PROVIDER: 'anthropic',
  KD_LEARN_DEMO_MODEL: 'claude-haiku-5-5',
  KD_LEARN_DEMO_API_KEY: DEMO_KEY,
  KD_LEARN_DEMO_BUDGET: String(budget),
});

const fakeSearch = () => {
  const calls: Array<{ source: string; request: SearchRequest }> = [];
  const service = (source: string, fail?: string): SearchService => ({
    search: (request) => {
      calls.push({ source, request });
      return fail === undefined
        ? Effect.succeed([
            {
              title: `About ${request.query}`,
              url: `https://${source}.test/${encodeURIComponent(request.query)}`,
              snippet: 'snippet',
              content: `Text found by ${source}.`,
            },
          ])
        : Effect.fail(new SearchError({ reason: 'Unauthorized', message: fail }));
    },
  });
  const adapters: SearchAdapters = {
    searxng: () => service('searxng'),
    exa: () => service('exa'),
  };
  return { adapters, calls };
};

const post = (handlers: Handlers, body: unknown, address = '203.0.113.7') =>
  handlers.research(
    new Request('http://kd.test/api/research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { clientAddress: address },
  );

const frames = async (response: Response) => {
  const parser = makeSseParser();
  const text = await response.text();
  return {
    text,
    frames: parser.push(text).map((m) => JSON.parse(m.data) as Record<string, unknown>),
  };
};

const guest = (provider = 'searxng') => ({
  model: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: GUEST_KEY },
  question: 'Binary search',
  language: 'en',
  provider,
});
const demo = (provider = 'searxng') => ({
  model: { provider: 'demo' },
  question: 'Binary search',
  language: 'en',
  provider,
});

const setup = async (
  programs: Parameters<typeof scriptedAi>[0],
  env: Record<string, string> = { KD_SEARXNG_URL: 'http://searxng:8080' },
  limit = 100,
) => {
  const fake = scriptedAi(programs);
  const search = fakeSearch();
  const { handlers, logs } = make(env, {
    ai: fake.layer,
    searchAdapters: search.adapters,
    researchLimit: makeRateLimiter({ limit, windowMs: 60_000 }),
  });
  const admin = (
    (await (
      await handlers.login(
        new Request('http://kd.test/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ADMIN),
        }),
      )
    ).json()) as { token: string }
  ).token;
  const configure = (body: unknown) =>
    handlers.admin(
      new Request('http://kd.test/api/admin/search', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
        body: JSON.stringify(body),
      }),
    );
  const budget = async () =>
    (
      (await (
        await handlers.admin(
          new Request('http://kd.test/api/admin/config', {
            headers: { authorization: `Bearer ${admin}` },
          }),
        )
      ).json()) as { demoBudget: { used: number } }
    ).demoBudget.used;
  return { handlers, logs, fake, search, configure, budget };
};

const twoCalls = () => [structured({ queries: ['binary search', 'bisection'] }), say('Sum [R1].')];

describe('guest research', () => {
  it('streams a web source built from the server SearXNG, without the key', async () => {
    const t = await setup(twoCalls());
    const response = await post(t.handlers, guest());
    expect(response.status).toBe(200);
    const { frames: out, text } = await frames(response);
    expect(out.map((f) => f._tag)).toEqual(['result', 'done']);
    expect(out[0]).toMatchObject({
      title: 'Binary search',
      queries: ['binary search', 'bisection'],
    });
    const chunks = out[0]!.chunks as Array<{ text: string; locator: { url?: string } }>;
    expect(chunks[0]!.text).toBe('Sum [source: searxng.test].');
    expect(chunks.some((c) => c.locator.url?.startsWith('https://searxng.test/'))).toBe(true);
    expect(t.search.calls.map((c) => c.source)).toEqual(['searxng', 'searxng']);
    expect(text + JSON.stringify(t.logs)).not.toContain(GUEST_KEY);
  });

  it('refuses Exa, a source the admin turned off, and guest mode off; before any call', async () => {
    const t = await setup([]);
    await t.configure({ exaKey: EXA_KEY });
    expect((await post(t.handlers, guest('exa'))).status).toBe(403);
    await t.configure({ guest: 'off' });
    expect((await post(t.handlers, guest())).status).toBe(403);
    expect(t.fake.requests).toHaveLength(0);
    expect(t.search.calls).toHaveLength(0);
  });

  it('limits researches per address', async () => {
    const t = await setup([...twoCalls(), ...twoCalls()], undefined, 1);
    expect((await post(t.handlers, guest())).status).toBe(200);
    expect((await post(t.handlers, guest())).status).toBe(429);
    expect((await post(t.handlers, guest(), '198.51.100.1')).status).toBe(200);
  });

  it('streams an error frame when every search fails, with fixed text only', async () => {
    const fake = scriptedAi([structured({ queries: ['q'] })]);
    const failing: SearchAdapters = {
      searxng: () => ({
        search: () =>
          Effect.fail(new SearchError({ reason: 'Unavailable', message: 'Search is down.' })),
      }),
      exa: () => ({ search: () => Effect.succeed([]) }),
    };
    const { handlers } = make(
      { KD_SEARXNG_URL: 'http://searxng:8080' },
      {
        ai: fake.layer,
        searchAdapters: failing,
      },
    );
    const { frames: out } = await frames(await post(handlers, guest()));
    expect(out[0]).toMatchObject({ _tag: 'error', error: { code: 'SearchUnavailable' } });
    expect(out[1]).toMatchObject({ _tag: 'done', outcome: 'failed' });
  });

  it('works without accounts, on the env SearXNG', async () => {
    const fake = scriptedAi(twoCalls());
    const search = fakeSearch();
    const handlers = createHandlers(
      { KD_SEARXNG_URL: 'http://searxng:8080' },
      { log: () => {}, ai: fake.layer, searchAdapters: search.adapters },
    );
    const { frames: out } = await frames(await post(handlers, guest()));
    expect(out[0]!._tag).toBe('result');
  });
});

describe('demo research', () => {
  it('runs on the source the admin picked, charges calls and searches, keeps both keys out', async () => {
    const t = await setup(twoCalls(), demoEnv(10));
    await t.configure({ exaKey: EXA_KEY, demo: 'exa' });
    expect((await post(t.handlers, demo('searxng'))).status).toBe(403);
    const response = await post(t.handlers, demo('exa'));
    const { frames: out, text } = await frames(response);
    expect(out[0]!._tag).toBe('result');
    expect(t.search.calls.map((c) => c.source)).toEqual(['exa', 'exa']);
    // Two model calls and two searches.
    expect(await t.budget()).toBe(4);
    // The server's prompts, whatever the client sends.
    expect(t.fake.requests[0]!.system).toContain('You plan a short web search');
    for (const secret of [DEMO_KEY, EXA_KEY]) {
      expect(text + JSON.stringify(t.logs)).not.toContain(secret);
    }
  });

  it('refuses before any call when the budget cannot cover a whole research', async () => {
    const t = await setup([], demoEnv(4));
    await t.configure({ demo: 'searxng' });
    const response = await post(t.handlers, demo());
    expect(response.status).toBe(429);
    expect(t.fake.requests).toHaveLength(0);
    expect(t.search.calls).toHaveLength(0);
    expect(await t.budget()).toBe(0);
  });

  it('is closed when the admin picked no demo source', async () => {
    const t = await setup([], demoEnv(10));
    expect((await post(t.handlers, demo())).status).toBe(403);
    expect(t.search.calls).toHaveLength(0);
  });
});
