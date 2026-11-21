import { describe, expect, it } from 'vitest';
import type { Handlers } from '../index.ts';
import { make } from '../auth/test-support.ts';

const KEY = 'sk-ant-account-SECRET-0123456789';

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

const signUp = async (handlers: Handlers, email: string) => {
  const response = await call(handlers.register, 'POST', '/api/auth/register', undefined, {
    email,
    password: 'password-123',
  });
  return ((await response.json()) as { token: string }).token;
};

describe('account settings routes', () => {
  it('stores a connection, maps roles, and never returns the key', async () => {
    const { handlers, logs } = make({
      KD_OPENAI_COMPATIBLE_ENDPOINTS: JSON.stringify([
        { id: 'acme', baseURL: 'https://llm.acme.test/v1' },
      ]),
    });
    const token = await signUp(handlers, 'a@kd.test');

    const created = await call(handlers.account, 'POST', '/api/account/connections', token, {
      label: 'My Anthropic',
      provider: 'anthropic',
      apiKey: KEY,
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(KEY);
    const connection = JSON.parse(createdText) as { id: string; hasKey: boolean; keyLast4: string };
    expect(connection).toMatchObject({ hasKey: true, keyLast4: '6789' });

    const roles = await call(handlers.account, 'PUT', '/api/account/roles', token, {
      roles: {
        prober: { connectionId: connection.id, model: 'claude-haiku-5-5' },
        teacher: { connectionId: connection.id, model: 'claude-sonnet-5-5' },
      },
    });
    expect(roles.status).toBe(200);

    const settings = await call(handlers.account, 'GET', '/api/account/settings', token);
    const text = await settings.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({
      connections: [{ id: connection.id, label: 'My Anthropic', provider: 'anthropic' }],
      roles: { teacher: { connectionId: connection.id, model: 'claude-sonnet-5-5' } },
    });
    expect(JSON.stringify(logs)).not.toContain(KEY);

    const unknownEndpoint = await call(
      handlers.account,
      'POST',
      '/api/account/connections',
      token,
      {
        label: 'x',
        provider: 'openai-compatible',
        endpointId: 'nope',
        apiKey: KEY,
      },
    );
    expect(unknownEndpoint.status).toBe(400);
    expect(await unknownEndpoint.text()).not.toContain(KEY);
  });

  it('rejects a free base URL and a key in an error message', async () => {
    const { handlers } = make();
    const token = await signUp(handlers, 'a@kd.test');
    const response = await call(handlers.account, 'POST', '/api/account/connections', token, {
      label: 'x',
      provider: 'openai-compatible',
      endpointId: 'acme',
      baseURL: 'http://169.254.169.254',
      apiKey: KEY,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(KEY);
  });

  it("keeps users apart: another user's connection is not found", async () => {
    const { handlers } = make();
    const alice = await signUp(handlers, 'alice@kd.test');
    const bob = await signUp(handlers, 'bob@kd.test');
    const { id } = (await (
      await call(handlers.account, 'POST', '/api/account/connections', alice, {
        label: 'A',
        provider: 'gemini',
        apiKey: KEY,
      })
    ).json()) as { id: string };

    const steal = await call(handlers.account, 'PUT', '/api/account/roles', bob, {
      roles: { teacher: { connectionId: id, model: 'gemini-3-flash' } },
    });
    expect(steal.status).toBe(404);
    expect(
      (await call(handlers.account, 'DELETE', `/api/account/connections/${id}`, bob)).status,
    ).toBe(404);
    const bobSettings = (await (
      await call(handlers.account, 'GET', '/api/account/settings', bob)
    ).json()) as {
      connections: unknown[];
    };
    expect(bobSettings.connections).toEqual([]);

    expect(
      (await call(handlers.account, 'DELETE', `/api/account/connections/${id}`, alice)).status,
    ).toBe(204);
  });

  it('requires a token, and answers unknown paths with 404', async () => {
    const { handlers } = make();
    expect((await call(handlers.account, 'GET', '/api/account/settings')).status).toBe(401);
    const token = await signUp(handlers, 'a@kd.test');
    expect((await call(handlers.account, 'GET', '/api/account/nope', token)).status).toBe(404);
  });

  it('refuses to run accounts without KD_LEARN_SECRET_KEY, naming only the variable', async () => {
    const { handlers, logs } = make({ KD_LEARN_SECRET_KEY: '' });
    const response = await call(handlers.login, 'POST', '/api/auth/login', undefined, {
      email: 'a@kd.test',
      password: 'x',
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(logs)).toContain('KD_LEARN_SECRET_KEY is missing');
    expect((await call(handlers.endpoints, 'GET', '/api/endpoints')).status).toBe(200);
  });
});
