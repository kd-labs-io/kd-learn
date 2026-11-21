import { describe, expect, it } from 'vitest';
import { defaultProfile } from '@kd-learn/agent';
import { createHandlers } from '../index.ts';
import type { Handlers } from '../index.ts';
import { ADMIN, make } from '../auth/test-support.ts';
import { say, scriptedAi } from '../sessions/fake-ai.ts';

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

const guestTurn = (handlers: Handlers) =>
  call(handlers.turns, 'POST', '/api/turns', undefined, {
    model: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'sk-ant-guest-0123456789' },
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

const codeOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

const setup = async (env: Record<string, string> = {}) => {
  const { handlers, logs } = make(env, { ai: scriptedAi([say('Hi'), say('Hi')]).layer });
  const token = async (email: string, password: string) =>
    (
      (await (
        await call(handlers.login, 'POST', '/api/auth/login', undefined, { email, password })
      ).json()) as {
        token: string;
      }
    ).token;
  const admin = await token(ADMIN.email, ADMIN.password);
  const registered = (await (
    await call(handlers.register, 'POST', '/api/auth/register', undefined, {
      email: 'user@kd.test',
      password: 'password-123',
    })
  ).json()) as { token: string; user: { id: string } };
  return { handlers, logs, admin, user: registered.token, userId: registered.user.id, token };
};

describe('admin switches', () => {
  it('lets only admins read and change the config', async () => {
    const t = await setup();
    expect((await call(t.handlers.admin, 'GET', '/api/admin/config')).status).toBe(401);
    const forbidden = await call(t.handlers.admin, 'GET', '/api/admin/config', t.user);
    expect(forbidden.status).toBe(403);
    expect(
      (await call(t.handlers.admin, 'PUT', '/api/admin/config', t.user, { guestMode: false }))
        .status,
    ).toBe(403);
    expect((await call(t.handlers.admin, 'GET', '/api/admin/users', t.user)).status).toBe(403);
    expect(
      (
        await call(t.handlers.admin, 'PATCH', `/api/admin/users/${t.userId}`, t.user, {
          disabled: true,
        })
      ).status,
    ).toBe(403);

    const config = await call(t.handlers.admin, 'GET', '/api/admin/config', t.admin);
    expect(await config.json()).toEqual({
      registration: 'open',
      guestMode: true,
      demoMode: false,
      demoBudget: { limit: 0, period: 'day', used: 0 },
    });
  });

  it('turning guest mode off closes /api/turns with 403 GuestModeDisabled', async () => {
    const t = await setup();
    expect((await guestTurn(t.handlers)).status).toBe(200);
    await call(t.handlers.admin, 'PUT', '/api/admin/config', t.admin, { guestMode: false });
    const closed = await guestTurn(t.handlers);
    expect(closed.status).toBe(403);
    expect(await codeOf(closed)).toBe('GuestModeDisabled');
    const publicConfig = await call(t.handlers.config, 'GET', '/api/config');
    expect(await publicConfig.json()).toEqual({
      registration: 'open',
      guestMode: false,
      demoMode: false,
    });
    await call(t.handlers.admin, 'PUT', '/api/admin/config', t.admin, { guestMode: true });
    expect((await guestTurn(t.handlers)).status).toBe(200);
  });

  it('changes the registration mode', async () => {
    const t = await setup();
    await call(t.handlers.admin, 'PUT', '/api/admin/config', t.admin, { registration: 'closed' });
    const response = await call(t.handlers.register, 'POST', '/api/auth/register', undefined, {
      email: 'late@kd.test',
      password: 'password-123',
    });
    expect(await codeOf(response)).toBe('RegistrationClosed');
  });

  it('takes defaults from the environment and rejects a bad value', async () => {
    const t = await setup({ KD_LEARN_GUEST_MODE: 'off', KD_LEARN_DEMO_MODE: 'on' });
    expect(await (await call(t.handlers.config, 'GET', '/api/config')).json()).toMatchObject({
      guestMode: false,
      // The switch is on, but there is no demo model and no budget: demo cannot run.
      demoMode: false,
    });
    const bad = make({ KD_LEARN_GUEST_MODE: 'maybe' });
    expect((await call(bad.handlers.login, 'POST', '/api/auth/login', undefined, {})).status).toBe(
      500,
    );
    // The guest switch cannot be read: guest turns are refused, not let through.
    expect((await guestTurn(bad.handlers)).status).toBe(403);
  });

  it('without accounts, guests follow the environment and the public config says so', async () => {
    const handlers = createHandlers({ KD_LEARN_GUEST_MODE: 'off' }, { log: () => undefined });
    expect(await codeOf(await guestTurn(handlers))).toBe('GuestModeDisabled');
    expect(await (await call(handlers.config, 'GET', '/api/config')).json()).toEqual({
      registration: 'closed',
      guestMode: false,
      demoMode: false,
    });
  });
});

describe('admin users', () => {
  it('lists users, disables one (revoking its tokens), and unlocks a locked one', async () => {
    const t = await setup();
    const list = (await (
      await call(t.handlers.admin, 'GET', '/api/admin/users', t.admin)
    ).json()) as {
      users: Array<{ email: string; role: string; disabled: boolean }>;
    };
    expect(list.users.map((u) => [u.email, u.role, u.disabled])).toEqual([
      [ADMIN.email, 'admin', false],
      ['user@kd.test', 'user', false],
    ]);

    const disabled = await call(
      t.handlers.admin,
      'PATCH',
      `/api/admin/users/${t.userId}`,
      t.admin,
      {
        disabled: true,
      },
    );
    expect(await disabled.json()).toMatchObject({ disabled: true });
    expect((await call(t.handlers.me, 'GET', '/api/auth/me', t.user)).status).toBe(401);
    await call(t.handlers.admin, 'PATCH', `/api/admin/users/${t.userId}`, t.admin, {
      disabled: false,
    });

    for (let i = 0; i < 5; i++) await t.token('user@kd.test', 'wrong-password');
    const locked = (await (
      await call(t.handlers.admin, 'GET', '/api/admin/users', t.admin)
    ).json()) as {
      users: Array<{ email: string; lockedUntil?: number }>;
    };
    expect(locked.users.find((u) => u.email === 'user@kd.test')?.lockedUntil).toBeTypeOf('number');
    await call(t.handlers.admin, 'PATCH', `/api/admin/users/${t.userId}`, t.admin, {
      unlock: true,
    });
    expect(await t.token('user@kd.test', 'password-123')).toBeTypeOf('string');
  });

  it('refuses to disable your own account, and 404s an unknown user', async () => {
    const t = await setup();
    const me = (await (await call(t.handlers.me, 'GET', '/api/auth/me', t.admin)).json()) as {
      user: { id: string };
    };
    const self = await call(t.handlers.admin, 'PATCH', `/api/admin/users/${me.user.id}`, t.admin, {
      disabled: true,
    });
    expect(self.status).toBe(409);
    expect(
      (await call(t.handlers.admin, 'PATCH', '/api/admin/users/nope', t.admin, { disabled: true }))
        .status,
    ).toBe(404);
  });
});
