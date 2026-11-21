// Password hashing with Argon2id from `node:crypto` (plan step 0, C2). OWASP parameters:
// m = 19 MiB, t = 2, p = 1. The stored string carries its own parameters, so they can be raised
// later without breaking existing hashes.
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/** Unicode code points; hashing is bounded by `MAX_PASSWORD_LENGTH` before any work is done. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

interface Params {
  /** KiB (checked: 262144 uses about 256 MB of memory). */
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

const CURRENT: Params = { memory: 19_456, passes: 2, parallelism: 1 };
const TAG_LENGTH = 32;
/** Upper bounds when reading a stored hash, so a corrupt row cannot make us allocate gigabytes. */
const LIMITS: Params = { memory: 262_144, passes: 10, parallelism: 8 };

const derive = (password: string, nonce: Buffer, params: Params): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    argon2(
      'argon2id',
      { message: password, nonce, tagLength: TAG_LENGTH, ...params },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

/** `argon2id$v=19$m=…,t=…,p=…$<salt b64>$<tag b64>`, close to the PHC string format. */
export const hashPassword = async (password: string): Promise<string> => {
  const nonce = randomBytes(16);
  const tag = await derive(password, nonce, CURRENT);
  const { memory, passes, parallelism } = CURRENT;
  return `argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${nonce.toString('base64')}$${tag.toString('base64')}`;
};

const parse = (stored: string) => {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'argon2id' || parts[1] !== 'v=19') return undefined;
  const match = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[2] ?? '');
  if (!match) return undefined;
  const params: Params = {
    memory: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
  };
  if (
    params.memory < 8 * params.parallelism ||
    params.memory > LIMITS.memory ||
    params.passes < 1 ||
    params.passes > LIMITS.passes ||
    params.parallelism < 1 ||
    params.parallelism > LIMITS.parallelism
  ) {
    return undefined;
  }
  const nonce = Buffer.from(parts[3] ?? '', 'base64');
  const tag = Buffer.from(parts[4] ?? '', 'base64');
  if (nonce.length < 8 || tag.length !== TAG_LENGTH) return undefined;
  return { params, nonce, tag };
};

/** False for a wrong password and for a stored value that is not a hash we wrote. */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parse(stored);
  if (parsed === undefined) return false;
  const tag = await derive(password, parsed.nonce, parsed.params);
  return timingSafeEqual(tag, parsed.tag);
};

/** A valid hash of a random password: verified against when the email is unknown, to even out timing. */
let dummy: Promise<string> | undefined;
export const dummyHash = (): Promise<string> =>
  (dummy ??= hashPassword(randomBytes(24).toString('base64')));
