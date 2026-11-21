// `/api/account/sessions/*` (plan tai-khoan.md A2). See the path table in @kd-learn/api.
// Every route answers 404 for a session of another user, before any write.
import { Schema } from 'effect';
import {
  CreateSessionRequest,
  CreateSessionResponse,
  ErrorCode,
  SessionList,
  SessionSnapshot,
  SkipStepRequest,
  StartTurnRequest,
  StartTurnResponse,
  encodeAccountFrame,
} from '@kd-learn/api';
import type { AccountFrame } from '@kd-learn/api';
import type { EventLog } from '@kd-learn/core';
import type { Handler, Logger } from '../handler.ts';
import { SECURITY_HEADERS } from '../http.ts';
import type { Ctx, makeRouteKit } from '../routes.ts';
import type { CurrentUser } from '../auth/service.ts';
import type { SessionSignal, StartResult } from './runner.ts';

type Kit = ReturnType<typeof makeRouteKit>;

const ID = '[A-Za-z0-9_-]{1,64}';
const encoder = new TextEncoder();
/** Keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 15_000;

const sequenced = (log: EventLog, after: number) =>
  log.slice(after + 1).map((event, i) => ({ seq: after + 1 + i, event }));

export const makeSessionsHandler = (kit: Kit, log: Logger) => {
  const { route, json, decode, currentUser, unauthorized } = kit;

  const signedIn = (ctx: Ctx, run: (user: CurrentUser) => Promise<Response> | Response) => {
    const user = currentUser(ctx);
    return user === undefined ? unauthorized(ctx) : run(user);
  };
  const notFound = (ctx: Ctx) => ctx.reject(404, ErrorCode.NotFound, 'Not found.');
  const noContent = (ctx: Ctx) =>
    new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...ctx.cors } });

  const startFailure = (ctx: Ctx, result: Exclude<StartResult, { _tag: 'Ok' }>) => {
    switch (result._tag) {
      case 'NotFound':
        return notFound(ctx);
      case 'TurnInProgress':
        return ctx.reject(409, ErrorCode.TurnInProgress, 'A turn is already running here.', true);
      case 'NothingToRun':
        return ctx.reject(409, ErrorCode.NothingToRun, result.message);
      case 'InvalidLog':
        return ctx.reject(500, ErrorCode.InvalidTurn, result.message);
      case 'ModelUnavailable':
        switch (result.result._tag) {
          case 'RoleNotConfigured':
            return ctx.reject(
              409,
              ErrorCode.RoleNotConfigured,
              `No connection and model set for the role ${result.result.role}.`,
            );
          case 'KeyUnreadable':
            return ctx.reject(
              409,
              ErrorCode.KeyUnreadable,
              'The saved key cannot be read any more. Enter it again.',
            );
          case 'UnknownEndpoint':
            return ctx.reject(
              409,
              ErrorCode.UnknownEndpoint,
              'The endpoint of this connection is no longer allowed on this server.',
            );
        }
    }
  };

  const list = route('sessions.list', ['GET', 'POST'], (ctx) =>
    signedIn(ctx, async (user) => {
      const runner = ctx.accounts.sessions;
      if (ctx.request.method === 'GET') {
        return json(ctx, Schema.encodeSync(SessionList)({ sessions: runner.list(user.id) }));
      }
      const input = await decode(ctx, CreateSessionRequest);
      if (input instanceof Response) return input;
      const sessionId = runner.create(user.id, input.topic, input.language);
      log({ event: 'session.created', fields: {} });
      return json(ctx, Schema.encodeSync(CreateSessionResponse)({ sessionId }), 201);
    }),
  );

  const snapshot = (sessionId: string) =>
    route('sessions.get', ['GET'], (ctx) =>
      signedIn(ctx, (user) => {
        const found = ctx.accounts.sessions.snapshot(user.id, sessionId);
        if (found === undefined) return notFound(ctx);
        return json(
          ctx,
          Schema.encodeSync(SessionSnapshot)({
            events: sequenced(found.log, -1),
            running: found.running,
          }),
        );
      }),
    );

  const stream = (sessionId: string) =>
    route('sessions.stream', ['GET'], (ctx) =>
      signedIn(ctx, (user) => {
        const runner = ctx.accounts.sessions;
        const afterRaw = new URL(ctx.request.url).searchParams.get('after');
        const after = afterRaw === null ? -1 : Number(afterRaw);
        if (!Number.isSafeInteger(after) || after < -1) {
          return ctx.reject(
            400,
            ErrorCode.InvalidRequest,
            'after must be an integer of at least -1.',
          );
        }

        let sent = after;
        let push: ((frame: AccountFrame | 'ping') => void) | undefined;
        const queue: Array<AccountFrame | 'ping'> = [];
        const emit = (frame: AccountFrame | 'ping') => (push ? push(frame) : queue.push(frame));
        // Reads the log and sends what the client has not seen. Deduped by `seq`.
        const flush = () => {
          const found = runner.snapshot(user.id, sessionId);
          if (found === undefined) return;
          for (const entry of sequenced(found.log, sent)) {
            emit({ _tag: 'log', ...entry });
            sent = entry.seq;
          }
        };
        const onSignal = (signal: SessionSignal) => {
          if (signal._tag === 'commit') return flush();
          emit(signal);
        };
        // Subscribe first, then read, so nothing committed in between is missed.
        const unsubscribe = runner.subscribe(user.id, sessionId, onSignal);
        if (unsubscribe === undefined) return notFound(ctx);
        const found = runner.snapshot(user.id, sessionId);
        emit({ _tag: 'running', turns: found?.running ?? [] });
        flush();

        let timer: ReturnType<typeof setInterval> | undefined;
        const close = () => {
          if (timer !== undefined) clearInterval(timer);
          timer = undefined;
          unsubscribe();
          push = undefined;
        };
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            push = (frame) => {
              try {
                controller.enqueue(
                  encoder.encode(frame === 'ping' ? ': ping\n\n' : encodeAccountFrame(frame)),
                );
              } catch {
                close();
              }
            };
            for (const frame of queue.splice(0)) push(frame);
            timer = setInterval(() => push?.('ping'), HEARTBEAT_MS);
            ctx.request.signal.addEventListener('abort', () => {
              close();
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            });
          },
          cancel: close,
        });
        return new Response(body, {
          status: 200,
          headers: {
            ...SECURITY_HEADERS,
            ...ctx.cors,
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            'x-accel-buffering': 'no',
          },
        });
      }),
    );

  const start = (sessionId: string) =>
    route('sessions.turn', ['POST'], (ctx) =>
      signedIn(ctx, async (user) => {
        const input = await decode(ctx, StartTurnRequest);
        if (input instanceof Response) return input;
        const result = ctx.accounts.sessions.start(user.id, sessionId, input);
        if (result._tag !== 'Ok') return startFailure(ctx, result);
        log({ event: 'session.turn.start', fields: { kind: input.kind } });
        return json(ctx, Schema.encodeSync(StartTurnResponse)({ turnId: result.turnId }), 202);
      }),
    );

  const cancel = (sessionId: string, turnId: string) =>
    route('sessions.cancel', ['POST'], (ctx) =>
      signedIn(ctx, (user) =>
        ctx.accounts.sessions.cancel(user.id, sessionId, turnId) ? noContent(ctx) : notFound(ctx),
      ),
    );

  const skip = (sessionId: string) =>
    route('sessions.skip', ['POST'], (ctx) =>
      signedIn(ctx, async (user) => {
        const input = await decode(ctx, SkipStepRequest);
        if (input instanceof Response) return input;
        const result = ctx.accounts.sessions.skip(user.id, sessionId, input.stepId);
        switch (result._tag) {
          case 'Ok':
            return noContent(ctx);
          case 'NotFound':
            return notFound(ctx);
          case 'TurnInProgress':
            return ctx.reject(
              409,
              ErrorCode.TurnInProgress,
              'A turn is already running here.',
              true,
            );
          case 'NothingToRun':
            return ctx.reject(409, ErrorCode.NothingToRun, result.message);
        }
      }),
    );

  const patterns: ReadonlyArray<[RegExp, (...ids: string[]) => Handler]> = [
    [new RegExp(`^sessions/(${ID})$`), snapshot],
    [new RegExp(`^sessions/(${ID})/stream$`), stream],
    [new RegExp(`^sessions/(${ID})/turns$`), start],
    [new RegExp(`^sessions/(${ID})/turns/(${ID})/cancel$`), cancel],
    [new RegExp(`^sessions/(${ID})/skip$`), skip],
  ];

  /** Undefined when the path is not a sessions path. */
  return (path: string): Handler | undefined => {
    if (path === 'sessions') return list;
    for (const [pattern, make] of patterns) {
      const match = pattern.exec(path);
      if (match) return make(...match.slice(1));
    }
    return undefined;
  };
};
