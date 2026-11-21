// Account routes (plan step 2): register, login, logout, me, and invites for admins.
// Logs carry codes and statuses only: never an email, password, token or invite code.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Effect, Result, Schema } from 'effect';
import {
  AuthResponse,
  CreateInviteRequest,
  ErrorCode,
  InviteResponse,
  LoginRequest,
  MeResponse,
  RegisterRequest,
} from '@kd-learn/api';
import { openServerDatabase, type ServerDatabase } from '@kd-learn/storage/sqlite-node';
import type { ServerConfig } from '../config.ts';
import type { Handler, Logger, RequestContext } from '../handler.ts';
import { SECURITY_HEADERS, corsHeaders, failureResponse, readLimited } from '../http.ts';
import { describeIssue } from '../safety.ts';
import { clientAddress, type AccountConfig } from './config.ts';
import { makeRateLimiter, type RateLimiter } from './rate-limit.ts';
import { makeAuth, type AuthOptions, type AuthService, type CurrentUser } from './service.ts';

/** Bodies of account requests are small. */
const MAX_BODY_BYTES = 16 * 1024;
const HOUR = 60 * 60 * 1000;

export interface Accounts {
  readonly database: ServerDatabase;
  readonly auth: AuthService;
}

/**
 * Opens the database and creates the first admin. Called once per process; the handlers wait for
 * it. `database` replaces the file in tests.
 */
export const initAccounts = async (
  config: AccountConfig,
  options: {
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
  return { database, auth };
};

export interface AccountHandlers {
  readonly register: Handler;
  readonly login: Handler;
  readonly logout: Handler;
  readonly me: Handler;
  readonly invites: Handler;
}

/** `Authorization: Bearer <token>`, or undefined. */
export const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header.trim());
  return match?.[1];
};

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

  type Ctx = {
    readonly request: Request;
    readonly cors: Record<string, string>;
    readonly address: string | undefined;
    readonly accounts: Accounts;
    readonly reject: (
      status: number,
      code: string,
      message: string,
      retryable?: boolean,
    ) => Response;
  };

  const route =
    (
      name: string,
      methods: ReadonlyArray<string>,
      body: (ctx: Ctx) => Promise<Response> | Response,
    ): Handler =>
    async (request, context?: RequestContext) => {
      const cors = corsHeaders(request, config);
      const reject = (status: number, code: string, message: string, retryable = false) => {
        log({ event: `${name}.rejected`, fields: { status, code } });
        return failureResponse(status, code, message, retryable, cors);
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (!methods.includes(request.method)) {
        return reject(405, ErrorCode.MethodNotAllowed, `Use ${methods.join(' or ')}.`);
      }
      let ready: Accounts;
      try {
        ready = await accounts();
      } catch {
        return failureResponse(
          500,
          ErrorCode.Misconfigured,
          'Accounts are not available on this server.',
          false,
          cors,
        );
      }
      const address = clientAddress(request, context?.clientAddress, accountConfig.trustProxy);
      return body({ request, cors, address, accounts: ready, reject });
    };

  const json = (ctx: Ctx, value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...ctx.cors },
    });

  /** Decodes a JSON body; the error message comes from paths and codes, never from values. */
  const decode = async <S extends Schema.Top>(
    ctx: Ctx,
    schema: S,
  ): Promise<S['Type'] | Response> => {
    const body = await readLimited(ctx.request, MAX_BODY_BYTES);
    if (body === 'too-large')
      return ctx.reject(413, ErrorCode.InvalidRequest, 'The request is too large.');
    if (body === 'unreadable') {
      return ctx.reject(400, ErrorCode.InvalidRequest, 'The request body is not readable UTF-8.');
    }
    let value: unknown;
    try {
      value = body.text === '' ? {} : JSON.parse(body.text);
    } catch {
      return ctx.reject(400, ErrorCode.InvalidRequest, 'The request body is not valid JSON.');
    }
    const decoded = Schema.decodeUnknownResult(schema as never)(value, {
      onExcessProperty: 'error',
    });
    if (Result.isFailure(decoded)) {
      return ctx.reject(400, ErrorCode.InvalidRequest, describeIssue(decoded.failure as never));
    }
    return decoded.success as S['Type'];
  };

  const currentUser = (ctx: Ctx): CurrentUser | undefined => {
    const token = bearerToken(ctx.request);
    return token === undefined ? undefined : ctx.accounts.auth.authenticate(token);
  };

  const unauthorized = (ctx: Ctx) => ctx.reject(401, ErrorCode.Unauthorized, 'Sign in again.');

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
