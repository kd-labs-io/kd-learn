// Encryption of provider keys at rest (plan tai-khoan.md A5): AES-256-GCM from `node:crypto`,
// a random 12-byte IV per record, and the master key from `KD_LEARN_SECRET_KEY`.
//
// Each ciphertext is bound to its row through the additional authenticated data (owner and
// connection id), so a ciphertext copied into another row or account does not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigError } from '../config.ts';

export interface SecretBox {
  /** Version of the master key new records use. Stored with each record (plan A5: `keyVersion`). */
  readonly version: number;
  readonly seal: (plaintext: string, context: string) => string;
  /** Undefined when the record is damaged, bound to another row, or sealed with an unknown key. */
  readonly open: (sealed: string, version: number, context: string) => string | undefined;
}

/** Reads `KD_LEARN_SECRET_KEY`: 32 bytes in base64. Throws `ConfigError` naming the variable only. */
export const loadMasterKey = (env: Readonly<Record<string, string | undefined>>): Buffer => {
  const raw = env.KD_LEARN_SECRET_KEY?.trim() ?? '';
  if (raw === '') {
    throw new ConfigError({
      message: 'KD_LEARN_SECRET_KEY is missing (32 bytes in base64: openssl rand -base64 32).',
    });
  }
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new ConfigError({ message: 'KD_LEARN_SECRET_KEY must be 32 bytes in base64.' });
  }
  return key;
};

/** `keys` maps a version to its master key; `current` seals new records. */
export const makeSecretBox = (keys: ReadonlyMap<number, Buffer>, current: number): SecretBox => {
  const key = keys.get(current);
  if (key === undefined || key.length !== 32)
    throw new Error('No 32-byte key for the current version');
  return {
    version: current,
    seal: (plaintext, context) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [iv, body, tag].map((part) => part.toString('base64')).join('.');
    },
    open: (sealed, version, context) => {
      const master = keys.get(version);
      const parts = sealed.split('.');
      if (master === undefined || parts.length !== 3) return undefined;
      const [iv, body, tag] = parts.map((part) => Buffer.from(part, 'base64')) as [
        Buffer,
        Buffer,
        Buffer,
      ];
      if (iv.length !== 12 || tag.length !== 16) return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', master, iv);
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        return undefined;
      }
    },
  };
};
