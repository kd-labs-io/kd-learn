// Turns of account sessions, run by the server (plan tai-khoan.md A1, A2). The server is the only
// writer of an account log. A turn runs in a fiber that does not belong to any HTTP request:
// closing the tab does not stop it; only `cancel` does.
//
// Rules:
// - One main and one side turn per session at a time. The slot is taken in the same synchronous
//   section as the log read, the model resolution and the `TurnStarted` write (the SQLite driver is
//   synchronous), and released by the fiber's finalizer on every exit.
// - Every entry point takes the user id and checks ownership through `forUser` before anything else.
//   The registry is keyed by user and session, so another user can never reach a running turn.
// - Every turn ends in the log (`TurnCompleted`, `TurnFailed`, `SideMessageAppended`,
//   `SideTurnFailed`), except a cancelled turn and a turn cut by a restart: those stay open and
//   project as interrupted (phase 1 rule). Nothing ever re-runs a turn by itself.
// - Events are scrubbed of the resolved key before they are written or published (risk 19).
import { Cause, Effect, Exit, Fiber, Layer, Result, Stream } from 'effect';
import { runSideChat, runTurn } from '@kd-learn/agent';
import { activeProfile } from '../profile.ts';
import type { AgentOutput, InvalidTurn } from '@kd-learn/agent';
import { shouldAutoStart } from '@kd-learn/agent/client';
import type { AiPort, ModelRef } from '@kd-learn/ai/port';
import type { Failure, ModelRole, RunningTurn, StartTurnRequest } from '@kd-learn/api';
import { ErrorCode } from '@kd-learn/api';
import { canSkipStep, currentStep, projectSession } from '@kd-learn/core';
import type { DomainEvent, EventLog, Session } from '@kd-learn/core';
import type { SessionSummary, StorageService } from '@kd-learn/storage/port';
import type { ServerStorage } from '@kd-learn/storage/sqlite-node';
import type { Logger } from '../handler.ts';
import { redact, scrubDeep } from '../safety.ts';
import type { ResolveResult, SettingsService } from '../settings/service.ts';

export type TurnKind = 'main' | 'side';

/** What a stream subscriber hears. Events themselves are read from the log after `commit`. */
export type SessionSignal =
  | { readonly _tag: 'commit' }
  | {
      readonly _tag: 'delta';
      readonly turnId: string;
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly _tag: 'turn';
      readonly turnId: string;
      readonly kind: TurnKind;
      readonly threadId?: string;
      readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
      readonly error?: Failure;
    };

export type StartResult =
  | { readonly _tag: 'Ok'; readonly turnId: string }
  | { readonly _tag: 'NotFound' }
  | { readonly _tag: 'TurnInProgress' }
  | { readonly _tag: 'NothingToRun'; readonly message: string }
  | { readonly _tag: 'ModelUnavailable'; readonly result: Exclude<ResolveResult, { _tag: 'Ok' }> }
  | { readonly _tag: 'InvalidLog'; readonly message: string };

export type SkipResult =
  | { readonly _tag: 'Ok' }
  | { readonly _tag: 'NotFound' }
  | { readonly _tag: 'TurnInProgress' }
  | { readonly _tag: 'NothingToRun'; readonly message: string };

export interface SessionRunner {
  readonly create: (userId: string, topic: string, language: string) => string;
  readonly list: (userId: string) => ReadonlyArray<SessionSummary>;
  /** Undefined when the session does not exist for this user. */
  readonly snapshot: (
    userId: string,
    sessionId: string,
  ) => { readonly log: EventLog; readonly running: ReadonlyArray<RunningTurn> } | undefined;
  readonly start: (userId: string, sessionId: string, request: StartTurnRequest) => StartResult;
  /** False when no such running turn exists for this user and session. */
  readonly cancel: (userId: string, sessionId: string, turnId: string) => boolean;
  readonly skip: (userId: string, sessionId: string, stepId: string) => SkipResult;
  /** Undefined when the session does not exist for this user. Call the result to unsubscribe. */
  readonly subscribe: (
    userId: string,
    sessionId: string,
    listener: (signal: SessionSignal) => void,
  ) => (() => void) | undefined;
  /** Interrupts every running turn (shutdown, tests). Nothing is written for them. */
  readonly stopAll: () => Promise<void>;
}

export interface RunnerDeps {
  readonly storage: ServerStorage;
  readonly settings: SettingsService;
  readonly ai: Layer.Layer<AiPort>;
  readonly log: Logger;
  readonly newId?: () => string;
  readonly now?: () => number;
  /** Upper bound on one turn (model calls and tools). Default 3 minutes. */
  readonly turnTimeoutMs?: number;
}

interface Live {
  turnId: string;
  readonly kind: TurnKind;
  readonly threadId?: string;
  /** Text per assistant message of the current turn, in order. */
  readonly parts: Map<string, string>;
  fiber?: Fiber.Fiber<unknown, unknown>;
  cancelled: boolean;
}

interface Entry {
  main?: Live;
  side?: Live;
  readonly listeners: Set<(signal: SessionSignal) => void>;
}

const keyOf = (userId: string, sessionId: string) => `${userId}\u0000${sessionId}`;

const unwrap = (log: EventLog): Session | undefined => {
  const projected = projectSession(log);
  return Result.isFailure(projected) ? undefined : projected.success;
};

/** Result of consuming one agent stream. */
interface Collected {
  readonly events: ReadonlyArray<DomainEvent>;
  readonly error: Failure | undefined;
}

export const makeSessionRunner = (deps: RunnerDeps): SessionRunner => {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.turnTimeoutMs ?? 3 * 60 * 1000;
  const entries = new Map<string, Entry>();

  const entryOf = (userId: string, sessionId: string): Entry => {
    const key = keyOf(userId, sessionId);
    let entry = entries.get(key);
    if (entry === undefined) entries.set(key, (entry = { listeners: new Set() }));
    return entry;
  };
  /** Drops entries nobody uses, so the map does not grow with every session ever opened. */
  const tidy = (userId: string, sessionId: string) => {
    const key = keyOf(userId, sessionId);
    const entry = entries.get(key);
    if (entry && !entry.main && !entry.side && entry.listeners.size === 0) entries.delete(key);
  };
  const publish = (entry: Entry, signal: SessionSignal) => {
    for (const listener of entry.listeners) {
      try {
        listener(signal);
      } catch {
        // A broken subscriber must not stop the turn.
      }
    }
  };

  const readSync = (storage: StorageService, sessionId: string): EventLog =>
    Effect.runSync(storage.readSession(sessionId));
  const appendSync = (
    storage: StorageService,
    sessionId: string,
    events: ReadonlyArray<DomainEvent>,
  ) => Effect.runSync(storage.appendEvents(sessionId, events));

  const runningOf = (entry: Entry | undefined): ReadonlyArray<RunningTurn> =>
    [entry?.main, entry?.side].flatMap((live) =>
      live === undefined
        ? []
        : [
            {
              turnId: live.turnId,
              kind: live.kind,
              ...(live.threadId === undefined ? {} : { threadId: live.threadId }),
              text: [...live.parts].map(([messageId, text]) => ({ messageId, text })),
            },
          ],
    );

  const roleOf = (session: Session): ModelRole =>
    session.state._tag === 'Probing' ? 'prober' : 'teacher';

  /** Consumes one agent stream with a timeout. Never fails; cancellation interrupts it. */
  const consume = (
    outputs: Stream.Stream<AgentOutput, InvalidTurn, AiPort>,
    live: Live,
    entry: Entry,
    key: string | undefined,
  ): Effect.Effect<Collected> => {
    const events: DomainEvent[] = [];
    let error: Failure | undefined;
    return outputs.pipe(
      Stream.runForEach((output) =>
        Effect.sync(() => {
          switch (output._tag) {
            case 'Delta': {
              const delta = redact(output.delta, key);
              live.parts.set(output.messageId, (live.parts.get(output.messageId) ?? '') + delta);
              publish(entry, {
                _tag: 'delta',
                turnId: live.turnId,
                messageId: output.messageId,
                delta,
              });
              return;
            }
            case 'Event':
              events.push(output.event);
              return;
            case 'Error':
              error = output.error;
              return;
            case 'Done':
              return;
          }
        }),
      ),
      Effect.provide(deps.ai),
      Effect.timeoutOption(timeoutMs),
      Effect.map((done): Collected =>
        done._tag === 'None'
          ? {
              events: [],
              error: {
                code: ErrorCode.TurnTimeout,
                message: `The turn took longer than ${Math.round(timeoutMs / 1000)} s.`,
                retryable: true,
              },
            }
          : { events, error },
      ),
      Effect.catchTag('InvalidTurn', (invalid) =>
        Effect.succeed<Collected>({
          events: [],
          error: { code: ErrorCode.InvalidTurn, message: invalid.message, retryable: false },
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync((): Collected => {
              deps.log({
                event: 'session.turn.defect',
                fields: { detail: redact(String(Cause.squash(cause)), key).slice(0, 200) },
              });
              return {
                events: [],
                error: {
                  code: ErrorCode.Internal,
                  message: 'The turn failed because of a server error.',
                  retryable: true,
                },
              };
            }),
      ),
    ) as Effect.Effect<Collected>;
  };

  /**
   * Writes the end of a turn: its events, plus a failure event when the stream ended without one.
   * Checked against the log as it is now (a side turn may have written meanwhile).
   */
  const commit = (
    storage: StorageService,
    sessionId: string,
    collected: Collected,
    closing: (failure: Failure) => DomainEvent,
    key: string | undefined,
  ): Failure | undefined => {
    let batch = scrubDeep([...collected.events], key);
    let error = collected.error === undefined ? undefined : scrubDeep(collected.error, key);
    const closed = batch.some(
      (event) => event._tag === 'TurnFailed' || event._tag === 'SideTurnFailed',
    );
    if (error !== undefined && !closed) batch.push(closing(error));
    const log = readSync(storage, sessionId);
    if (Result.isFailure(projectSession([...log, ...batch]))) {
      error = {
        code: ErrorCode.InvalidTurn,
        message: 'The answer does not fit the saved lesson.',
        retryable: true,
      };
      batch = [closing(error)];
    }
    if (batch.length > 0) appendSync(storage, sessionId, batch);
    return error;
  };

  /** Resolves the model and the input of the next main turn, then writes `TurnStarted`. Synchronous. */
  const openMain = (
    storage: StorageService,
    userId: string,
    sessionId: string,
    request: Exclude<StartTurnRequest, { kind: 'side' }>,
  ):
    | {
        readonly _tag: 'Ok';
        readonly turnId: string;
        readonly log: EventLog;
        readonly model: ModelRef;
      }
    | Exclude<StartResult, { _tag: 'Ok' } | { _tag: 'TurnInProgress' }> => {
    const log = readSync(storage, sessionId);
    if (log.length === 0) return { _tag: 'NotFound' };
    const session = unwrap(log);
    if (session === undefined)
      return { _tag: 'InvalidLog', message: 'The saved log is not valid.' };
    if (session.state._tag === 'Done') {
      return { _tag: 'NothingToRun', message: 'The session is already done.' };
    }
    let input: string;
    if (request.kind === 'send') input = request.input;
    else if (request.kind === 'retry') {
      const last = session.turns.at(-1);
      if (last === undefined || last.status === 'completed') {
        return {
          _tag: 'NothingToRun',
          message: 'There is no failed or interrupted turn to retry.',
        };
      }
      input = last.input;
    } else {
      if (!shouldAutoStart(session)) {
        return { _tag: 'NothingToRun', message: 'This session waits for the learner.' };
      }
      input = '';
    }
    const resolved = deps.settings.resolveModel(userId, roleOf(session));
    if (resolved._tag !== 'Ok') return { _tag: 'ModelUnavailable', result: resolved };
    const turnId = newId();
    const started: DomainEvent = { _tag: 'TurnStarted', id: newId(), at: now(), turnId, input };
    const withStarted = [...log, started];
    if (Result.isFailure(projectSession(withStarted))) {
      return { _tag: 'InvalidLog', message: 'The turn cannot start here.' };
    }
    appendSync(storage, sessionId, [started]);
    return { _tag: 'Ok', turnId, log: withStarted, model: resolved.model };
  };

  const keyOfModel = (model: ModelRef) => ('apiKey' in model ? model.apiKey : undefined);

  const startMain = (
    userId: string,
    sessionId: string,
    request: Exclude<StartTurnRequest, { kind: 'side' }>,
  ): StartResult => {
    const storage = deps.storage.forUser(userId);
    const entry = entryOf(userId, sessionId);
    if (entry.main !== undefined) return { _tag: 'TurnInProgress' };
    const opened = openMain(storage, userId, sessionId, request);
    if (opened._tag !== 'Ok') {
      tidy(userId, sessionId);
      return opened;
    }
    const live: Live = { turnId: opened.turnId, kind: 'main', parts: new Map(), cancelled: false };
    entry.main = live;
    publish(entry, { _tag: 'commit' });
    publish(entry, { _tag: 'turn', turnId: live.turnId, kind: 'main', status: 'running' });

    const program = Effect.gen(function* () {
      let current = { turnId: opened.turnId, log: opened.log, model: opened.model };
      for (;;) {
        const key = keyOfModel(current.model);
        const collected = yield* consume(
          runTurn({ log: current.log, model: current.model, newId }),
          live,
          entry,
          key,
        );
        const turnId = current.turnId;
        const error = commit(
          storage,
          sessionId,
          collected,
          (failure) => ({ _tag: 'TurnFailed', id: newId(), at: now(), turnId, ...failure }),
          key,
        );
        publish(entry, { _tag: 'commit' });
        publish(entry, {
          _tag: 'turn',
          turnId,
          kind: 'main',
          status: error === undefined ? 'completed' : 'failed',
          ...(error === undefined ? {} : { error }),
        });
        deps.log({
          event: 'session.turn.end',
          fields: {
            kind: 'main',
            outcome: error === undefined ? 'completed' : 'failed',
            ...(error ? { code: error.code } : {}),
          },
        });
        if (error !== undefined || live.cancelled) return;
        // Planning right after the assessment: chain the turn that needs no input.
        const session = unwrap(readSync(storage, sessionId));
        if (session === undefined || !shouldAutoStart(session)) return;
        const next = openMain(storage, userId, sessionId, { kind: 'auto' });
        if (next._tag !== 'Ok') {
          deps.log({ event: 'session.turn.chain_stopped', fields: { reason: next._tag } });
          return;
        }
        live.turnId = next.turnId;
        live.parts.clear();
        current = { turnId: next.turnId, log: next.log, model: next.model };
        publish(entry, { _tag: 'commit' });
        publish(entry, { _tag: 'turn', turnId: next.turnId, kind: 'main', status: 'running' });
      }
    });
    run(entry, live, program, userId, sessionId);
    return { _tag: 'Ok', turnId: opened.turnId };
  };

  const startSide = (
    userId: string,
    sessionId: string,
    request: Extract<StartTurnRequest, { kind: 'side' }>,
  ): StartResult => {
    const storage = deps.storage.forUser(userId);
    const entry = entryOf(userId, sessionId);
    if (entry.side !== undefined) return { _tag: 'TurnInProgress' };
    const fail = <T extends StartResult>(result: T): T => {
      tidy(userId, sessionId);
      return result;
    };
    const log = readSync(storage, sessionId);
    if (log.length === 0) return fail({ _tag: 'NotFound' });
    const session = unwrap(log);
    if (session === undefined)
      return fail({ _tag: 'InvalidLog', message: 'The saved log is not valid.' });
    const { threadId } = request;
    if (request.content === undefined && session.sideThreads[threadId]?.at(-1)?.role !== 'user') {
      return fail({
        _tag: 'NothingToRun',
        message: 'There is no question to answer in this thread.',
      });
    }
    const resolved = deps.settings.resolveModel(userId, 'sideChat');
    if (resolved._tag !== 'Ok') return fail({ _tag: 'ModelUnavailable', result: resolved });
    let outgoing: EventLog = log;
    if (request.content !== undefined) {
      const stepId = currentStep(session)?.id;
      const message: DomainEvent = {
        _tag: 'SideMessageAppended',
        id: newId(),
        at: now(),
        threadId,
        messageId: newId(),
        role: 'user',
        content: request.content,
        ...(stepId === undefined ? {} : { stepId }),
      };
      outgoing = [...log, message];
      if (Result.isFailure(projectSession(outgoing))) {
        return fail({ _tag: 'InvalidLog', message: 'The message cannot be sent here.' });
      }
      appendSync(storage, sessionId, [message]);
    }
    const live: Live = {
      turnId: newId(),
      kind: 'side',
      threadId,
      parts: new Map(),
      cancelled: false,
    };
    entry.side = live;
    publish(entry, { _tag: 'commit' });
    publish(entry, {
      _tag: 'turn',
      turnId: live.turnId,
      kind: 'side',
      threadId,
      status: 'running',
    });

    const model = resolved.model;
    const key = keyOfModel(model);
    const program = Effect.gen(function* () {
      const collected = yield* consume(
        runSideChat({ log: outgoing, threadId, model, newId }),
        live,
        entry,
        key,
      );
      const error = commit(
        storage,
        sessionId,
        collected,
        (failure) => ({ _tag: 'SideTurnFailed', id: newId(), at: now(), threadId, ...failure }),
        key,
      );
      publish(entry, { _tag: 'commit' });
      publish(entry, {
        _tag: 'turn',
        turnId: live.turnId,
        kind: 'side',
        threadId,
        status: error === undefined ? 'completed' : 'failed',
        ...(error === undefined ? {} : { error }),
      });
    });
    run(entry, live, program, userId, sessionId);
    return { _tag: 'Ok', turnId: live.turnId };
  };

  /** Forks the turn as a daemon fiber; the finalizer frees the slot on every exit. */
  const run = (
    entry: Entry,
    live: Live,
    program: Effect.Effect<void>,
    userId: string,
    sessionId: string,
  ) => {
    const guarded = program.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() =>
              deps.log({ event: 'session.turn.crashed', fields: { kind: live.kind } }),
            ),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (live.kind === 'main' && entry.main === live) delete entry.main;
          if (live.kind === 'side' && entry.side === live) delete entry.side;
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
            publish(entry, {
              _tag: 'turn',
              turnId: live.turnId,
              kind: live.kind,
              ...(live.threadId === undefined ? {} : { threadId: live.threadId }),
              status: 'cancelled',
            });
          }
          tidy(userId, sessionId);
        }),
      ),
    );
    live.fiber = Effect.runFork(guarded);
  };

  return {
    create: (userId, topic, language) => {
      const storage = deps.storage.forUser(userId);
      // The profile in use now is snapshotted into the session (phase 3 A2).
      const { profile } = Effect.runSync(activeProfile(storage));
      const sessionId = newId();
      const event: DomainEvent = {
        _tag: 'SessionCreated',
        id: newId(),
        at: now(),
        sessionId,
        topic,
        profile: { ...profile, language },
      };
      appendSync(storage, sessionId, [event]);
      return sessionId;
    },

    list: (userId) => Effect.runSync(deps.storage.forUser(userId).listSessions),

    snapshot: (userId, sessionId) => {
      const log = readSync(deps.storage.forUser(userId), sessionId);
      if (log.length === 0) return undefined;
      return { log, running: runningOf(entries.get(keyOf(userId, sessionId))) };
    },

    start: (userId, sessionId, request) =>
      request.kind === 'side'
        ? startSide(userId, sessionId, request)
        : startMain(userId, sessionId, request),

    cancel: (userId, sessionId, turnId) => {
      const entry = entries.get(keyOf(userId, sessionId));
      const live = [entry?.main, entry?.side].find((l) => l?.turnId === turnId);
      if (live?.fiber === undefined) return false;
      live.cancelled = true;
      Effect.runFork(Fiber.interrupt(live.fiber));
      return true;
    },

    skip: (userId, sessionId, stepId) => {
      const storage = deps.storage.forUser(userId);
      const log = readSync(storage, sessionId);
      if (log.length === 0) return { _tag: 'NotFound' };
      if (entries.get(keyOf(userId, sessionId))?.main !== undefined)
        return { _tag: 'TurnInProgress' };
      const session = unwrap(log);
      if (
        session === undefined ||
        session.state._tag !== 'Teaching' ||
        session.state.stepId !== stepId ||
        !canSkipStep(session)
      ) {
        return { _tag: 'NothingToRun', message: 'This step cannot be skipped now.' };
      }
      const batch: DomainEvent[] = [{ _tag: 'StepSkipped', id: newId(), at: now(), stepId }];
      const after = unwrap([...log, ...batch]);
      // Skipping the last step completes the session in the same batch (no turn, A4).
      if (after?.state._tag === 'Teaching' && after.state.stepId === undefined) {
        batch.push({ _tag: 'SessionCompleted', id: newId(), at: now() });
      }
      if (Result.isFailure(projectSession([...log, ...batch]))) {
        return { _tag: 'NothingToRun', message: 'This step cannot be skipped now.' };
      }
      appendSync(storage, sessionId, batch);
      const entry = entries.get(keyOf(userId, sessionId));
      if (entry) publish(entry, { _tag: 'commit' });
      return { _tag: 'Ok' };
    },

    subscribe: (userId, sessionId, listener) => {
      if (readSync(deps.storage.forUser(userId), sessionId).length === 0) return undefined;
      const entry = entryOf(userId, sessionId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        tidy(userId, sessionId);
      };
    },

    stopAll: async () => {
      const fibers = [...entries.values()].flatMap((entry) =>
        [entry.main?.fiber, entry.side?.fiber].filter((f) => f !== undefined),
      );
      await Effect.runPromise(Fiber.interruptAll(fibers));
    },
  };
};
