// Admin switches and user management (plan tai-khoan.md A7). Stored in `server_config`; a value
// an admin never set falls back to the environment default.
import type { ModelRef } from '@kd-learn/ai/port';
import type {
  AcpAgent,
  AcpModels,
  AdminConfig,
  AdminUser,
  PublicConfig,
  RegistrationMode,
  UpdateAdminConfigRequest,
} from '@kd-learn/api';
import type { DemoBudgetService } from '../demo/budget.ts';
import type { ServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { AuthService } from '../auth/service.ts';
import { registrationModes } from '../auth/service.ts';

export interface SwitchDefaults {
  readonly registration: RegistrationMode;
  readonly guestMode: boolean;
  readonly demoMode: boolean;
  readonly acpAgents: ReadonlyArray<AcpAgent>;
  readonly acpModels: AcpModels;
  readonly acpMaxConcurrent: number;
}

export interface AdminService {
  /** The three switches as the admin set them. */
  readonly switches: () => Omit<PublicConfig, 'accounts'>;
  /** Without `acpAvailable`, which the route adds (it needs a load attempt). */
  readonly config: () => Omit<AdminConfig, 'acpAvailable'>;
  /** What the public config says: demo counts as on only when it can run. */
  readonly publicConfig: () => PublicConfig;
  readonly acpAgents: () => ReadonlyArray<AcpAgent>;
  readonly acpModels: () => AcpModels;
  readonly acpMaxConcurrent: () => number;
  readonly updateConfig: (change: UpdateAdminConfigRequest) => Omit<AdminConfig, 'acpAvailable'>;
  readonly users: () => ReadonlyArray<AdminUser>;
  /** Undefined when there is no such user. */
  readonly user: (userId: string) => AdminUser | undefined;
  readonly setDisabled: (userId: string, disabled: boolean) => void;
  readonly unlock: (userId: string) => void;
}

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : value === 'true';

export const makeAdmin = (
  database: ServerDatabase,
  auth: AuthService,
  defaults: SwitchDefaults,
  demo: { readonly budget: DemoBudgetService; readonly model: () => ModelRef | undefined },
  now: () => number = Date.now,
): AdminService => {
  const { db } = database;
  const q = {
    get: db.prepare('SELECT value FROM server_config WHERE key = ?'),
    put: db.prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)'),
    users: db.prepare(
      `SELECT u.id, u.email, u.role, u.disabled, u.created_at, t.locked_until
         FROM users u LEFT JOIN login_throttle t ON t.email = u.email
        ORDER BY u.created_at, u.id`,
    ),
    user: db.prepare(
      `SELECT u.id, u.email, u.role, u.disabled, u.created_at, t.locked_until
         FROM users u LEFT JOIN login_throttle t ON t.email = u.email WHERE u.id = ?`,
    ),
  };
  const read = (key: string) => (q.get.get(key) as { value: string } | undefined)?.value;

  const switches = (): Omit<PublicConfig, 'accounts'> => ({
    registration: auth.registrationMode(),
    guestMode: bool(read('guestMode'), defaults.guestMode),
    demoMode: bool(read('demoMode'), defaults.demoMode),
    figureCdn: bool(read('figureCdn'), true),
  });
  const acpAgents = (): ReadonlyArray<AcpAgent> => {
    const stored = read('acpAgents');
    return stored === undefined ? defaults.acpAgents : (JSON.parse(stored) as AcpAgent[]);
  };
  const acpModels = (): AcpModels => {
    const stored = read('acpModels');
    return stored === undefined ? defaults.acpModels : (JSON.parse(stored) as AcpModels);
  };
  const acpMaxConcurrent = () => {
    const stored = read('acpMaxConcurrent');
    return stored === undefined ? defaults.acpMaxConcurrent : Number(stored);
  };
  const config = (): Omit<AdminConfig, 'acpAvailable'> => {
    const model = demo.model();
    return {
      ...switches(),
      acpAgents: acpAgents(),
      acpModels: acpModels(),
      acpMaxConcurrent: acpMaxConcurrent(),
      demoBudget: demo.budget.status(),
      // Provider and model name only: the key never leaves the server.
      ...(model === undefined || model.provider === 'acp'
        ? {}
        : { demoModel: `${model.provider}:${model.model}` }),
    };
  };
  const publicConfig = (): PublicConfig => {
    const on = switches();
    return {
      accounts: true,
      ...on,
      demoMode: on.demoMode && demo.model() !== undefined && demo.budget.status().limit > 0,
    };
  };

  type Row = {
    id: string;
    email: string;
    role: 'admin' | 'user';
    disabled: number;
    created_at: number;
    locked_until: number | null;
  };
  const toUser = (row: Row): AdminUser => ({
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: Boolean(row.disabled),
    ...(row.locked_until !== null && row.locked_until > now()
      ? { lockedUntil: Number(row.locked_until) }
      : {}),
    createdAt: Number(row.created_at),
  });

  return {
    switches,
    config,
    publicConfig,
    acpAgents,
    acpModels,
    acpMaxConcurrent,
    updateConfig: (change) => {
      database.transaction(() => {
        if (change.registration !== undefined && registrationModes.includes(change.registration)) {
          auth.setRegistrationMode(change.registration);
        }
        if (change.guestMode !== undefined) q.put.run('guestMode', String(change.guestMode));
        if (change.demoMode !== undefined) q.put.run('demoMode', String(change.demoMode));
        if (change.figureCdn !== undefined) q.put.run('figureCdn', String(change.figureCdn));
        if (change.demoBudgetLimit !== undefined) demo.budget.setLimit(change.demoBudgetLimit);
        if (change.demoBudgetPeriod !== undefined) demo.budget.setPeriod(change.demoBudgetPeriod);
        if (change.acpAgents !== undefined) {
          q.put.run('acpAgents', JSON.stringify([...new Set(change.acpAgents)]));
        }
        if (change.acpModels !== undefined) {
          const unique: Record<string, ReadonlyArray<string>> = {};
          for (const [agent, models] of Object.entries(change.acpModels)) {
            unique[agent] = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
          }
          q.put.run('acpModels', JSON.stringify(unique));
        }
        if (change.acpMaxConcurrent !== undefined) {
          q.put.run('acpMaxConcurrent', String(change.acpMaxConcurrent));
        }
      });
      return config();
    },
    users: () => (q.users.all() as unknown as Row[]).map(toUser),
    user: (userId) => {
      const row = q.user.get(userId) as unknown as Row | undefined;
      return row === undefined ? undefined : toUser(row);
    },
    setDisabled: (userId, disabled) => auth.setDisabled(userId, disabled),
    unlock: (userId) => {
      const row = q.user.get(userId) as unknown as Row | undefined;
      if (row) auth.unlock(row.email);
    },
  };
};
