// `/api/admin/*` (except invites, see auth/http.ts) and the public `GET /api/config`.
// Admins only, checked on every request; a non-admin gets 403, no token 401.
import { Schema } from 'effect';
import {
  AdminConfig,
  AdminSearchConfig,
  AdminUser,
  AdminUserList,
  ErrorCode,
  PublicConfig,
  UpdateAdminConfigRequest,
  UpdateAdminSearchRequest,
  UpdateUserRequest,
} from '@kd-learn/api';
import type { Handler, Logger } from '../handler.ts';
import type { Ctx, makeRouteKit } from '../routes.ts';
import type { CurrentUser } from '../auth/service.ts';

type Kit = ReturnType<typeof makeRouteKit>;

export const ADMIN_PREFIX = '/api/admin/';

export const makeAdminHandlers = (kit: Kit, log: Logger): { admin: Handler; config: Handler } => {
  const { route, json, decode, currentUser, unauthorized } = kit;

  const asAdmin = (ctx: Ctx, run: (user: CurrentUser) => Promise<Response> | Response) => {
    const user = currentUser(ctx);
    if (user === undefined) return unauthorized(ctx);
    if (user.role !== 'admin') return ctx.reject(403, ErrorCode.Forbidden, 'Admins only.');
    return run(user);
  };
  const notFound = (ctx: Ctx) => ctx.reject(404, ErrorCode.NotFound, 'Not found.');

  const config = route('admin.config', ['GET', 'PUT'], (ctx) =>
    asAdmin(ctx, async () => {
      // The adapter is loaded only while some agent is enabled (it resolves binaries on load).
      const availability = async (agents: ReadonlyArray<unknown>) =>
        agents.length === 0 ? true : ctx.accounts.acpAvailable();
      if (ctx.request.method === 'GET') {
        const current = ctx.accounts.admin.config();
        const acpAvailable = await availability(current.acpAgents);
        return json(ctx, Schema.encodeSync(AdminConfig)({ ...current, acpAvailable }));
      }
      const change = await decode(ctx, UpdateAdminConfigRequest);
      if (change instanceof Response) return change;
      const next = ctx.accounts.admin.updateConfig(change);
      log({
        event: 'admin.config',
        fields: {
          registration: next.registration,
          guestMode: next.guestMode,
          demoMode: next.demoMode,
          figureCdn: next.figureCdn,
          demoBudgetLimit: next.demoBudget.limit,
          demoBudgetPeriod: next.demoBudget.period,
          acpAgents: next.acpAgents.join(','),
          acpModels: Object.values(next.acpModels).reduce((n, list) => n + list.length, 0),
          acpMaxConcurrent: next.acpMaxConcurrent,
        },
      });
      const acpAvailable = await availability(next.acpAgents);
      return json(ctx, Schema.encodeSync(AdminConfig)({ ...next, acpAvailable }));
    }),
  );

  // Search sources (phase 4 A6). The Exa key goes in, never out; the log says only what changed.
  const search = route('admin.search', ['GET', 'PUT'], (ctx) =>
    asAdmin(ctx, async () => {
      if (ctx.request.method === 'GET') {
        return json(ctx, Schema.encodeSync(AdminSearchConfig)(ctx.accounts.search.config()));
      }
      const change = await decode(ctx, UpdateAdminSearchRequest);
      if (change instanceof Response) return change;
      const next = ctx.accounts.search.update(change);
      log({
        event: 'admin.search',
        fields: {
          searxng: next.searxng.enabled,
          exa: next.exa.enabled,
          exaKey: change.exaKey === undefined ? 'kept' : change.exaKey === null ? 'removed' : 'set',
          guest: next.guest,
          demo: next.demo,
        },
      });
      return json(ctx, Schema.encodeSync(AdminSearchConfig)(next));
    }),
  );

  const users = route('admin.users', ['GET'], (ctx) =>
    asAdmin(ctx, () =>
      json(ctx, Schema.encodeSync(AdminUserList)({ users: ctx.accounts.admin.users() })),
    ),
  );

  const user = (userId: string) =>
    route('admin.user', ['PATCH'], (ctx) =>
      asAdmin(ctx, async (self) => {
        const change = await decode(ctx, UpdateUserRequest);
        if (change instanceof Response) return change;
        const admin = ctx.accounts.admin;
        if (admin.user(userId) === undefined) return notFound(ctx);
        if (change.disabled === true && userId === self.id) {
          return ctx.reject(409, ErrorCode.Conflict, 'You cannot disable your own account.');
        }
        if (change.disabled !== undefined) admin.setDisabled(userId, change.disabled);
        if (change.unlock === true) admin.unlock(userId);
        log({
          event: 'admin.user',
          fields: {
            ...(change.disabled === undefined ? {} : { disabled: change.disabled }),
            ...(change.unlock === undefined ? {} : { unlock: true }),
          },
        });
        return json(ctx, Schema.encodeSync(AdminUser)(admin.user(userId)!));
      }),
    );

  const fallback = route('admin', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], (ctx) =>
    asAdmin(ctx, () => notFound(ctx)),
  );

  const admin: Handler = (request, context) => {
    const path = new URL(request.url).pathname.slice(ADMIN_PREFIX.length).replace(/\/+$/, '');
    if (path === 'config') return config(request, context);
    if (path === 'users') return users(request, context);
    if (path === 'search') return search(request, context);
    const one = /^users\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (one?.[1] !== undefined) return user(one[1])(request, context);
    return fallback(request, context);
  };

  const publicConfig = route('config', ['GET'], (ctx) => {
    return json(ctx, Schema.encodeSync(PublicConfig)(ctx.accounts.admin.publicConfig()));
  });

  return { admin, config: publicConfig };
};
