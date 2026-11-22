// Search sources of the server (phase 4 A6): admin config, options per mode, the Exa key kept.
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { SearchService } from '@kd-learn/search/port';
import { openServerDatabase } from '@kd-learn/storage/sqlite-node';
import { ADMIN, make } from '../auth/test-support.ts';
import { createHandlers, type Handlers } from '../index.ts';
import type { SearchAdapters } from './config.ts';

const EXA_KEY = 'exa-SECRET-key-0123456789';
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

/** Adapters that remember how they were built. */
const recording = () => {
  const built: string[] = [];
  const none: SearchService = { search: () => Effect.succeed([]) };
  const adapters: SearchAdapters = {
    searxng: (url) => (built.push(`searxng ${url}`), none),
    exa: (key) => (built.push(`exa ${key}`), none),
  };
  return { built, adapters };
};

const setup = async (env: Record<string, string> = { KD_SEARXNG_URL: 'http://searxng:8080/' }) => {
  const { adapters, built } = recording();
  const database = Effect.runSync(openServerDatabase({ path: ':memory:' }));
  const { handlers, logs } = make(env, { searchAdapters: adapters, database });
  const login = async (email: string, password: string, register = false) =>
    (
      (await (
        await call(
          register ? handlers.register : handlers.login,
          'POST',
          register ? '/api/auth/register' : '/api/auth/login',
          undefined,
          { email, password },
        )
      ).json()) as { token: string }
    ).token;
  const admin = await login(ADMIN.email, ADMIN.password);
  const user = await login('user@kd.test', 'password-123', true);
  const options = async (token?: string, mode = '') =>
    (
      (await (
        await call(handlers.searchOptions, 'GET', `/api/search/options${mode}`, token)
      ).json()) as { providers: string[] }
    ).providers;
  const put = (body: unknown, token = admin) =>
    call(handlers.admin, 'PUT', '/api/admin/search', token, body);
  return { handlers, logs, admin, user, options, put, built, database };
};

describe('server search sources', () => {
  it('starts with SearXNG for accounts and guests, nothing for demo', async () => {
    const t = await setup();
    expect(
      await (await call(t.handlers.admin, 'GET', '/api/admin/search', t.admin)).json(),
    ).toEqual({
      searxng: { configured: true, enabled: true },
      exa: { hasKey: false, enabled: true },
      guest: 'searxng',
      demo: 'off',
    });
    expect(await t.options(t.user)).toEqual(['searxng']);
    expect(await t.options()).toEqual(['searxng']);
    expect(await t.options(undefined, '?mode=demo')).toEqual([]);
    expect(t.built).toEqual(['searxng http://searxng:8080']);
  });

  it('seals the Exa key: never in a response, a log or the database in clear', async () => {
    const t = await setup();
    const response = await t.put({ exaKey: EXA_KEY, guest: 'off' });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(EXA_KEY);
    expect(JSON.parse(text)).toMatchObject({ exa: { hasKey: true, keyLast4: '6789' } });
    expect(JSON.stringify(t.logs)).not.toContain(EXA_KEY);
    const rows = t.database.db.prepare('SELECT key, value FROM server_config').all();
    expect(JSON.stringify(rows)).not.toContain(EXA_KEY);

    // Accounts get both; guests none (switched off); the adapter got the opened key.
    expect(await t.options(t.user)).toEqual(['searxng', 'exa']);
    expect(await t.options()).toEqual([]);
    expect(t.built).toContain(`exa ${EXA_KEY}`);

    expect((await t.put({ exaKey: null })).status).toBe(200);
    expect(await t.options(t.user)).toEqual(['searxng']);
  });

  it('gives demo only the source the admin picked, and only while it is enabled', async () => {
    const t = await setup();
    await t.put({ demo: 'searxng' });
    // Demo mode itself is off (no demo model): no source either.
    expect(await t.options(undefined, '?mode=demo')).toEqual([]);
    await t.put({ searxngEnabled: false });
    expect(await t.options(t.user)).toEqual([]);
    expect(await t.options()).toEqual([]);
  });

  it('is for admins only, refuses bad input and a bad token', async () => {
    const t = await setup();
    expect((await call(t.handlers.admin, 'GET', '/api/admin/search', t.user)).status).toBe(403);
    expect((await t.put({ exaKey: EXA_KEY }, t.user)).status).toBe(403);
    expect((await t.put({ guest: 'exa' })).status).toBe(400);
    expect((await t.put({ baseUrl: 'http://evil' })).status).toBe(400);
    expect(
      (await call(t.handlers.searchOptions, 'GET', '/api/search/options', 'nope')).status,
    ).toBe(401);
  });

  it('without SearXNG configured, offers nothing', async () => {
    const t = await setup({});
    expect(await t.options(t.user)).toEqual([]);
    expect(await t.options()).toEqual([]);
  });

  it('without accounts, guests use the configured SearXNG; a bad URL breaks the server', async () => {
    const { adapters } = recording();
    const guestOnly = createHandlers(
      { KD_SEARXNG_URL: 'http://searxng:8080' },
      { log: () => {}, searchAdapters: adapters },
    );
    const answer = await call(guestOnly.searchOptions, 'GET', '/api/search/options');
    expect(await answer.json()).toEqual({ providers: ['searxng'] });

    const broken = createHandlers({ KD_SEARXNG_URL: 'file:///etc/passwd' }, { log: () => {} });
    expect((await call(broken.searchOptions, 'GET', '/api/search/options')).status).toBe(500);
  });
});
