// Accounts, tokens, invites (plan tai-khoan.md A4, step 2). Lives outside the storage port:
// `agent` never sees it. Uses the server database through its synchronous `transaction`.
//
// Concurrency: argon2 is asynchronous, so any check made before an `await` can be stale after it.
// Every decision that must hold (lockout count, invite use, "no admin yet", email uniqueness) is
// made inside one synchronous transaction after the last `await`.
//
// Enumeration (risk 23): login answers the same for an unknown email, a wrong password, and a
// locked email, and reports a disabled account only after the right password. The lockout is keyed
// by the email string whether or not an account has it. Registration cannot hide that an email is
// taken without email verification; it checks the mode and the invite first, so only someone who
// may register can learn it.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ServerDatabase } from '@kd-learn/storage/sqlite-node';
import { dummyHash, hashPassword, verifyPassword } from './password.ts';

export type Role = 'admin' | 'user';
export type RegistrationMode = 'open' | 'invite' | 'closed';
export const registrationModes: ReadonlyArray<RegistrationMode> = ['open', 'invite', 'closed'];

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
}

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: CurrentUser;
}

export type LoginResult =
  | ({ readonly _tag: 'Ok' } & IssuedToken)
  | { readonly _tag: 'InvalidCredentials' }
  | { readonly _tag: 'TooManyAttempts' }
  | { readonly _tag: 'AccountDisabled' };

export type RegisterResult =
  | ({ readonly _tag: 'Ok' } & IssuedToken)
  | { readonly _tag: 'RegistrationClosed' }
  | { readonly _tag: 'InvalidInvite' }
  | { readonly _tag: 'EmailTaken' };

export interface AuthOptions {
  readonly now?: () => number;
  /** Default 30 days. */
  readonly tokenTtlMs?: number;
  /** Failed logins per email before the lock. Default 5. */
  readonly maxFailures?: number;
  /** Window in which failures add up, and the lock length. Default 15 minutes. */
  readonly lockMs?: number;
  /** Registration mode until an admin sets one (step 5). Default `invite`. */
  readonly defaultRegistration?: RegistrationMode;
}

export interface AuthService {
  readonly register: (input: {
    readonly email: string;
    readonly password: string;
    readonly inviteCode?: string | undefined;
  }) => Promise<RegisterResult>;
  readonly login: (input: {
    readonly email: string;
    readonly password: string;
  }) => Promise<LoginResult>;
  /** The user behind a token, or undefined when it is unknown, expired, revoked, or the user is disabled. */
  readonly authenticate: (token: string) => CurrentUser | undefined;
  /** Revokes one token. Unknown tokens are ignored. */
  readonly logout: (token: string) => void;
  /** Revokes every token of a user (admin disables the account, password change). */
  readonly revokeAll: (userId: string) => void;
  readonly setDisabled: (userId: string, disabled: boolean) => void;
  /** Clears the lockout of an email (admin action). */
  readonly unlock: (email: string) => void;
  /** A one-time invite code; only its hash is stored. */
  readonly createInvite: (
    createdBy: string,
    ttlMs: number,
  ) => { readonly code: string; readonly expiresAt: number };
  readonly registrationMode: () => RegistrationMode;
  readonly setRegistrationMode: (mode: RegistrationMode) => void;
  /**
   * Makes sure an admin exists (plan A4: from `KD_LEARN_ADMIN_EMAIL` / `_PASSWORD`). Does nothing
   * when the database already has one. If a non-admin account already has that email, it becomes
   * the admin with the configured password, and its tokens are revoked.
   */
  readonly ensureAdmin: (
    email: string,
    password: string,
  ) => Promise<'created' | 'promoted' | 'exists'>;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');

class Abort<T> extends Error {
  constructor(readonly result: T) {
    super('abort');
  }
}

/** Runs `work` in a transaction; `abort(result)` rolls back and returns `result`. */
const decide = <T>(database: ServerDatabase, work: (abort: (result: T) => never) => T): T => {
  try {
    return database.transaction(() =>
      work((result) => {
        throw new Abort(result);
      }),
    );
  } catch (error) {
    if (error instanceof Abort) return error.result as T;
    throw error;
  }
};

const isUniqueViolation = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed: users\.email/.test(error.message);

export const makeAuth = (database: ServerDatabase, options: AuthOptions = {}): AuthService => {
  const {
    now = Date.now,
    tokenTtlMs = 30 * 24 * 60 * 60 * 1000,
    maxFailures = 5,
    lockMs = 15 * 60 * 1000,
    defaultRegistration = 'invite',
  } = options;
  const { db } = database;

  const q = {
    userByEmail: db.prepare(
      'SELECT id, email, password_hash, role, disabled FROM users WHERE email = ?',
    ),
    insertUser: db.prepare(
      'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    anyAdmin: db.prepare("SELECT 1 AS one FROM users WHERE role = 'admin' LIMIT 1"),
    promote: db.prepare(
      "UPDATE users SET role = 'admin', password_hash = ?, disabled = 0 WHERE id = ?",
    ),
    insertToken: db.prepare(
      'INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ),
    tokenUser: db.prepare(
      `SELECT u.id, u.email, u.role FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND u.disabled = 0`,
    ),
    revoke: db.prepare(
      'UPDATE auth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    ),
    revokeAll: db.prepare(
      'UPDATE auth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ),
    setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE id = ?'),
    throttle: db.prepare(
      'SELECT failures, window_start, locked_until FROM login_throttle WHERE email = ?',
    ),
    putThrottle: db.prepare(
      `INSERT OR REPLACE INTO login_throttle (email, failures, window_start, locked_until)
       VALUES (?, ?, ?, ?)`,
    ),
    clearThrottle: db.prepare('DELETE FROM login_throttle WHERE email = ?'),
    pruneThrottle: db.prepare(
      'DELETE FROM login_throttle WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)',
    ),
    insertInvite: db.prepare(
      'INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ),
    useInvite: db.prepare(
      `UPDATE invites SET used_at = ?, used_by = ?
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING code_hash`,
    ),
    getConfig: db.prepare('SELECT value FROM server_config WHERE key = ?'),
    putConfig: db.prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)'),
  };

  const issue = (user: CurrentUser): IssuedToken => {
    const token = newSecret();
    const at = now();
    const expiresAt = at + tokenTtlMs;
    q.insertToken.run(sha256(token), user.id, at, expiresAt);
    return { token, expiresAt, user };
  };

  const registrationMode = (): RegistrationMode => {
    const row = q.getConfig.get('registration') as { value: string } | undefined;
    const value = row?.value as RegistrationMode | undefined;
    return value !== undefined && registrationModes.includes(value) ? value : defaultRegistration;
  };

  /** Counts one attempt for `email` before the password is checked. False when it is locked. */
  const countAttempt = (email: string): boolean =>
    decide<boolean>(database, () => {
      const at = now();
      const row = q.throttle.get(email) as
        { failures: number; window_start: number; locked_until: number | null } | undefined;
      if (row?.locked_until != null && row.locked_until > at) return false;
      const fresh =
        row === undefined || at - row.window_start >= lockMs || row.locked_until != null;
      const failures = fresh ? 1 : row.failures + 1;
      const windowStart = fresh ? at : row.window_start;
      q.putThrottle.run(email, failures, windowStart, failures >= maxFailures ? at + lockMs : null);
      // Keeps the table small when someone tries many emails.
      if (Math.random() < 0.01) q.pruneThrottle.run(at - lockMs, at);
      return true;
    });

  return {
    registrationMode,
    setRegistrationMode: (mode) => void q.putConfig.run('registration', mode),

    register: async ({ email: rawEmail, password, inviteCode }) => {
      const email = normalizeEmail(rawEmail);
      const passwordHash = await hashPassword(password);
      // Everything below is synchronous: mode, invite and uniqueness are decided together.
      try {
        return decide<RegisterResult>(database, (abort) => {
          const mode = registrationMode();
          if (mode === 'closed') abort({ _tag: 'RegistrationClosed' });
          const id = randomUUID();
          const at = now();
          if (mode === 'invite') {
            const used =
              inviteCode !== undefined &&
              q.useInvite.get(at, id, sha256(inviteCode), at) !== undefined;
            if (!used) abort({ _tag: 'InvalidInvite' });
          }
          q.insertUser.run(id, email, passwordHash, 'user', at);
          return { _tag: 'Ok', ...issue({ id, email, role: 'user' }) };
        });
      } catch (error) {
        // The rollback also gave the invite back.
        if (isUniqueViolation(error)) return { _tag: 'EmailTaken' };
        throw error;
      }
    },

    login: async ({ email: rawEmail, password }) => {
      const email = normalizeEmail(rawEmail);
      if (!countAttempt(email)) return { _tag: 'TooManyAttempts' };
      const row = q.userByEmail.get(email) as
        | { id: string; email: string; password_hash: string; role: Role; disabled: number }
        | undefined;
      const valid = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
      if (row === undefined || !valid) return { _tag: 'InvalidCredentials' };
      q.clearThrottle.run(email);
      // Re-read after the await: the account may have been disabled meanwhile.
      const current = q.userByEmail.get(email) as
        { id: string; disabled: number; role: Role } | undefined;
      if (current === undefined || current.id !== row.id) return { _tag: 'InvalidCredentials' };
      if (current.disabled) return { _tag: 'AccountDisabled' };
      return { _tag: 'Ok', ...issue({ id: row.id, email: row.email, role: current.role }) };
    },

    authenticate: (token) => {
      if (token.length === 0 || token.length > 128) return undefined;
      const row = q.tokenUser.get(sha256(token), now()) as CurrentUser | undefined;
      return row === undefined ? undefined : { id: row.id, email: row.email, role: row.role };
    },

    logout: (token) => void q.revoke.run(now(), sha256(token)),
    revokeAll: (userId) => void q.revokeAll.run(now(), userId),
    setDisabled: (userId, disabled) =>
      database.transaction(() => {
        q.setDisabled.run(disabled ? 1 : 0, userId);
        if (disabled) q.revokeAll.run(now(), userId);
      }),
    unlock: (email) => void q.clearThrottle.run(normalizeEmail(email)),

    createInvite: (createdBy, ttlMs) => {
      const code = newSecret();
      const at = now();
      const expiresAt = at + ttlMs;
      q.insertInvite.run(sha256(code), createdBy, at, expiresAt);
      return { code, expiresAt };
    },

    ensureAdmin: async (rawEmail, password) => {
      const email = normalizeEmail(rawEmail);
      if (q.anyAdmin.get() !== undefined) return 'exists';
      const passwordHash = await hashPassword(password);
      return decide(database, () => {
        // Checked again after the await.
        if (q.anyAdmin.get() !== undefined) return 'exists' as const;
        const existing = q.userByEmail.get(email) as { id: string } | undefined;
        if (existing) {
          q.promote.run(passwordHash, existing.id);
          q.revokeAll.run(now(), existing.id);
          return 'promoted' as const;
        }
        q.insertUser.run(randomUUID(), email, passwordHash, 'admin', now());
        return 'created' as const;
      });
    },
  };
};
