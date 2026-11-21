// Account routes (plan step 2): register, login, logout, me, and invites for admins.
// Logs carry codes and statuses only: never an email, password, token or invite code.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Effect, Schema } from 'effect';
import type { Layer } from 'effect';
import type { AiPort } from '@kd-learn/ai/port';
import {
  AuthResponse,
  CreateInviteRequest,
  ErrorCode,
  InviteResponse,
  LoginRequest,
  MeResponse,
  RegisterRequest,
} from '@kd-learn/api';
import {
  makeServerStorage,
  openServerDatabase,
  type ServerDatabase,
  type ServerStorage,
} from '@kd-learn/storage/sqlite-node';
import { makeSessionRunner, type SessionRunner } from '../sessions/runner.ts';
import { makeExtractionJobs, type ExtractionJobs } from '../knowledge/jobs.ts';
import { makeAdmin, type AdminService } from '../admin/service.ts';
import { makeDemoBudget } from '../demo/budget.ts';
import { makeLazyAcp, routedAi } from '../acp/router.ts';
import { demoGate, resolveDemoModel, type DemoGate } from '../demo/service.ts';
import type { Endpoint, ServerConfig } from '../config.ts';
import { makeSecretBox } from '../settings/secret-box.ts';
import { makeSettings, type SettingsService } from '../settings/service.ts';
import type { Handler, Logger } from '../handler.ts';
import { SECURITY_HEADERS } from '../http.ts';
import { bearerToken, makeRouteKit, type Ctx } from '../routes.ts';
import type { AccountConfig } from './config.ts';
import { makeRateLimiter, type RateLimiter } from './rate-limit.ts';
import { makeAuth, type AuthOptions, type AuthService } from './service.ts';

const HOUR = 60 * 60 * 1000;

export interface Accounts {
  readonly database: ServerDatabase;
  /** The storage port per user (`forUser`): the only way to reach a user's sessions or profile. */
  readonly storage: ServerStorage;
  readonly auth: AuthService;
  readonly settings: SettingsService;
  readonly sessions: SessionRunner;
  /** Extraction jobs of account sessions (phase 3 A3). */
  readonly extractions: ExtractionJobs;
  readonly admin: AdminService;
  /** Checked on every demo request: the admin may change the switch or the budget. */
  readonly demo: () => DemoGate;
  /** Whether this build can load the ACP adapter. */
  readonly acpAvailable: () => Promise<boolean>;
}

/**
 * Opens the database and creates the first admin. Called once per process; the handlers wait for
 * it. `database` replaces the file in tests.
 */
export const initAccounts = async (
  config: AccountConfig,
  options: {
    readonly endpoints: () => ReadonlyArray<Endpoint>;
    readonly ai: Layer.Layer<AiPort>;
    /** The ACP adapter; tests pass a fake. */
    readonly acp?: Layer.Layer<AiPort>;
    readonly turnTimeoutMs?: number;
    readonly database?: ServerDatabase;
    readonly auth?: AuthOptions;
    readonly log: Logger;
  },
): Promise<Accounts> => {
  let database = options.database;
  if (database === undefined) {
    if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
    database = await Effect.runPromise(openServerDatabase({ path: config.dbPath }));
  }
  const auth = makeAuth(database, { defaultRegistration: config.registration, ...options.auth });
  if (config.admin) {
    const outcome = await auth.ensureAdmin(config.admin.email, config.admin.password);
    options.log({ event: 'accounts.admin', fields: { outcome } });
  }
  const budget = makeDemoBudget(database, config.demo);
  const demoModel = () => resolveDemoModel(config.demo.model, options.endpoints());
  const admin = makeAdmin(
    database,
    auth,
    {
      registration: config.registration,
      guestMode: config.guestMode,
      demoMode: config.demoMode,
      acpAgents: config.acpAgents,
      acpModels: config.acpModels,
      acpMaxConcurrent: config.acpMaxConcurrent,
    },
    { budget, model: demoModel },
  );
  const demo = () => demoGate(admin.switches().demoMode, demoModel(), budget);
  const box = makeSecretBox(new Map([[1, config.masterKey]]), 1);
  const settings = makeSettings(database, box, options.endpoints, admin.acpAgents, admin.acpModels);
  const lazyAcp = options.acp === undefined ? makeLazyAcp(options.log) : undefined;
  const storage = makeServerStorage(database);
  const ai = routedAi({
    api: options.ai,
    acp: options.acp ?? lazyAcp!.layer,
    maxConcurrent: admin.acpMaxConcurrent,
  });
  const extractions = makeExtractionJobs({ storage, settings, ai, log: options.log });
  // No job survives a restart (A3): attempts left open by the last process are interrupted.
  extractions.recoverInterrupted(storage.extractionOwners());
  const sessions = makeSessionRunner({
    storage,
    settings,
    ai,
    log: options.log,
    onSessionCompleted: extractions.sessionCompleted,
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
  });
  const acpAvailable = lazyAcp === undefined ? () => Promise.resolve(true) : lazyAcp.available;
  return {
    database,
    storage,
    auth,
    settings,
    sessions,
    extractions,
    admin,
    demo,
    acpAvailable,
  };
};

export interface AccountHandlers {
  readonly register: Handler;
  readonly login: Handler;
  readonly logout: Handler;
  readonly me: Handler;
  readonly invites: Handler;
}

export const makeAccountHandlers = (
  accounts: () => Promise<Accounts>,
  config: ServerConfig,
  accountConfig: AccountConfig,
  log: Logger,
  limits: { readonly login?: RateLimiter; readonly register?: RateLimiter } = {},
): AccountHandlers => {
  // Per client address. Failed logins: 30 per 15 minutes. Registrations: 10 per hour.
  const loginLimit = limits.login ?? makeRateLimiter({ limit: 30, windowMs: HOUR / 4 });
  const registerLimit = limits.register ?? makeRateLimiter({ limit: 10, windowMs: HOUR });

  const { route, json, decode, currentUser, unauthorized } = makeRouteKit({
    accounts,
    config,
    accountConfig,
    log,
  });

  const tooMany = (ctx: Ctx) =>
    ctx.reject(429, ErrorCode.TooManyAttempts, 'Too many attempts. Try again later.', true);

  const issued = (ctx: Ctx, result: AuthResponse, status = 200) =>
    json(ctx, Schema.encodeSync(AuthResponse)(result), status);

  return {
    register: route('auth.register', ['POST'], async (ctx) => {
      if (ctx.address !== undefined && registerLimit.blocked(ctx.address)) return tooMany(ctx);
      if (ctx.address !== undefined) registerLimit.hit(ctx.address);
      const input = await decode(ctx, RegisterRequest);
      if (input instanceof Response) return input;
      const result = await ctx.accounts.auth.register(input);
      switch (result._tag) {
        case 'Ok':
          log({ event: 'auth.registered', fields: { role: result.user.role } });
          return issued(ctx, result, 201);
        case 'RegistrationClosed':
          return ctx.reject(
            403,
            ErrorCode.RegistrationClosed,
            'Registration is closed on this server.',
          );
        case 'InvalidInvite':
          return ctx.reject(
            403,
            ErrorCode.InvalidInvite,
            'The invite code is missing, used or expired.',
          );
        case 'EmailTaken':
          return ctx.reject(
            409,
            ErrorCode.EmailTaken,
            'An account with this email already exists.',
          );
      }
    }),

    login: route('auth.login', ['POST'], async (ctx) => {
      if (ctx.address !== undefined && loginLimit.blocked(ctx.address)) return tooMany(ctx);
      const input = await decode(ctx, LoginRequest);
      if (input instanceof Response) return input;
      const result = await ctx.accounts.auth.login(input);
      if (result._tag !== 'Ok' && ctx.address !== undefined) loginLimit.hit(ctx.address);
      switch (result._tag) {
        case 'Ok':
          log({ event: 'auth.login', fields: { role: result.user.role } });
          return issued(ctx, result);
        case 'InvalidCredentials':
          return ctx.reject(401, ErrorCode.InvalidCredentials, 'Wrong email or password.');
        case 'TooManyAttempts':
          return tooMany(ctx);
        case 'AccountDisabled':
          return ctx.reject(403, ErrorCode.AccountDisabled, 'This account is disabled.');
      }
    }),

    logout: route('auth.logout', ['POST'], (ctx) => {
      const token = bearerToken(ctx.request);
      if (token !== undefined) ctx.accounts.auth.logout(token);
      // Idempotent: logging out twice, or with a dead token, is still a success.
      return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...ctx.cors } });
    }),

    me: route('auth.me', ['GET'], (ctx) => {
      const user = currentUser(ctx);
      if (user === undefined) return unauthorized(ctx);
      return json(ctx, Schema.encodeSync(MeResponse)({ user }));
    }),

    invites: route('admin.invites', ['POST'], async (ctx) => {
      const user = currentUser(ctx);
      if (user === undefined) return unauthorized(ctx);
      if (user.role !== 'admin') return ctx.reject(403, ErrorCode.Forbidden, 'Admins only.');
      const input = await decode(ctx, CreateInviteRequest);
      if (input instanceof Response) return input;
      const invite = ctx.accounts.auth.createInvite(user.id, (input.expiresInHours ?? 72) * HOUR);
      log({ event: 'admin.invite', fields: { hours: input.expiresInHours ?? 72 } });
      return json(ctx, Schema.encodeSync(InviteResponse)(invite), 201);
    }),
  };
};

export { bearerToken } from '../routes.ts';
