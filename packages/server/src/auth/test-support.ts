// Handlers over an in-memory database, for the route tests. Not a test file itself.
import { Effect } from 'effect';
import type { Layer } from 'effect';
import type { AiPort } from '@kd-learn/ai/port';
import { openServerDatabase } from '@kd-learn/storage/sqlite-node';
import { createHandlers } from '../index.ts';
import type { LogEntry } from '../index.ts';

export const ADMIN = { email: 'root@kd.test', password: 'admin-password-1' };
export const USER = { email: 'learner@kd.test', password: 'learner-password-1' };

export interface MakeOptions {
  readonly ai?: Layer.Layer<AiPort>;
  readonly turnTimeoutMs?: number;
  readonly acp?: Layer.Layer<AiPort>;
  /** A database file instead of memory, to reopen it like a restart. */
  readonly dbPath?: string;
}

export const make = (env: Record<string, string> = {}, options: MakeOptions = {}) => {
  const logs: LogEntry[] = [];
  const handlers = createHandlers(
    {
      KD_LEARN_ADMIN_EMAIL: ADMIN.email,
      KD_LEARN_ADMIN_PASSWORD: ADMIN.password,
      KD_LEARN_REGISTRATION: 'open',
      KD_CORS_ORIGINS: 'capacitor://localhost',
      KD_LEARN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
      ...env,
    },
    {
      log: (entry) => logs.push(entry),
      database: Effect.runSync(openServerDatabase({ path: options.dbPath ?? ':memory:' })),
      ...(options.ai ? { ai: options.ai } : {}),
      ...(options.acp ? { acp: options.acp } : {}),
      ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    },
  );
  return { handlers, logs };
};
