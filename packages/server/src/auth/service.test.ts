import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { openServerDatabase } from '@kd-learn/storage/sqlite-node';
import { hashPassword, verifyPassword } from './password.ts';
import { makeAuth, type AuthOptions, type RegistrationMode } from './service.ts';

const setup = (options: AuthOptions & { readonly mode?: RegistrationMode } = {}) => {
  const database = Effect.runSync(openServerDatabase({ path: ':memory:' }));
  let clock = 1_000_000;
  const auth = makeAuth(database, { now: () => clock, ...options });
  if (options.mode) auth.setRegistrationMode(options.mode);
  /** Creates the admin and returns its id, for invites. */
  const admin = async () => {
    await auth.ensureAdmin('admin@x.io', 'password1');
    return (
      database.db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as { id: string }
    ).id;
  };
  return {
    admin,
    database,
    auth,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const ok = <T extends { _tag: string }>(result: T) => {
  if (result._tag !== 'Ok') throw new Error(`expected Ok, got ${result._tag}`);
  return result as Extract<T, { _tag: 'Ok' }>;
};

describe('password hashing', () => {
  it('verifies the right password only, and reads parameters from the stored hash', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored).toMatch(/^argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong horse', stored)).toBe(false);
    // Different stored parameters give a different key: they are not ignored.
    expect(await verifyPassword('correct horse', stored.replace('t=2', 't=3'))).toBe(false);
  });

  it('rejects stored values it did not write, without heavy work', async () => {
    const stored = await hashPassword('pw');
    expect(await verifyPassword('pw', 'plain')).toBe(false);
    expect(await verifyPassword('pw', stored.replace('m=19456', 'm=99999999'))).toBe(false);
  });
});

describe('registration', () => {
  it('follows the mode: open, invite, closed', async () => {
    const open = setup({ mode: 'open' });
    expect(ok(await open.auth.register({ email: 'A@X.io ', password: 'password1' })).user).toEqual(
      expect.objectContaining({ email: 'a@x.io', role: 'user' }),
    );
    const closed = setup({ mode: 'closed' });
    expect((await closed.auth.register({ email: 'a@x.io', password: 'password1' }))._tag).toBe(
      'RegistrationClosed',
    );
    const invite = setup({ mode: 'invite' });
    expect((await invite.auth.register({ email: 'a@x.io', password: 'password1' }))._tag).toBe(
      'InvalidInvite',
    );
  });

  it('defaults to the configured mode until an admin sets one', () => {
    expect(setup().auth.registrationMode()).toBe('invite');
    expect(setup({ defaultRegistration: 'closed' }).auth.registrationMode()).toBe('closed');
  });

  it('uses an invite once, and not after it expires', async () => {
    const { auth, advance, admin } = setup({ mode: 'invite' });
    const adminId = await admin();
    const { code } = auth.createInvite(adminId, 1000);
    ok(await auth.register({ email: 'a@x.io', password: 'password1', inviteCode: code }));
    expect(
      (await auth.register({ email: 'b@x.io', password: 'password1', inviteCode: code }))._tag,
    ).toBe('InvalidInvite');
    const late = auth.createInvite(adminId, 1000);
    advance(1000);
    expect(
      (await auth.register({ email: 'c@x.io', password: 'password1', inviteCode: late.code }))._tag,
    ).toBe('InvalidInvite');
  });

  it('lets exactly one of two concurrent registrations use an invite', async () => {
    const { auth, admin } = setup({ mode: 'invite' });
    const { code } = auth.createInvite(await admin(), 60_000);
    const results = await Promise.all([
      auth.register({ email: 'a@x.io', password: 'password1', inviteCode: code }),
      auth.register({ email: 'b@x.io', password: 'password1', inviteCode: code }),
    ]);
    expect(results.map((r) => r._tag).sort()).toEqual(['InvalidInvite', 'Ok']);
  });

  it('gives the invite back when the email is taken', async () => {
    const { auth, admin } = setup({ mode: 'open' });
    ok(await auth.register({ email: 'a@x.io', password: 'password1' }));
    auth.setRegistrationMode('invite');
    const { code } = auth.createInvite(await admin(), 60_000);
    expect(
      (await auth.register({ email: 'A@x.io', password: 'password1', inviteCode: code }))._tag,
    ).toBe('EmailTaken');
    ok(await auth.register({ email: 'b@x.io', password: 'password1', inviteCode: code }));
  });

  it('stores only hashes of passwords, tokens and invite codes', async () => {
    const { auth, database, admin } = setup({ mode: 'invite' });
    const { code } = auth.createInvite(await admin(), 60_000);
    const { token } = ok(
      await auth.register({ email: 'a@x.io', password: 'password1', inviteCode: code }),
    );
    const dump = JSON.stringify([
      database.db.prepare('SELECT * FROM users').all(),
      database.db.prepare('SELECT * FROM auth_tokens').all(),
      database.db.prepare('SELECT * FROM invites').all(),
    ]);
    for (const secret of ['password1', token, code]) expect(dump).not.toContain(secret);
  });
});

describe('login', () => {
  const withUser = async (options: AuthOptions = {}) => {
    const context = setup({ mode: 'open', ...options });
    const user = ok(await context.auth.register({ email: 'a@x.io', password: 'password1' })).user;
    return { ...context, user };
  };

  it('issues a token for the right password, case-insensitive email', async () => {
    const { auth, user } = await withUser();
    const { token } = ok(await auth.login({ email: ' A@X.IO', password: 'password1' }));
    expect(auth.authenticate(token)).toEqual(user);
  });

  it('answers the same for a wrong password and an unknown email', async () => {
    const { auth } = await withUser();
    expect((await auth.login({ email: 'a@x.io', password: 'nope' }))._tag).toBe(
      'InvalidCredentials',
    );
    expect((await auth.login({ email: 'b@x.io', password: 'nope' }))._tag).toBe(
      'InvalidCredentials',
    );
  });

  it('locks an email after 5 failures, even with the right password, and unlocks after the window', async () => {
    const { auth, advance } = await withUser();
    for (let i = 0; i < 5; i++) await auth.login({ email: 'a@x.io', password: 'nope' });
    expect((await auth.login({ email: 'a@x.io', password: 'password1' }))._tag).toBe(
      'TooManyAttempts',
    );
    advance(15 * 60 * 1000);
    ok(await auth.login({ email: 'a@x.io', password: 'password1' }));
  });

  it('locks an unknown email the same way (no enumeration through the lock)', async () => {
    const { auth } = await withUser();
    const tags = [];
    for (let i = 0; i < 6; i++)
      tags.push((await auth.login({ email: 'b@x.io', password: 'x' }))._tag);
    expect(tags.at(-1)).toBe('TooManyAttempts');
  });

  it('counts concurrent attempts before the password check', async () => {
    const { auth } = await withUser();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => auth.login({ email: 'a@x.io', password: 'nope' })),
    );
    expect(results.filter((r) => r._tag === 'InvalidCredentials')).toHaveLength(5);
    expect(results.filter((r) => r._tag === 'TooManyAttempts')).toHaveLength(15);
  });

  it('resets the count after a success', async () => {
    const { auth } = await withUser();
    for (let i = 0; i < 4; i++) await auth.login({ email: 'a@x.io', password: 'nope' });
    ok(await auth.login({ email: 'a@x.io', password: 'password1' }));
    for (let i = 0; i < 4; i++) await auth.login({ email: 'a@x.io', password: 'nope' });
    ok(await auth.login({ email: 'a@x.io', password: 'password1' }));
  });

  it('reports a disabled account only after the right password', async () => {
    const { auth, user } = await withUser();
    auth.setDisabled(user.id, true);
    expect((await auth.login({ email: 'a@x.io', password: 'nope' }))._tag).toBe(
      'InvalidCredentials',
    );
    expect((await auth.login({ email: 'a@x.io', password: 'password1' }))._tag).toBe(
      'AccountDisabled',
    );
  });

  it('admin unlock clears the lock', async () => {
    const { auth } = await withUser();
    for (let i = 0; i < 5; i++) await auth.login({ email: 'a@x.io', password: 'nope' });
    auth.unlock('A@x.io');
    ok(await auth.login({ email: 'a@x.io', password: 'password1' }));
  });
});

describe('tokens', () => {
  it('rejects expired, revoked, unknown tokens and tokens of disabled users', async () => {
    const { auth, advance } = setup({ mode: 'open', tokenTtlMs: 1000 });
    const first = ok(await auth.register({ email: 'a@x.io', password: 'password1' }));
    expect(auth.authenticate(first.token)).toBeDefined();
    advance(1000);
    expect(auth.authenticate(first.token)).toBeUndefined();

    const second = ok(await auth.login({ email: 'a@x.io', password: 'password1' }));
    auth.logout(second.token);
    expect(auth.authenticate(second.token)).toBeUndefined();

    const third = ok(await auth.login({ email: 'a@x.io', password: 'password1' }));
    auth.setDisabled(third.user.id, true);
    auth.setDisabled(third.user.id, false);
    // Disabling revoked it; enabling again does not bring it back.
    expect(auth.authenticate(third.token)).toBeUndefined();
    expect(auth.authenticate('nope')).toBeUndefined();
    expect(auth.authenticate('')).toBeUndefined();
  });
});

describe('first admin', () => {
  it('creates the admin once', async () => {
    const { auth } = setup();
    expect(await auth.ensureAdmin('Admin@x.io', 'password1')).toBe('created');
    expect(await auth.ensureAdmin('other@x.io', 'password2')).toBe('exists');
    expect(ok(await auth.login({ email: 'admin@x.io', password: 'password1' })).user.role).toBe(
      'admin',
    );
    expect((await auth.login({ email: 'other@x.io', password: 'password2' }))._tag).toBe(
      'InvalidCredentials',
    );
  });

  it('creates one admin when called concurrently', async () => {
    const { auth, database } = setup();
    const outcomes = await Promise.all([
      auth.ensureAdmin('admin@x.io', 'password1'),
      auth.ensureAdmin('admin@x.io', 'password1'),
    ]);
    expect(outcomes.sort()).toEqual(['created', 'exists']);
    expect(
      database.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get(),
    ).toEqual({
      n: 1,
    });
  });

  it('takes over an account that registered the admin email first, with the configured password', async () => {
    const { auth } = setup({ mode: 'open' });
    const squatter = ok(await auth.register({ email: 'admin@x.io', password: 'squatter1' }));
    expect(await auth.ensureAdmin('admin@x.io', 'password1')).toBe('promoted');
    expect(auth.authenticate(squatter.token)).toBeUndefined();
    expect((await auth.login({ email: 'admin@x.io', password: 'squatter1' }))._tag).toBe(
      'InvalidCredentials',
    );
    expect(ok(await auth.login({ email: 'admin@x.io', password: 'password1' })).user.role).toBe(
      'admin',
    );
  });
});
