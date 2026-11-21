// Account settings (plan tai-khoan.md A5, A6): connections (provider + encrypted key) and the
// role → (connection, model) map. Every query filters by owner. A key is decrypted only in
// `resolveModel`, for a turn, and never returned by any other function.
import { randomUUID } from 'node:crypto';
import type { ModelRef } from '@kd-learn/ai/port';
import type {
  AcpAgent,
  AcpModels,
  ConnectionInfo,
  CreateConnectionRequest,
  ModelRole,
  RoleModel,
  RoleModels,
} from '@kd-learn/api';
import type { ServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { Endpoint } from '../config.ts';
import type { SecretBox } from './secret-box.ts';

export const modelRoles: ReadonlyArray<ModelRole> = ['prober', 'teacher', 'sideChat'];

export type CreateConnectionResult =
  | { readonly _tag: 'Ok'; readonly connection: ConnectionInfo }
  | { readonly _tag: 'UnknownEndpoint' }
  | { readonly _tag: 'AgentDisabled' };

export type SetRolesResult =
  | { readonly _tag: 'Ok' }
  | { readonly _tag: 'UnknownConnection' }
  /** An ACP role names a model the admin does not allow for that agent (risk 30). */
  | { readonly _tag: 'ModelNotAllowed'; readonly role: ModelRole };

export type ResolveResult =
  | { readonly _tag: 'Ok'; readonly model: ModelRef }
  | { readonly _tag: 'RoleNotConfigured'; readonly role: ModelRole }
  /** The endpoint of the connection is no longer allowed by the server. */
  | { readonly _tag: 'UnknownEndpoint'; readonly role: ModelRole }
  /** The master key changed, or the row was tampered with. */
  | { readonly _tag: 'KeyUnreadable'; readonly role: ModelRole }
  /** The ACP agent of the connection is not enabled (any more). */
  | { readonly _tag: 'AgentDisabled'; readonly role: ModelRole }
  /** The model of an ACP role is not on the admin's list (any more). */
  | { readonly _tag: 'ModelNotAllowed'; readonly role: ModelRole };

export interface SettingsService {
  readonly get: (userId: string) => {
    readonly connections: ReadonlyArray<ConnectionInfo>;
    readonly roles: RoleModels;
    readonly acpAgents: ReadonlyArray<AcpAgent>;
    readonly acpModels: AcpModels;
  };
  readonly createConnection: (
    userId: string,
    input: CreateConnectionRequest,
  ) => CreateConnectionResult;
  /** False when there is no such connection for this user. Its roles are unset. */
  readonly deleteConnection: (userId: string, connectionId: string) => boolean;
  /** Replaces the whole map. Every connection must belong to the user. */
  readonly setRoles: (userId: string, roles: RoleModels) => SetRolesResult;
  /** The model for one role, with the decrypted key. Only for running a turn; never log it. */
  readonly resolveModel: (userId: string, role: ModelRole) => ResolveResult;
}

interface ConnectionRow {
  id: string;
  label: string;
  provider: ConnectionInfo['provider'];
  endpoint_id: string | null;
  agent: string | null;
  key_sealed: string | null;
  key_version: number | null;
  key_last4: string | null;
  created_at: number;
}

/** Binds a ciphertext to its owner and row (AAD). */
const sealContext = (userId: string, connectionId: string) =>
  `connection:${userId}:${connectionId}`;

const toInfo = (row: ConnectionRow): ConnectionInfo => ({
  id: row.id,
  label: row.label,
  provider: row.provider,
  ...(row.endpoint_id === null ? {} : { endpointId: row.endpoint_id }),
  ...(row.agent === null ? {} : { agent: row.agent as AcpAgent }),
  hasKey: row.key_sealed !== null,
  ...(row.key_last4 === null ? {} : { keyLast4: row.key_last4 }),
  createdAt: Number(row.created_at),
});

export const makeSettings = (
  database: ServerDatabase,
  box: SecretBox,
  endpoints: () => ReadonlyArray<Endpoint>,
  /** ACP agents the admin enabled, read on every call. */
  acpAgents: () => ReadonlyArray<AcpAgent> = () => [],
  /** Models the admin allows per ACP agent, read on every call (risk 30). */
  acpModels: () => AcpModels = () => ({}),
  now: () => number = Date.now,
): SettingsService => {
  const { db } = database;
  const q = {
    connections: db.prepare(
      `SELECT id, label, provider, endpoint_id, agent, key_sealed, key_version, key_last4, created_at
         FROM connections WHERE user_id = ? ORDER BY created_at, id`,
    ),
    connection: db.prepare(
      `SELECT id, label, provider, endpoint_id, agent, key_sealed, key_version, key_last4, created_at
         FROM connections WHERE user_id = ? AND id = ?`,
    ),
    insert: db.prepare(
      `INSERT INTO connections
         (id, user_id, label, provider, endpoint_id, agent, key_sealed, key_version, key_last4,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    remove: db.prepare('DELETE FROM connections WHERE user_id = ? AND id = ?'),
    roles: db.prepare('SELECT role, connection_id, model FROM role_models WHERE user_id = ?'),
    role: db.prepare('SELECT connection_id, model FROM role_models WHERE user_id = ? AND role = ?'),
    clearRoles: db.prepare('DELETE FROM role_models WHERE user_id = ?'),
    putRole: db.prepare(
      'INSERT INTO role_models (user_id, role, connection_id, model) VALUES (?, ?, ?, ?)',
    ),
  };

  const modelAllowed = (agent: AcpAgent, model: string) =>
    (acpModels()[agent] ?? []).includes(model);

  const rolesOf = (userId: string): RoleModels => {
    const map: Partial<Record<ModelRole, RoleModel>> = {};
    for (const row of q.roles.all(userId) as Array<{
      role: string;
      connection_id: string;
      model: string;
    }>) {
      if (modelRoles.includes(row.role as ModelRole)) {
        map[row.role as ModelRole] = { connectionId: row.connection_id, model: row.model };
      }
    }
    return map;
  };

  return {
    get: (userId) => ({
      connections: (q.connections.all(userId) as unknown as ConnectionRow[]).map(toInfo),
      roles: rolesOf(userId),
      acpAgents: acpAgents(),
      acpModels: Object.fromEntries(
        acpAgents().map((agent) => [agent, acpModels()[agent] ?? []]),
      ) as AcpModels,
    }),

    createConnection: (userId, input) => {
      const id = randomUUID();
      if (input.provider === 'acp') {
        if (!acpAgents().includes(input.agent)) return { _tag: 'AgentDisabled' };
        q.insert.run(id, userId, input.label, 'acp', null, input.agent, null, null, null, now());
      } else {
        const endpointId = input.provider === 'openai-compatible' ? input.endpointId : null;
        if (endpointId !== null && !endpoints().some((e) => e.id === endpointId)) {
          return { _tag: 'UnknownEndpoint' };
        }
        const sealed = box.seal(input.apiKey, sealContext(userId, id));
        const last4 = input.apiKey.length >= 12 ? input.apiKey.slice(-4) : null;
        q.insert.run(
          id,
          userId,
          input.label,
          input.provider,
          endpointId,
          null,
          sealed,
          box.version,
          last4,
          now(),
        );
      }
      const row = q.connection.get(userId, id) as unknown as ConnectionRow;
      return { _tag: 'Ok', connection: toInfo(row) };
    },

    deleteConnection: (userId, connectionId) =>
      Number(q.remove.run(userId, connectionId).changes) > 0,

    setRoles: (userId, roles) =>
      (() => {
        try {
          return database.transaction((): SetRolesResult => {
            q.clearRoles.run(userId);
            for (const role of modelRoles) {
              const choice = roles[role];
              if (choice === undefined) continue;
              const row = q.connection.get(userId, choice.connectionId) as unknown as
                ConnectionRow | undefined;
              if (row === undefined) throw new UnknownConnection();
              if (row.provider === 'acp' && !modelAllowed(row.agent as AcpAgent, choice.model)) {
                throw new ModelNotAllowed(role);
              }
              q.putRole.run(userId, role, choice.connectionId, choice.model);
            }
            return { _tag: 'Ok' };
          });
        } catch (error) {
          if (error instanceof UnknownConnection) return { _tag: 'UnknownConnection' } as const;
          if (error instanceof ModelNotAllowed) {
            return { _tag: 'ModelNotAllowed', role: error.role } as const;
          }
          throw error;
        }
      })(),

    resolveModel: (userId, role) => {
      const choice = q.role.get(userId, role) as
        { connection_id: string; model: string } | undefined;
      const row =
        choice === undefined
          ? undefined
          : (q.connection.get(userId, choice.connection_id) as unknown as
              ConnectionRow | undefined);
      if (choice === undefined || row === undefined) return { _tag: 'RoleNotConfigured', role };
      if (row.provider === 'acp') {
        const agent = row.agent as AcpAgent;
        // Checked per turn: the admin may disable an agent after the connection was made.
        if (!acpAgents().includes(agent)) return { _tag: 'AgentDisabled', role };
        // Also per turn: the admin may take a model off the list later.
        if (!modelAllowed(agent, choice.model)) return { _tag: 'ModelNotAllowed', role };
        return { _tag: 'Ok', model: { provider: 'acp', agent, model: choice.model } };
      }
      const apiKey =
        row.key_sealed === null || row.key_version === null
          ? undefined
          : box.open(row.key_sealed, Number(row.key_version), sealContext(userId, row.id));
      if (apiKey === undefined) return { _tag: 'KeyUnreadable', role };
      switch (row.provider) {
        case 'anthropic':
        case 'gemini':
          return { _tag: 'Ok', model: { provider: row.provider, model: choice.model, apiKey } };
        case 'openai-compatible': {
          const endpoint = endpoints().find((e) => e.id === row.endpoint_id);
          if (endpoint === undefined) return { _tag: 'UnknownEndpoint', role };
          return {
            _tag: 'Ok',
            model: {
              provider: 'openai-compatible',
              model: choice.model,
              apiKey,
              baseURL: endpoint.baseURL,
            },
          };
        }
      }
    },
  };
};

class UnknownConnection extends Error {}
class ModelNotAllowed extends Error {
  constructor(readonly role: ModelRole) {
    super('model not allowed');
  }
}
