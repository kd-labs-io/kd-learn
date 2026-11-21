import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import type { Handlers } from '../index.ts';
import { ADMIN, make } from '../auth/test-support.ts';
import { Effect, Stream } from 'effect';
import { AiPort } from '@kd-learn/ai/port';
import { gated, say, scriptedAi } from '../sessions/fake-ai.ts';
import { lazyAcpLayer, makeLazyAcp } from './router.ts';

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

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting');
};

const setup = async (
  acpPrograms: Parameters<typeof scriptedAi>[0],
  env: Record<string, string> = {
    KD_LEARN_ACP_AGENTS: 'claude-code',
    KD_LEARN_ACP_MODELS: '{"claude-code":["claude-haiku-5-5"]}',
  },
) => {
  const api = scriptedAi([]);
  const acp = scriptedAi(acpPrograms);
  const { handlers } = make(env, { ai: api.layer, acp: acp.layer });
  const login = async (email: string, password: string) =>
    (
      (await (
        await call(handlers.login, 'POST', '/api/auth/login', undefined, { email, password })
      ).json()) as {
        token: string;
      }
    ).token;
  const admin = await login(ADMIN.email, ADMIN.password);
  await call(handlers.register, 'POST', '/api/auth/register', undefined, {
    email: 'u@kd.test',
    password: 'password-123',
  });
  const user = await login('u@kd.test', 'password-123');
  const account = (method: string, path: string, body?: unknown) =>
    call(handlers.account, method, `/api/account/${path}`, user, body);
  const adminConfig = (change: unknown) =>
    call(handlers.admin, 'PUT', '/api/admin/config', admin, change);
  const useAgent = async () => {
    const created = await account('POST', 'connections', {
      label: 'CC',
      provider: 'acp',
      agent: 'claude-code',
    });
    const connection = (await created.json()) as Json & { id: string };
    const role = { connectionId: connection.id, model: 'claude-haiku-5-5' };
    await account('PUT', 'roles', { roles: { prober: role, teacher: role, sideChat: role } });
    return { created, connection };
  };
  const newSession = async () =>
    (
      (await (
        await account('POST', 'sessions', { topic: 'Fractions', language: 'en' })
      ).json()) as {
        sessionId: string;
      }
    ).sessionId;
  const snapshot = async (id: string) =>
    (await (await account('GET', `sessions/${id}`)).json()) as {
      events: Array<{ event: Json & { _tag: string } }>;
      running: unknown[];
    };
  const idle = (id: string) => until(async () => (await snapshot(id)).running.length === 0);
  return { handlers, api, acp, account, adminConfig, useAgent, newSession, snapshot, idle };
};

describe('ACP for accounts', () => {
  it('runs a turn through an enabled agent, with no key stored', async () => {
    const t = await setup([say('Hello from the agent.')]);
    const { created, connection } = await t.useAgent();
    expect(created.status).toBe(201);
    expect(connection).toMatchObject({ provider: 'acp', agent: 'claude-code', hasKey: false });
    const settings = (await (await t.account('GET', 'settings')).json()) as Json;
    expect(settings.acpAgents).toEqual(['claude-code']);

    const id = await t.newSession();
    expect((await t.account('POST', `sessions/${id}/turns`, { kind: 'auto' })).status).toBe(202);
    await t.idle(id);
    expect((await t.snapshot(id)).events.at(-1)?.event._tag).toBe('TurnCompleted');
    expect(t.acp.requests[0]?.model).toEqual({
      provider: 'acp',
      agent: 'claude-code',
      model: 'claude-haiku-5-5',
    });
    expect(t.api.requests).toHaveLength(0);
  });

  it('refuses an agent the admin has not enabled, or disabled later, before writing', async () => {
    const t = await setup([], {});
    const refused = await t.account('POST', 'connections', {
      label: 'CC',
      provider: 'acp',
      agent: 'claude-code',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'AcpAgentDisabled',
    );

    await t.adminConfig({
      acpAgents: ['claude-code'],
      acpModels: { 'claude-code': ['claude-haiku-5-5'] },
    });
    await t.useAgent();
    await t.adminConfig({ acpAgents: [] });
    const id = await t.newSession();
    const start = await t.account('POST', `sessions/${id}/turns`, { kind: 'auto' });
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: { code: string } }).error.code).toBe(
      'AcpAgentDisabled',
    );
    expect((await t.snapshot(id)).events.map((e) => e.event._tag)).toEqual(['SessionCreated']);
    expect(t.acp.requests).toHaveLength(0);
  });

  it('past the limit, a turn fails at once as retryable AcpBusy; a finished or cancelled turn frees its slot', async () => {
    const first = gated('Working', ' done.');
    const t = await setup(
      [first.program, say('Second.'), gated('Third', '').program, say('Fourth.')],
      {
        KD_LEARN_ACP_AGENTS: 'claude-code',
        KD_LEARN_ACP_MODELS: '{"claude-code":["claude-haiku-5-5"]}',
        KD_LEARN_ACP_MAX_CONCURRENT: '1',
      },
    );
    await t.useAgent();
    const [a, b] = [await t.newSession(), await t.newSession()];
    await t.account('POST', `sessions/${a}/turns`, { kind: 'auto' });
    await until(async () => t.acp.requests.length === 1);
    await t.account('POST', `sessions/${b}/turns`, { kind: 'auto' });
    await t.idle(b);
    const failed = (await t.snapshot(b)).events.at(-1)?.event;
    expect(failed).toMatchObject({ _tag: 'TurnFailed', code: 'AcpBusy', retryable: true });
    expect(t.acp.requests).toHaveLength(1);

    first.release();
    await t.idle(a);
    await t.account('POST', `sessions/${b}/turns`, { kind: 'retry' });
    await t.idle(b);
    expect((await t.snapshot(b)).events.at(-1)?.event._tag).toBe('TurnCompleted');

    // Cancel frees the slot too.
    const c = await t.newSession();
    const { turnId } = (await (
      await t.account('POST', `sessions/${c}/turns`, { kind: 'auto' })
    ).json()) as {
      turnId: string;
    };
    await until(async () => t.acp.requests.length === 3);
    await t.account('POST', `sessions/${c}/turns/${turnId}/cancel`);
    await t.idle(c);
    const d = await t.newSession();
    await t.account('POST', `sessions/${d}/turns`, { kind: 'auto' });
    await t.idle(d);
    expect((await t.snapshot(d)).events.at(-1)?.event._tag).toBe('TurnCompleted');
  });

  it('is not offered to guests', async () => {
    const t = await setup([]);
    const response = await call(t.handlers.turns, 'POST', '/api/turns', undefined, {
      model: { provider: 'acp', agent: 'claude-code' },
      turn: { kind: 'main' },
      log: [
        {
          _tag: 'SessionCreated',
          id: 'e1',
          at: 1,
          sessionId: 's1',
          topic: 'T',
          profile: defaultProfile,
        },
        { _tag: 'TurnStarted', id: 'e2', at: 2, turnId: 't1', input: '' },
      ],
    });
    expect(response.status).toBe(400);
  });

  it('rejects a bad agent list or limit in the environment', async () => {
    for (const env of [
      { KD_LEARN_ACP_AGENTS: 'cursor' },
      { KD_LEARN_ACP_MAX_CONCURRENT: '0' },
      { KD_LEARN_ACP_MODELS: '["claude-haiku-5-5"]' },
      { KD_LEARN_ACP_MODELS: '{"cursor":["x"]}' },
    ]) {
      const bad = make(env);
      expect(
        (await call(bad.handlers.login, 'POST', '/api/auth/login', undefined, {})).status,
      ).toBe(500);
    }
  });

  it('only lets a role pick a model on the admin list, checked again on every turn (risk 30)', async () => {
    const t = await setup([say('Hello.')]);
    const settings = (await (await t.account('GET', 'settings')).json()) as Json;
    expect(settings.acpModels).toEqual({ 'claude-code': ['claude-haiku-5-5'] });

    const created = (await (
      await t.account('POST', 'connections', { label: 'CC', provider: 'acp', agent: 'claude-code' })
    ).json()) as { id: string };
    const pricey = { connectionId: created.id, model: 'claude-opus-5-5' };
    const refused = await t.account('PUT', 'roles', { roles: { prober: pricey } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'AcpModelNotAllowed',
    );
    // Nothing was saved: the whole map is refused.
    expect(((await (await t.account('GET', 'settings')).json()) as Json).roles).toEqual({});

    await t.useAgent();
    await t.adminConfig({ acpModels: { 'claude-code': ['claude-sonnet-5-5'] } });
    const id = await t.newSession();
    const start = await t.account('POST', `sessions/${id}/turns`, { kind: 'auto' });
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: { code: string } }).error.code).toBe(
      'AcpModelNotAllowed',
    );
    expect((await t.snapshot(id)).events.map((e) => e.event._tag)).toEqual(['SessionCreated']);
    expect(t.acp.requests).toHaveLength(0);
  });

  it('tells the admin whether this build can load the ACP adapter', async () => {
    const loaded = makeLazyAcp(
      () => undefined,
      () => Promise.resolve({ layer: () => scriptedAi([]).layer }),
    );
    const missing = makeLazyAcp(
      () => undefined,
      () => Promise.reject(new Error('Cannot find package')),
    );
    expect(await loaded.available()).toBe(true);
    expect(await missing.available()).toBe(false);

    const t = await setup([]);
    const config = (await (await t.adminConfig({})).json()) as Json;
    expect(config).toMatchObject({
      acpAvailable: true,
      acpModels: { 'claude-code': ['claude-haiku-5-5'] },
    });
  });

  it('reports an adapter that cannot load without server paths, and logs the detail', async () => {
    const logs: unknown[] = [];
    const layer = lazyAcpLayer(
      (entry) => logs.push(entry),
      () =>
        Promise.reject(
          new Error("Cannot find package 'x' imported from /srv/app/.output/server/_ssr/acp.mjs"),
        ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const port = yield* AiPort;
        return yield* Stream.runCollect(
          port.runTurn({ model: { provider: 'acp', agent: 'claude-code' }, messages: [] }),
        );
      }).pipe(Effect.provide(layer)),
    );
    const shown = JSON.stringify(exit);
    expect(shown).toContain('AcpUnavailable');
    expect(shown).not.toContain('/srv/app');
    expect(JSON.stringify(logs)).toContain('/srv/app');
  });
});
