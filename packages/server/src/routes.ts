// Building blocks of the account routes: method check, account readiness, client address, JSON
// body decoding, the current user. Logs carry codes and statuses only.
import { Result, Schema } from 'effect';
import { ErrorCode } from '@kd-learn/api';
import type { AccountConfig } from './auth/config.ts';
import { clientAddress } from './auth/config.ts';
import type { Accounts } from './auth/http.ts';
import type { CurrentUser } from './auth/service.ts';
import type { ServerConfig } from './config.ts';
import type { Handler, Logger, RequestContext } from './handler.ts';
import { SECURITY_HEADERS, corsHeaders, failureResponse, readLimited } from './http.ts';
import { describeIssue } from './safety.ts';

/** Bodies of account requests are small. */
const MAX_BODY_BYTES = 16 * 1024;

/** `Authorization: Bearer <token>`, or undefined. */
export const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header.trim());
  return match?.[1];
};

export type Ctx = {
  readonly request: Request;
  readonly cors: Record<string, string>;
  readonly address: string | undefined;
  readonly accounts: Accounts;
  readonly reject: (status: number, code: string, message: string, retryable?: boolean) => Response;
};

export const makeRouteKit = (deps: {
  readonly accounts: () => Promise<Accounts>;
  readonly config: ServerConfig;
  readonly accountConfig: AccountConfig;
  readonly log: Logger;
}) => {
  const { accounts, config, accountConfig, log } = deps;

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
    maxBytes = MAX_BODY_BYTES,
  ): Promise<S['Type'] | Response> => {
    const body = await readLimited(ctx.request, maxBytes);
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

  return { route, json, decode, currentUser, unauthorized };
};
