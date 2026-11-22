// Web research of accounts (phase 4 A5): a durable job, a source per account, attach to a lesson.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import type { SourceInfo } from '@kd-learn/core';
import type { SearchService } from '@kd-learn/search/port';
import { make } from '../auth/test-support.ts';
import type { Handlers } from '../index.ts';
import type { SearchAdapters } from '../search/config.ts';
import { failWith, say, scriptedAi, structured } from '../sessions/fake-ai.ts';

const KEY = 'sk-ant-research-SECRET-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'kd-research-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
type Json = Record<string, unknown>;

const call = (
  handler: Handlers[keyof Handlers],
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://kd.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await tick();
  }
  throw new Error('timed out waiting');
};

const searxng: SearchService = {
  search: (request) =>
    Effect.succeed([
      {
        title: `About ${request.query}`,
        url: `https://wiki.test/${encodeURIComponent(request.query)}`,
        snippet: 'snippet',
        content: 'Binary search needs a sorted array.',
      },
    ]),
};
const adapters: SearchAdapters = { searxng: () => searxng, exa: () => searxng };
const research = () => [structured({ queries: ['binary search'] }), say('Sorted first [R1].')];

const setup = async (
  programs: Parameters<typeof scriptedAi>[0],
  options: { dbPath?: string; register?: boolean } = {},
) => {
  const fake = scriptedAi(programs);
  const { handlers, logs } = make(
    { KD_SEARXNG_URL: 'http://searxng:8080' },
    {
      ai: fake.layer,
      searchAdapters: adapters,
      ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
    },
  );
  const signIn = async (email: string, register: boolean) =>
    (
      (await (
        await call(
          register ? handlers.register : handlers.login,
          'POST',
          register ? '/api/auth/register' : '/api/auth/login',
          undefined,
          { email, password: 'password-123' },
        )
      ).json()) as { token: string }
    ).token;
  const register = options.register ?? true;
  const token = await signIn('a@kd.test', register);
  const other = await signIn('b@kd.test', register);
  const account = (method: string, path: string, body?: unknown, as = token) =>
    call(handlers.account, method, `/api/account/${path}`, as, body);
  if (register) {
    const { id } = (await (
      await account('POST', 'connections', { label: 'A', provider: 'anthropic', apiKey: KEY })
    ).json()) as { id: string };
    // Only the teacher is set: research falls back to it.
    const role = { connectionId: id, model: 'claude-haiku-5-5' };
    await account('PUT', 'roles', { roles: { prober: role, teacher: role, sideChat: role } });
  }
  const list = async (as = token) =>
    ((await (await account('GET', 'sources', undefined, as)).json()) as { sources: SourceInfo[] })
      .sources;
  const start = (body: Json = {}, as = token) =>
    account(
      'POST',
      'research',
      { question: 'Binary search', language: 'en', provider: 'searxng', ...body },
      as,
    );
  return { handlers, logs, fake, token, other, account, list, start };
};

describe('account research', () => {
  it('stores a pending web source, and the job makes it ready on the teacher model', async () => {
    const t = await setup(research());
    const response = await t.start();
    expect(response.status).toBe(202);
    const { source } = (await response.json()) as { source: SourceInfo };
    // Pending when stored; the fake model may finish before the answer is built.
    expect(source).toMatchObject({ kind: 'web', title: 'Binary search' });
    await until(async () => (await t.list())[0]?.state === 'ready');
    const detail = (await (await t.account('GET', `sources/${source.sourceId}`)).json()) as {
      chunks: Array<{ text: string; locator: { url?: string } }>;
    };
    expect(detail.chunks[0]!.text).toBe('Sorted first [source: wiki.test].');
    expect(detail.chunks.some((c) => c.locator.url === 'https://wiki.test/binary%20search')).toBe(
      true,
    );
    expect(t.fake.requests[0]!.model).toMatchObject({ model: 'claude-haiku-5-5' });
    // Other accounts see nothing.
    expect(await t.list(t.other)).toEqual([]);
  });

  it('attaches the ready source to the lesson; another account lesson is 404', async () => {
    const t = await setup(research());
    const { sessionId } = (await (
      await t.account('POST', 'sessions', { topic: 'Binary search', language: 'en' })
    ).json()) as { sessionId: string };
    expect((await t.start({ sessionId }, t.other)).status).toBe(404);
    expect((await t.start({ sessionId })).status).toBe(202);
    const tags = async () =>
      (
        (await (await t.account('GET', `sessions/${sessionId}`)).json()) as {
          events: Array<{ event: { _tag: string; kind?: string } }>;
        }
      ).events.map((e) => e.event);
    await until(async () => (await tags()).some((e) => e._tag === 'SourceAttached'));
    expect((await tags()).find((e) => e._tag === 'SourceAttached')).toMatchObject({
      kind: 'web',
    });
  });

  it('refuses a search source the account may not use, and a bad body', async () => {
    const t = await setup([]);
    expect((await t.start({ provider: 'exa' })).status).toBe(403);
    expect((await t.start({ question: '' })).status).toBe(400);
    expect(await t.list()).toEqual([]);
  });

  it('fails the source without the key, then runs again on retry', async () => {
    const t = await setup([failWith(`provider said no to ${KEY}`), ...research()]);
    const { source } = (await (await t.start()).json()) as { source: SourceInfo };
    await until(async () => (await t.list())[0]?.state === 'failed');
    const failed = (await t.list())[0]!;
    expect(JSON.stringify(failed) + JSON.stringify(t.logs)).not.toContain(KEY);
    expect((await t.account('POST', `sources/${source.sourceId}/retry`)).status).toBe(202);
    await until(async () => (await t.list())[0]?.state === 'ready');
    expect(
      (await t.account('POST', `sources/${source.sourceId}/retry`, undefined, t.other)).status,
    ).toBe(404);
  });

  it('runs a research cut by a restart again, and it completes', async () => {
    const dbPath = join(dir, 'restart.db');
    // A model that never answers: the job is still running when the process "stops".
    const before = await setup([() => Stream.never], { dbPath });
    await before.start();
    await tick();
    expect((await before.list())[0]!.state).toBe('pending');

    const after = await setup(research(), { dbPath, register: false });
    await until(async () => (await after.list())[0]?.state === 'ready');
  });
});
