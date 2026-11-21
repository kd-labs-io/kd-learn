// `/api/account/*` (plan step 3): settings of the signed-in user. One handler routes by path, so
// the host mounts a single catch-all route. Keys never appear in a response or a log line.
import { Schema } from 'effect';
import {
  AccountSettings,
  ConnectionInfo,
  CreateConnectionRequest,
  ErrorCode,
  SetRolesRequest,
} from '@kd-learn/api';
import type { Handler, Logger } from '../handler.ts';
import { SECURITY_HEADERS } from '../http.ts';
import type { Ctx, makeRouteKit } from '../routes.ts';
import type { CurrentUser } from '../auth/service.ts';
import { makeSessionsHandler } from '../sessions/http.ts';

type Kit = ReturnType<typeof makeRouteKit>;

export const ACCOUNT_PREFIX = '/api/account/';

export const makeSettingsHandler = (kit: Kit, log: Logger): Handler => {
  const { route, json, decode, currentUser, unauthorized } = kit;

  const signedIn = (ctx: Ctx, run: (user: CurrentUser) => Promise<Response> | Response) => {
    const user = currentUser(ctx);
    return user === undefined ? unauthorized(ctx) : run(user);
  };

  const notFound = (ctx: Ctx) => ctx.reject(404, ErrorCode.NotFound, 'Not found.');

  const settings = route('account.settings', ['GET'], (ctx) =>
    signedIn(ctx, (user) =>
      json(ctx, Schema.encodeSync(AccountSettings)(ctx.accounts.settings.get(user.id))),
    ),
  );

  const createConnection = route('account.connections', ['POST'], (ctx) =>
    signedIn(ctx, async (user) => {
      const input = await decode(ctx, CreateConnectionRequest);
      if (input instanceof Response) return input;
      const result = ctx.accounts.settings.createConnection(user.id, input);
      if (result._tag === 'AgentDisabled') {
        return ctx.reject(
          409,
          ErrorCode.AcpAgentDisabled,
          'This agent is not enabled on this server.',
        );
      }
      if (result._tag === 'UnknownEndpoint') {
        return ctx.reject(
          400,
          ErrorCode.UnknownEndpoint,
          'This endpoint id is not allowed on this server.',
        );
      }
      log({ event: 'account.connection.created', fields: { provider: input.provider } });
      return json(ctx, Schema.encodeSync(ConnectionInfo)(result.connection), 201);
    }),
  );

  const deleteConnection = (id: string) =>
    route('account.connection', ['DELETE'], (ctx) =>
      signedIn(ctx, (user) => {
        if (!ctx.accounts.settings.deleteConnection(user.id, id)) return notFound(ctx);
        log({ event: 'account.connection.deleted', fields: {} });
        return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...ctx.cors } });
      }),
    );

  const setRoles = route('account.roles', ['PUT'], (ctx) =>
    signedIn(ctx, async (user) => {
      const input = await decode(ctx, SetRolesRequest);
      if (input instanceof Response) return input;
      const result = ctx.accounts.settings.setRoles(user.id, input.roles);
      // Another user's connection id looks like one that does not exist (plan A3).
      if (result._tag === 'UnknownConnection') return notFound(ctx);
      if (result._tag === 'ModelNotAllowed') {
        return ctx.reject(
          409,
          ErrorCode.AcpModelNotAllowed,
          `The admin does not allow this model for the agent of the role ${result.role}.`,
        );
      }
      return json(ctx, Schema.encodeSync(AccountSettings)(ctx.accounts.settings.get(user.id)));
    }),
  );

  const sessions = makeSessionsHandler(kit, log);

  const fallback = route('account', ['GET', 'POST', 'PUT', 'DELETE'], notFound);

  return (request, context) => {
    const path = new URL(request.url).pathname.slice(ACCOUNT_PREFIX.length).replace(/\/+$/, '');
    if (path === 'settings') return settings(request, context);
    if (path === 'connections') return createConnection(request, context);
    const one = /^connections\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (one?.[1] !== undefined) return deleteConnection(one[1])(request, context);
    if (path === 'roles') return setRoles(request, context);
    const session = sessions(path);
    if (session !== undefined) return session(request, context);
    return fallback(request, context);
  };
};
