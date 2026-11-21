import { describe, expect, it } from 'vitest';
import { ADMIN, USER, make } from './test-support.ts';
import type { Handlers, RequestContext } from '../index.ts';

const post = (
  handler: Handlers[keyof Handlers],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  context?: RequestContext,
) =>
  handler(
    new Request(`http://kd.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    context,
  );

const get = (
  handler: Handlers[keyof Handlers],
  path: string,
  headers: Record<string, string> = {},
) => handler(new Request(`http://kd.test${path}`, { headers }));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('account routes', () => {
  it('registers, signs in, answers me, and logs out', async () => {
    const { handlers } = make();
    const registered = await post(handlers.register, '/api/auth/register', USER);
    expect(registered.status).toBe(201);
    const { token, user } = (await registered.json()) as { token: string; user: { role: string } };
    expect(user.role).toBe('user');

    const me = await get(handlers.me, '/api/auth/me', bearer(token));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(USER.email);

    expect((await post(handlers.logout, '/api/auth/logout', '', bearer(token))).status).toBe(204);
    const after = await get(handlers.me, '/api/auth/me', bearer(token));
    expect(after.status).toBe(401);
    expect(await code(after)).toBe('Unauthorized');

    const login = await post(handlers.login, '/api/auth/login', USER);
    expect(login.status).toBe(200);
  });

  it('refuses me without a token or with a malformed header', async () => {
    const { handlers } = make();
    expect((await get(handlers.me, '/api/auth/me')).status).toBe(401);
    expect((await get(handlers.me, '/api/auth/me', { authorization: 'Basic abc' })).status).toBe(
      401,
    );
    expect((await get(handlers.me, '/api/auth/me', bearer('x'.repeat(200)))).status).toBe(401);
  });

  it('creates the first admin from the environment; only admins create invites', async () => {
    const { handlers } = make({ KD_LEARN_REGISTRATION: 'invite' });
    const admin = (await (await post(handlers.login, '/api/auth/login', ADMIN)).json()) as {
      token: string;
      user: { role: string };
    };
    expect(admin.user.role).toBe('admin');

    const invite = await post(handlers.invites, '/api/admin/invites', {}, bearer(admin.token));
    expect(invite.status).toBe(201);
    const { code: inviteCode } = (await invite.json()) as { code: string };

    const noInvite = await post(handlers.register, '/api/auth/register', USER);
    expect(noInvite.status).toBe(403);
    expect(await code(noInvite)).toBe('InvalidInvite');

    const registered = await post(handlers.register, '/api/auth/register', { ...USER, inviteCode });
    expect(registered.status).toBe(201);
    const { token } = (await registered.json()) as { token: string };
    const forbidden = await post(handlers.invites, '/api/admin/invites', {}, bearer(token));
    expect(forbidden.status).toBe(403);
    expect(await code(forbidden)).toBe('Forbidden');
    expect((await post(handlers.invites, '/api/admin/invites', {})).status).toBe(401);
  });

  it('blocks registration when it is closed', async () => {
    const { handlers } = make({ KD_LEARN_REGISTRATION: 'closed' });
    const response = await post(handlers.register, '/api/auth/register', USER);
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('RegistrationClosed');
  });

  it('rejects bad input with a message that does not echo it', async () => {
    const { handlers } = make();
    const short = await post(handlers.register, '/api/auth/register', {
      email: USER.email,
      password: 'short',
    });
    expect(short.status).toBe(400);
    expect(await short.text()).not.toContain('short"');
    const extra = await post(handlers.register, '/api/auth/register', { ...USER, role: 'admin' });
    expect(extra.status).toBe(400);
    expect((await post(handlers.login, '/api/auth/login', '{not json')).status).toBe(400);
  });

  it('never logs an email, password, token or invite code', async () => {
    const { handlers, logs } = make({ KD_LEARN_REGISTRATION: 'invite' });
    const admin = (await (await post(handlers.login, '/api/auth/login', ADMIN)).json()) as {
      token: string;
    };
    const { code: inviteCode } = (await (
      await post(handlers.invites, '/api/admin/invites', {}, bearer(admin.token))
    ).json()) as { code: string };
    await post(handlers.register, '/api/auth/register', { ...USER, inviteCode });
    await post(handlers.register, '/api/auth/register', { ...USER, inviteCode });
    await post(handlers.register, '/api/auth/register', { email: USER.email, password: 'short' });
    await post(handlers.login, '/api/auth/login', { ...USER, password: 'wrong-password' });
    await post(handlers.login, '/api/auth/login', '{bad');
    for (let i = 0; i < 6; i++)
      await post(handlers.login, '/api/auth/login', { ...ADMIN, password: 'x' });
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(5);
    for (const secret of [
      ADMIN.email,
      ADMIN.password,
      USER.email,
      USER.password,
      admin.token,
      inviteCode,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('allows the Authorization header cross-origin for Capacitor', async () => {
    const { handlers } = make();
    const preflight = await handlers.me(
      new Request('http://kd.test/api/auth/me', {
        method: 'OPTIONS',
        headers: {
          origin: 'capacitor://localhost',
          'access-control-request-headers': 'authorization',
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(preflight.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
  });

  it('rate-limits failed logins per client address', async () => {
    const { handlers } = make();
    const fail = (context: RequestContext, email: string) =>
      post(handlers.login, '/api/auth/login', { email, password: 'wrong' }, {}, context);
    // Different emails, so the per-email lock is not what stops it.
    for (let i = 0; i < 30; i++) await fail({ clientAddress: '10.0.0.1' }, `u${i}@kd.test`);
    const blocked = await fail({ clientAddress: '10.0.0.1' }, 'next@kd.test');
    expect(blocked.status).toBe(429);
    expect((await fail({ clientAddress: '10.0.0.2' }, 'next@kd.test')).status).toBe(401);
    // Without a known address there is no shared bucket to exhaust.
    expect((await fail({}, 'next@kd.test')).status).toBe(401);
    // About 30 failed logins, each hashing a password: slow on a loaded CI runner.
  }, 30_000);

  it('takes the proxy-appended X-Forwarded-For entry only when trusted', async () => {
    const trusted = make({ KD_LEARN_TRUST_PROXY: '1' });
    const fail = (h: Handlers, xff: string) =>
      post(
        h.login,
        '/api/auth/login',
        { email: `${Math.random()}@kd.test`, password: 'x' },
        {
          'x-forwarded-for': xff,
        },
        { clientAddress: '172.16.0.1' },
      );
    // The client forges the first entry; the proxy appends the real one.
    for (let i = 0; i < 30; i++) await fail(trusted.handlers, `1.1.1.${i}, 9.9.9.9`);
    expect((await fail(trusted.handlers, '2.2.2.2, 9.9.9.9')).status).toBe(429);
    expect((await fail(trusted.handlers, '9.9.9.8')).status).toBe(401);

    const untrusted = make();
    for (let i = 0; i < 30; i++) await fail(untrusted.handlers, `9.9.9.${i}`);
    // The header is ignored: every request came from the socket 172.16.0.1.
    expect((await fail(untrusted.handlers, '8.8.8.8')).status).toBe(429);
    // About 60 failed logins, each hashing a password: slow on a loaded CI runner.
  }, 30_000);

  it('breaks only the account routes when the admin variables are wrong', async () => {
    const { handlers, logs } = make({ KD_LEARN_ADMIN_PASSWORD: '' });
    const response = await post(handlers.login, '/api/auth/login', USER);
    expect(response.status).toBe(500);
    expect(await code(response)).toBe('ServerMisconfigured');
    expect(JSON.stringify(logs)).toContain('KD_LEARN_ADMIN_PASSWORD');
    expect(JSON.stringify(logs)).not.toContain(ADMIN.email);
    expect((await get(handlers.endpoints, '/api/endpoints')).status).toBe(200);
  });
});
