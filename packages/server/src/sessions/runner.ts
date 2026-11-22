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
import type { AgentOutput, FigureOptions, InvalidTurn } from '@kd-learn/agent';
import { shouldAutoStart } from '@kd-learn/agent/client';
import type { AiPort, ImagePort, ModelRef } from '@kd-learn/ai/port';
import type { Failure, ModelRole, RunningTurn, StartTurnRequest } from '@kd-learn/api';
import { ErrorCode } from '@kd-learn/api';
import {
  canSkipStep,
  currentStep,
  findInterruptedTurn,
  projectSession,
  turnSourceSlice,
} from '@kd-learn/core';
import type { DomainEvent, EventLog, FigureBody, Session, SourceSlice } from '@kd-learn/core';
import type { SessionSummary, StorageService } from '@kd-learn/storage/port';
import type { ServerStorage } from '@kd-learn/storage/sqlite-node';
import type { Logger } from '../handler.ts';
import { redact, scrubDeep, type Secrets } from '../safety.ts';
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
  /** Undefined when a source id is unknown for this user. */
  readonly create: (
    userId: string,
    topic: string,
    language: string,
    sourceIds?: ReadonlyArray<string>,
  ) => string | undefined;
  /**
   * Attaches and detaches sources (phase 4 A2). Refused while a main turn runs, like a skip, so the
   * turn's batch and this one never race. Attaching an attached source, or detaching one that is
   * not, is a no-op; an unknown source id is `NothingToRun`.
   */
  readonly setSources: (
    userId: string,
    sessionId: string,
    change: { readonly attach: ReadonlyArray<string>; readonly detach: ReadonlyArray<string> },
  ) => SkipResult;
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
  /** Called after a batch with `SessionCompleted` is written, by a turn or a skip (phase 3 A3). */
  readonly onSessionCompleted?: (userId: string, sessionId: string) => void;
  /** Figure tools of teaching turns (phase 5). Absent: none. */
  readonly figures?: () => FigureOptions;
  /** Makes images when the user set an illustrator (phase 5 A6). Absent: no images. */
  readonly images?: ImagePort['Service'];
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
  /** Bodies of the turn's figures (phase 5 A1), written with `events`. */
  readonly figures?: ReadonlyArray<FigureBody>;
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
  /** Every write of a session goes through here, so the end of a session is seen in one place. */
  const appendSync = (
    storage: StorageService,
    userId: string,
    sessionId: string,
    events: ReadonlyArray<DomainEvent>,
    figures: ReadonlyArray<FigureBody> = [],
  ) => {
    const result = Effect.runSync(storage.appendEvents(sessionId, events, figures));
    if (events.some((event) => event._tag === 'SessionCompleted')) {
      deps.onSessionCompleted?.(userId, sessionId);
    }
    return result;
  };

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
    key: Secrets,
  ): Effect.Effect<Collected> => {
    const events: DomainEvent[] = [];
    const figures: FigureBody[] = [];
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
            case 'Figure':
              figures.push(output.figure);
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
          : { events, error, figures },
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
    userId: string,
    sessionId: string,
    collected: Collected,
    closing: (failure: Failure) => DomainEvent,
    key: Secrets,
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
    // A text body holding the key is dropped with its event, never written (risk 19).
    const leaks = (figure: FigureBody) =>
      typeof figure.body === 'string' && redact(figure.body, key) !== figure.body;
    const dropped = new Set((collected.figures ?? []).filter(leaks).map((f) => f.figureId));
    if (dropped.size > 0) {
      batch = batch.filter((e) => !(e._tag === 'FigureAdded' && dropped.has(e.figureId)));
    }
    const added = new Set(batch.flatMap((e) => (e._tag === 'FigureAdded' ? [e.figureId] : [])));
    const figures = (collected.figures ?? []).filter((figure) => added.has(figure.figureId));
    if (batch.length > 0) appendSync(storage, userId, sessionId, batch, figures);
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
    appendSync(storage, userId, sessionId, [started]);
    return { _tag: 'Ok', turnId, log: withStarted, model: resolved.model };
  };

  const keyOfModel = (model: ModelRef) => ('apiKey' in model ? model.apiKey : undefined);

  /**
   * Figure options of a main turn, with the user's illustrator when there is one (phase 5 A6), and
   * the image key so it can be kept out of what leaves the server.
   */
  const figuresOf = (
    userId: string,
  ): { readonly figures?: FigureOptions; readonly imageKey?: string } => {
    if (deps.figures === undefined) return {};
    const base = deps.figures();
    const images = deps.images;
    const model = images === undefined ? undefined : deps.settings.resolveImageModel(userId);
    if (images === undefined || model === undefined) return { figures: base };
    return {
      imageKey: model.apiKey,
      figures: {
        ...base,
        image: {
          model: model.model,
          generate: (prompt, aspect) => images.generate({ model, prompt, aspect }),
        },
      },
    };
  };

  /** `SourceAttached` for each id, or undefined when one is not a source of this user. */
  const attachEvents = (
    storage: StorageService,
    sourceIds: ReadonlyArray<string>,
  ): DomainEvent[] | undefined => {
    const events: DomainEvent[] = [];
    for (const sourceId of sourceIds) {
      const info = Effect.runSync(storage.getSource(sourceId));
      if (info === undefined) return undefined;
      events.push({
        _tag: 'SourceAttached',
        id: newId(),
        at: now(),
        sourceId,
        title: info.title,
        kind: info.kind,
      });
    }
    return events;
  };

  /** Chunks of the attached sources for the open turn of `log` (phase 4 A3), from the DB. */
  const sourceSliceOf = (storage: StorageService, log: EventLog): SourceSlice => {
    const projected = projectSession(log);
    if (Result.isFailure(projected) || projected.success.sources.length === 0) return [];
    const session = projected.success;
    const chunks = Effect.runSync(storage.readChunks(session.sources.map((s) => s.sourceId)));
    return turnSourceSlice(session, chunks, findInterruptedTurn(session)?.input ?? '');
  };

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
        const { figures, imageKey } = figuresOf(userId);
        // The image key is a secret of the turn too (risk 19).
        const key = [keyOfModel(current.model), imageKey];
        const collected = yield* consume(
          runTurn({
            log: current.log,
            model: current.model,
            newId,
            sourceSlice: sourceSliceOf(storage, current.log),
            ...(figures === undefined ? {} : { figures }),
          }),
          live,
          entry,
          key,
        );
        const turnId = current.turnId;
        const error = commit(
          storage,
          userId,
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
      appendSync(storage, userId, sessionId, [message]);
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
        userId,
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
    create: (userId, topic, language, sourceIds = []) => {
      const storage = deps.storage.forUser(userId);
      const attached = attachEvents(storage, [...new Set(sourceIds)]);
      if (attached === undefined) return undefined;
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
      appendSync(storage, userId, sessionId, [event, ...attached]);
      return sessionId;
    },

    setSources: (userId, sessionId, change) => {
      const storage = deps.storage.forUser(userId);
      const log = readSync(storage, sessionId);
      if (log.length === 0) return { _tag: 'NotFound' };
      if (entries.get(keyOf(userId, sessionId))?.main !== undefined) {
        return { _tag: 'TurnInProgress' };
      }
      const session = unwrap(log);
      if (session === undefined) return { _tag: 'NothingToRun', message: 'The lesson is invalid.' };
      const current = new Set(session.sources.map((s) => s.sourceId));
      const detach = [...new Set(change.detach)].filter((id) => current.has(id));
      const attach = [...new Set(change.attach)].filter(
        (id) => !current.has(id) && !detach.includes(id),
      );
      const attached = attachEvents(storage, attach);
      if (attached === undefined) return { _tag: 'NothingToRun', message: 'Unknown source.' };
      const batch: DomainEvent[] = [
        ...detach.map((sourceId): DomainEvent => ({
          _tag: 'SourceDetached',
          id: newId(),
          at: now(),
          sourceId,
        })),
        ...attached,
      ];
      if (batch.length === 0) return { _tag: 'Ok' };
      if (Result.isFailure(projectSession([...log, ...batch]))) {
        return { _tag: 'NothingToRun', message: 'These sources cannot be changed now.' };
      }
      appendSync(storage, userId, sessionId, batch);
      const entry = entries.get(keyOf(userId, sessionId));
      if (entry) publish(entry, { _tag: 'commit' });
      return { _tag: 'Ok' };
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
      appendSync(storage, userId, sessionId, batch);
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
