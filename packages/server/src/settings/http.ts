// `/api/account/*` (plan step 3): settings of the signed-in user. One handler routes by path, so
// the host mounts a single catch-all route. Keys never appear in a response or a log line.
import { Effect, Result, Schema } from 'effect';
import {
  AccountSettings,
  Appearance,
  AppearanceResponse,
  ConnectionInfo,
  CreateConnectionRequest,
  ErrorCode,
  ExtractSessionRequest,
  GraphView,
  toGraphView,
  ExtractionList,
  MAX_PROFILE_BODY_BYTES,
  ProfileRequest,
  ProfileResponse,
  SetRolesRequest,
} from '@kd-learn/api';
import { projectKnowledge } from '@kd-learn/core';
import { appendKnowledgeChecked } from '@kd-learn/storage/port';
import { activeProfile } from '../profile.ts';
import type { Handler, Logger } from '../handler.ts';
import { SECURITY_HEADERS } from '../http.ts';
import type { Ctx, makeRouteKit } from '../routes.ts';
import type { CurrentUser } from '../auth/service.ts';
import { makeSessionsHandler, modelUnavailable } from '../sessions/http.ts';
import { makePracticeAccountHandler } from '../practice/http.ts';
import { makeSourcesHandler } from '../sources/http.ts';
import { makeFiguresHandler } from '../figures/http.ts';

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
      if (result._tag === 'RoleNotSupported') {
        return ctx.reject(
          409,
          ErrorCode.RoleNotSupported,
          `This connection cannot serve the role ${result.role}: it needs Gemini or an endpoint with images.`,
        );
      }
      return json(ctx, Schema.encodeSync(AccountSettings)(ctx.accounts.settings.get(user.id)));
    }),
  );

  /** `GET` and `PUT` of the appearance (phase 6 A3). */
  const appearance = route('account.appearance', ['GET', 'PUT'], (ctx) =>
    signedIn(ctx, async (user) => {
      const service = ctx.accounts.settings;
      if (ctx.request.method === 'PUT') {
        const input = await decode(ctx, Appearance);
        if (input instanceof Response) return input;
        service.setAppearance(user.id, input);
      }
      return json(
        ctx,
        Schema.encodeSync(AppearanceResponse)({ appearance: service.appearance(user.id) }),
      );
    }),
  );

  /** `GET`, `PUT` and `DELETE` of the teaching profile (phase 3 A2), all through `forUser`. */
  const profile = route('account.profile', ['GET', 'PUT', 'DELETE'], (ctx) =>
    signedIn(ctx, async (user) => {
      const storage = ctx.accounts.storage.forUser(user.id);
      const method = ctx.request.method;
      if (method === 'PUT') {
        const input = await decode(ctx, ProfileRequest, MAX_PROFILE_BODY_BYTES);
        if (input instanceof Response) return input;
        await Effect.runPromise(storage.saveProfile(input.profile));
        log({ event: 'account.profile.saved', fields: {} });
      } else if (method === 'DELETE') {
        await Effect.runPromise(storage.saveProfile(undefined));
        log({ event: 'account.profile.reset', fields: {} });
      }
      const active = await Effect.runPromise(activeProfile(storage));
      return json(ctx, Schema.encodeSync(ProfileResponse)(active));
    }),
  );

  /** `GET`: extraction state of every session. `POST`: extract now, or retry (phase 3 A3). */
  const extractions = route('account.extractions', ['GET', 'POST'], (ctx) =>
    signedIn(ctx, async (user) => {
      const jobs = ctx.accounts.extractions;
      if (ctx.request.method === 'POST') {
        const input = await decode(ctx, ExtractSessionRequest);
        if (input instanceof Response) return input;
        const result = jobs.request(user.id, input.sessionId);
        switch (result._tag) {
          case 'NotFound':
            return notFound(ctx);
          case 'InProgress':
            return ctx.reject(
              409,
              ErrorCode.ExtractionInProgress,
              'This session is already being extracted.',
              true,
            );
          case 'NothingToRun':
            return ctx.reject(409, ErrorCode.NothingToRun, result.message);
          case 'ModelUnavailable':
            return modelUnavailable(ctx, result.result);
          case 'Ok':
            break;
        }
        return json(ctx, Schema.encodeSync(ExtractionList)({ sessions: jobs.list(user.id) }), 202);
      }
      return json(ctx, Schema.encodeSync(ExtractionList)({ sessions: jobs.list(user.id) }));
    }),
  );

  const decodeSegment = (segment: string) => {
    try {
      const id = decodeURIComponent(segment);
      return id === '' ? undefined : id;
    } catch {
      return undefined;
    }
  };

  /** `GET`: the graph without exercises, so no answer leaks (phase 3 A9). */
  const knowledge = route('account.knowledge', ['GET'], (ctx) =>
    signedIn(ctx, async (user) => {
      const storage = ctx.accounts.storage.forUser(user.id);
      const projected = projectKnowledge(await Effect.runPromise(storage.readKnowledge));
      if (Result.isFailure(projected)) {
        return ctx.reject(500, ErrorCode.Internal, 'The knowledge graph cannot be read.');
      }
      return json(ctx, Schema.encodeSync(GraphView)(toGraphView(projected.success)));
    }),
  );

  /** The learner drops a wrong proposition (`PropositionRetired`, A1). */
  const retire = (propositionId: string) =>
    route('account.knowledge.retire', ['POST'], (ctx) =>
      signedIn(ctx, async (user) => {
        const storage = ctx.accounts.storage.forUser(user.id);
        let found = false;
        const written = await Effect.runPromise(
          appendKnowledgeChecked(storage, (graph) => {
            found = graph.propositions[propositionId] !== undefined;
            return found
              ? [
                  {
                    _tag: 'PropositionRetired',
                    id: crypto.randomUUID(),
                    at: Date.now(),
                    propositionId,
                  },
                ]
              : [];
          }).pipe(Effect.result),
        );
        if (Result.isFailure(written)) {
          return ctx.reject(409, ErrorCode.Conflict, 'The graph changed. Try again.', true);
        }
        if (!found) return notFound(ctx);
        log({ event: 'account.knowledge.retired', fields: {} });
        return json(ctx, Schema.encodeSync(GraphView)(toGraphView(written.success.graph)));
      }),
    );

  const sessions = makeSessionsHandler(kit, log);
  const practice = makePracticeAccountHandler(kit, log);
  const sourced = makeSourcesHandler(kit, log);
  const figured = makeFiguresHandler(kit, log);

  const fallback = route('account', ['GET', 'POST', 'PUT', 'DELETE'], notFound);

  return (request, context) => {
    const path = new URL(request.url).pathname.slice(ACCOUNT_PREFIX.length).replace(/\/+$/, '');
    if (path === 'settings') return settings(request, context);
    if (path === 'connections') return createConnection(request, context);
    const one = /^connections\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (one?.[1] !== undefined) return deleteConnection(one[1])(request, context);
    if (path === 'roles') return setRoles(request, context);
    if (path === 'profile') return profile(request, context);
    if (path === 'appearance') return appearance(request, context);
    if (path === 'knowledge/extractions') return extractions(request, context);
    if (path === 'knowledge') return knowledge(request, context);
    // Any non-empty string is a proposition id (core `PropositionId`): the client encodes it.
    const retired = /^knowledge\/propositions\/([^/]{1,512})\/retire$/.exec(path);
    if (retired?.[1] !== undefined) {
      const id = decodeSegment(retired[1]);
      return id === undefined ? fallback(request, context) : retire(id)(request, context);
    }
    const session = sessions(path);
    if (session !== undefined) return session(request, context);
    const source = sourced(path);
    if (source !== undefined) return source(request, context);
    const figure = figured(path);
    if (figure !== undefined) return figure(request, context);
    const practiced = practice(path);
    if (practiced !== undefined) return practiced(request, context);
    return fallback(request, context);
  };
};
