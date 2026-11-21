// Account configuration from the environment (plan tai-khoan.md A4). Messages name the variable,
// never its value.
import { ConfigError } from '../config.ts';
import { loadMasterKey } from '../settings/secret-box.ts';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password.ts';
import { registrationModes, type RegistrationMode } from './service.ts';

export interface AccountConfig {
  /** SQLite file of the server. */
  readonly dbPath: string;
  /** First admin, created when the database has none. Both variables or neither. */
  readonly admin: { readonly email: string; readonly password: string } | undefined;
  /** Registration mode until an admin changes it. */
  readonly registration: RegistrationMode;
  /**
   * Behind a reverse proxy (plan A10): take the client address from the last `X-Forwarded-For`
   * entry, the one the proxy appended. Off by default: the header is then ignored, since anyone
   * can send it.
   */
  readonly trustProxy: boolean;
  /** `KD_LEARN_SECRET_KEY`: encrypts provider keys (plan A5). Required for accounts. */
  readonly masterKey: Buffer;
}

export const DEFAULT_DB_PATH = 'data/kd-learn.db';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * - `KD_LEARN_DB_PATH`: default `data/kd-learn.db` (relative to the working directory).
 * - `KD_LEARN_ADMIN_EMAIL`, `KD_LEARN_ADMIN_PASSWORD`: the first admin.
 * - `KD_LEARN_REGISTRATION`: `open`, `invite` (default) or `closed`.
 * - `KD_LEARN_TRUST_PROXY`: `1` or `true` behind a reverse proxy.
 * - `KD_LEARN_SECRET_KEY`: required, 32 bytes in base64. Without it the account routes refuse to
 *   run (guest mode does not need it).
 */
export const loadAccountConfig = (
  env: Readonly<Record<string, string | undefined>>,
): AccountConfig => {
  const email = env.KD_LEARN_ADMIN_EMAIL?.trim() ?? '';
  const password = env.KD_LEARN_ADMIN_PASSWORD ?? '';
  if ((email === '') !== (password === '')) {
    throw new ConfigError({
      message: 'Set both KD_LEARN_ADMIN_EMAIL and KD_LEARN_ADMIN_PASSWORD, or neither.',
    });
  }
  if (email !== '' && (!EMAIL.test(email) || email.length > 254)) {
    throw new ConfigError({ message: 'KD_LEARN_ADMIN_EMAIL is not an email address.' });
  }
  if (
    password !== '' &&
    (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH)
  ) {
    throw new ConfigError({
      message: `KD_LEARN_ADMIN_PASSWORD must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
    });
  }
  const registration = (env.KD_LEARN_REGISTRATION?.trim() || 'invite') as RegistrationMode;
  if (!registrationModes.includes(registration)) {
    throw new ConfigError({ message: 'KD_LEARN_REGISTRATION must be open, invite or closed.' });
  }
  const trust = env.KD_LEARN_TRUST_PROXY?.trim().toLowerCase() ?? '';
  return {
    dbPath: env.KD_LEARN_DB_PATH?.trim() || DEFAULT_DB_PATH,
    admin: email === '' ? undefined : { email, password },
    registration,
    trustProxy: trust === '1' || trust === 'true',
    masterKey: loadMasterKey(env),
  };
};

/** The client address used for rate limiting, or undefined when it is not known. */
export const clientAddress = (
  request: Request,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string | undefined => {
  if (trustProxy) {
    const entries = (request.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const last = entries[entries.length - 1];
    if (last !== undefined) return last;
  }
  return socketAddress === '' ? undefined : socketAddress;
};
