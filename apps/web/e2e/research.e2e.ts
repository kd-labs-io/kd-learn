// Web research (phase 4 step 9) against the production build, the fake model and the fake SearXNG
// (e2e/fake-openai.ts, e2e/fake-searxng.ts). Nothing is intercepted: the real route, the search
// adapter with its page fetcher, and the agent pipeline run; only the model and SearXNG are fakes.
import { expect, test } from '@playwright/test';
import { accountsPort, fakeSearchPort } from './accounts-env';

const base = `http://localhost:${accountsPort}`;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const frames = (text: string) =>
  text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)) as { _tag: string } & Record<string, unknown>);

test('a guest research returns a web source from the server SearXNG', async ({ request }, info) => {
  test.skip(info.project.name !== 'chromium', 'API only: one browser is enough.');
  const question = `Binary search ${unique()}`;
  const key = `e2e-research-${unique()}`;
  const options = await request.get(`${base}/api/search/options`);
  expect(await options.json()).toEqual({ providers: ['searxng'] });

  const response = await request.post(`${base}/api/research`, {
    headers: { 'x-forwarded-for': `10.77.${info.workerIndex % 250}.9` },
    data: {
      model: { provider: 'openai-compatible', endpointId: 'fake', model: 'fake', apiKey: key },
      question,
      language: 'en',
      provider: 'searxng',
    },
  });
  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(key);
  const [result, done] = frames(text);
  expect(done).toMatchObject({ _tag: 'done', outcome: 'completed' });
  expect(result).toMatchObject({ _tag: 'result', title: question });
  const chunks = result!.chunks as Array<{ text: string; locator: { url?: string } }>;
  expect(chunks[0]!.text).toContain('[source: fake-search-1.invalid]');
  expect(chunks.some((c) => c.text.includes('Fake snippet 1'))).toBe(true);

  // Both planned queries reached the fake SearXNG.
  const seen = (await (await fetch(`http://localhost:${fakeSearchPort}/queries`)).json()) as {
    queries: string[];
  };
  expect(seen.queries).toEqual(expect.arrayContaining([question, `${question} examples`]));
});
