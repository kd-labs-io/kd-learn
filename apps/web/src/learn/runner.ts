// The turn flow of the learning screen (plan A1-A5, step 7). Plain TypeScript, no React: one
// `SessionRunner` per session lives at module level, so a turn keeps running when the screen
// unmounts, and the screen only subscribes to its state.
//
// A main turn, in order:
//   1. take the per-session Web Lock (another tab running the same turn is refused);
//   2. read the log, check the settings (no key: write nothing);
//   3. write `TurnStarted` (A3), so the learner's input is never lost;
//   4. stream: `delta` frames are shown, `event` frames are collected;
//   5. on `done`, write everything collected in one batch (one turn, one transaction);
//   6. if the turn left the session needing an agent turn (planning), start it right away.
// A transport error (`ClientError`) writes nothing: the open `TurnStarted` makes the turn
// "interrupted" and the screen offers a retry with the same input.
//
// The log is append-only and the projection strict, so one invalid append would brick the session.
// Every append is therefore checked with `projectSession` first; a batch that fails is dropped.
import { Cause, Effect, Result, Stream } from 'effect';
import { needsAgentTurn } from '@kd-learn/agent/client';
import { streamTurn, type Frame, type ModelChoice, type TurnRequest } from '@kd-learn/api';
import {
  canSkipStep,
  currentStep,
  projectSession,
  type DomainEvent,
  type EventLog,
  type Session,
} from '@kd-learn/core';
import { StorageBusy, type StorageService } from '@kd-learn/storage/port';
import { isLockHeld, sideLockName, turnLockName, withLock, type WithLock } from './locks';
import { modelChoiceOf } from './model';

/** A failure to show. Server and provider codes pass through; the client adds the ones below. */
export interface UiFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Client-side failure codes (not produced by the server). */
export const ClientFailure = {
  /** The request did not get through, or the stream ended before `done`. */
  Network: 'Network',
  /** No usable key, model or endpoint in the settings. Nothing was written. */
  NoKey: 'NoKey',
  /** Another tab is running a turn of this session. */
  Busy: 'Busy',
  /** The log or a batch breaks the `core` rules; the batch was not written. */
  InvalidLog: 'InvalidLog',
  /** The local database failed. */
  Storage: 'Storage',
} as const;

export interface RunnerState {
  readonly main: {
    readonly running: boolean;
    /** Streaming text of the turn `turnId`. The screen hides it once the turn is in the log. */
    readonly live: { readonly turnId: string; readonly text: string } | undefined;
    readonly failure: UiFailure | undefined;
  };
  readonly side: {
    readonly running: boolean;
    readonly threadId: string | undefined;
    readonly live: string | undefined;
    readonly failure: UiFailure | undefined;
  };
}

export interface RunnerDeps {
  readonly storage: () => Promise<StorageService>;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly lock?: WithLock;
  readonly newId?: () => string;
  readonly now?: () => number;
}

const idle: RunnerState = {
  main: { running: false, live: undefined, failure: undefined },
  side: { running: false, threadId: undefined, live: undefined, failure: undefined },
};

/** The main turn that starts without learner input: the first Prober turn, and planning. */
export const shouldAutoStart = (session: Session): boolean => {
  if (session.state._tag === 'Done') return false;
  const last = session.turns.at(-1);
  // Never after a failed or interrupted turn: a bad key would loop at the learner's cost.
  if (last === undefined) return session.state._tag === 'Probing';
  return last.status === 'completed' && needsAgentTurn(session);
};

type Mode =
  | { readonly kind: 'send'; readonly input: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'auto' };

type Outcome = 'completed' | 'failed' | 'skipped';

const fail = (code: string, message: string, retryable = true): UiFailure => ({
  code,
  message,
  retryable,
});

const storageFailure = (error: unknown): UiFailure =>
  fail(
    ClientFailure.Storage,
    error instanceof Error ? error.message : 'The local database failed.',
  );

/** What the stream gave: the frames of one request. */
interface Collected {
  readonly events: Array<DomainEvent>;
  error: UiFailure | undefined;
  done: boolean;
}

export class SessionRunner {
  private state: RunnerState = idle;
  private readonly listeners = new Set<() => void>();
  private deltaTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly lock: WithLock;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(
    readonly sessionId: string,
    private readonly deps: RunnerDeps,
  ) {
    this.lock = deps.lock ?? withLock;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => Date.now());
  }

  // --- subscription (useSyncExternalStore) ---

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): RunnerState => this.state;

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
  private setMain(patch: Partial<RunnerState['main']>) {
    this.state = { ...this.state, main: { ...this.state.main, ...patch } };
    this.emit();
  }
  private setSide(patch: Partial<RunnerState['side']>) {
    this.state = { ...this.state, side: { ...this.state.side, ...patch } };
    this.emit();
  }
  /** Text chunks arrive far faster than a screen needs; coalesce the notifications. */
  private pushLive(update: () => void) {
    update();
    this.deltaTimer ??= setTimeout(() => {
      this.deltaTimer = undefined;
      this.emit();
    }, 32);
  }

  /** Forgets failures kept in memory, e.g. when the learner comes back to the screen. */
  clearFailure(): void {
    if (this.state.main.failure === undefined && this.state.side.failure === undefined) return;
    this.state = {
      main: { ...this.state.main, failure: undefined },
      side: { ...this.state.side, failure: undefined },
    };
    this.emit();
  }

  // --- public actions: never reject, they report through the state ---

  /** Starts the turn that needs no learner input (first Prober turn, planning), if it is due. */
  autoStart = () => this.runMain({ kind: 'auto' });
  /** Sends the learner's answer. */
  send = (input: string) => this.runMain({ kind: 'send', input });
  /** Sends the input of the interrupted or failed last turn again, in a new turn (A3). */
  retry = () => this.runMain({ kind: 'retry' });

  /** The learner skips the current step (after M turns). `expected` guards against a stale screen. */
  async skipStep(expected: string): Promise<void> {
    if (this.state.main.running) return;
    this.setMain({ running: true, failure: undefined });
    try {
      const result = await this.lock(turnLockName(this.sessionId), async () => {
        const storage = await this.deps.storage();
        const log = await Effect.runPromise(storage.readSession(this.sessionId));
        const session = unwrap(projectSession(log));
        if (
          session === undefined ||
          session.state._tag !== 'Teaching' ||
          session.state.stepId !== expected ||
          !canSkipStep(session)
        ) {
          return;
        }
        const skipped: DomainEvent = {
          _tag: 'StepSkipped',
          id: this.newId(),
          at: this.now(),
          stepId: expected,
        };
        const batch: Array<DomainEvent> = [skipped];
        const after = unwrap(projectSession([...log, skipped]));
        // Skipping the last step completes the session in the same batch (no turn, A4).
        if (after?.state._tag === 'Teaching' && after.state.stepId === undefined) {
          batch.push({ _tag: 'SessionCompleted', id: this.newId(), at: this.now() });
        }
        if (Result.isFailure(projectSession([...log, ...batch]))) {
          throw new InvalidBatch();
        }
        await appendBatch(storage, this.sessionId, batch);
      });
      if (!result.acquired) this.setMain({ failure: fail(ClientFailure.Busy, 'Another tab.') });
    } catch (error) {
      this.setMain({ failure: failureOfThrown(error) });
    } finally {
      this.setMain({ running: false });
    }
  }

  /** Writes the learner's message to a side thread, then asks for the answer. */
  sendSide = (threadId: string, content: string) => this.runSide(threadId, content);
  /** Asks again for the answer to the last learner message of the thread. */
  retrySide = (threadId: string) => this.runSide(threadId, undefined);

  // --- main thread ---

  private async runMain(mode: Mode): Promise<void> {
    if (this.state.main.running) return;
    this.setMain({ running: true, failure: undefined });
    try {
      const result = await this.lock(turnLockName(this.sessionId), async () => {
        let current: Mode = mode;
        for (;;) {
          const outcome = await this.oneTurn(current);
          if (outcome !== 'completed') return;
          // The turn may leave the session waiting for an agent turn (planning after the assessment).
          const storage = await this.deps.storage();
          const log = await Effect.runPromise(storage.readSession(this.sessionId));
          const session = unwrap(projectSession(log));
          if (session === undefined || !shouldAutoStart(session)) return;
          current = { kind: 'auto' };
        }
      });
      // A tab that cannot take the lock is not in charge: the other tab shows the progress.
      if (!result.acquired && mode.kind !== 'auto') {
        this.setMain({ failure: fail(ClientFailure.Busy, 'Another tab is running this turn.') });
      }
    } catch (error) {
      this.setMain({ live: undefined, failure: failureOfThrown(error) });
    } finally {
      this.setMain({ running: false });
    }
  }

  private async oneTurn(mode: Mode): Promise<Outcome> {
    const storage = await this.deps.storage();
    const model = modelChoiceOf(await Effect.runPromise(storage.getSettings));
    // No key: write nothing, or an auto turn would leave a dangling `TurnStarted`.
    if (model === undefined) {
      this.setMain({
        failure: fail(ClientFailure.NoKey, 'No key, model or endpoint saved.', false),
      });
      return 'failed';
    }
    const log = await Effect.runPromise(storage.readSession(this.sessionId));
    const session = unwrap(projectSession(log));
    if (session === undefined) {
      this.setMain({
        failure: fail(ClientFailure.InvalidLog, 'The saved log is not valid.', false),
      });
      return 'failed';
    }
    if (session.state._tag === 'Done') return 'skipped';

    let input: string;
    if (mode.kind === 'send') {
      input = mode.input;
    } else if (mode.kind === 'retry') {
      const last = session.turns.at(-1);
      if (last === undefined || last.status === 'completed') return 'skipped';
      input = last.input;
    } else {
      if (!shouldAutoStart(session)) return 'skipped';
      input = '';
    }

    const turnId = this.newId();
    const started: DomainEvent = {
      _tag: 'TurnStarted',
      id: this.newId(),
      at: this.now(),
      turnId,
      input,
    };
    const withStarted: EventLog = [...log, started];
    if (Result.isFailure(projectSession(withStarted))) {
      this.setMain({
        failure: fail(ClientFailure.InvalidLog, 'The turn cannot start here.', false),
      });
      return 'failed';
    }
    await appendBatch(storage, this.sessionId, [started]);

    this.setMain({ live: { turnId, text: '' }, failure: undefined });
    const parts = new Map<string, string>();
    const collected = await this.collect(
      { model, turn: { kind: 'main' }, log: withStarted },
      (frame) => {
        if (frame._tag !== 'delta') return;
        this.pushLive(() => {
          parts.set(frame.messageId, (parts.get(frame.messageId) ?? '') + frame.delta);
          this.state = {
            ...this.state,
            main: { ...this.state.main, live: { turnId, text: [...parts.values()].join('\n\n') } },
          };
        });
      },
    );
    if (collected === undefined) {
      // Transport error: nothing is written, the open turn is "interrupted" (A3).
      this.setMain({
        live: undefined,
        failure: fail(ClientFailure.Network, 'The connection was lost before the turn ended.'),
      });
      return 'failed';
    }

    const batch = [...collected.events];
    // A failure before the stream (HTTP 4xx) carries no `TurnFailed`: record it so it survives a reload.
    if (collected.error !== undefined && !batch.some((event) => event._tag === 'TurnFailed')) {
      batch.push({
        _tag: 'TurnFailed',
        id: this.newId(),
        at: this.now(),
        turnId,
        ...collected.error,
      });
    }
    if (batch.length > 0) {
      if (Result.isFailure(projectSession([...withStarted, ...batch]))) {
        this.setMain({
          live: undefined,
          failure: fail(
            ClientFailure.InvalidLog,
            'The answer does not fit the saved lesson.',
            false,
          ),
        });
        return 'failed';
      }
      await appendBatch(storage, this.sessionId, batch);
    }
    if (collected.error !== undefined) {
      this.setMain({ live: undefined, failure: collected.error });
      return 'failed';
    }
    return 'completed';
  }

  // --- side chat ---

  private async runSide(threadId: string, content: string | undefined): Promise<void> {
    if (this.state.side.running) return;
    this.setSide({ running: true, threadId, live: undefined, failure: undefined });
    try {
      const result = await this.lock(sideLockName(this.sessionId), async () => {
        const storage = await this.deps.storage();
        const model = modelChoiceOf(await Effect.runPromise(storage.getSettings));
        if (model === undefined) {
          this.setSide({
            failure: fail(ClientFailure.NoKey, 'No key, model or endpoint saved.', false),
          });
          return;
        }
        const log = await Effect.runPromise(storage.readSession(this.sessionId));
        const session = unwrap(projectSession(log));
        if (session === undefined) {
          this.setSide({
            failure: fail(ClientFailure.InvalidLog, 'The saved log is not valid.', false),
          });
          return;
        }
        let outgoing: EventLog = log;
        if (content !== undefined) {
          const stepId = currentStep(session)?.id;
          const message: DomainEvent = {
            _tag: 'SideMessageAppended',
            id: this.newId(),
            at: this.now(),
            threadId,
            messageId: this.newId(),
            role: 'user',
            content,
            ...(stepId === undefined ? {} : { stepId }),
          };
          outgoing = [...log, message];
          if (Result.isFailure(projectSession(outgoing))) {
            this.setSide({
              failure: fail(ClientFailure.InvalidLog, 'The message cannot be sent here.', false),
            });
            return;
          }
          await appendBatch(storage, this.sessionId, [message]);
        } else if (session.sideThreads[threadId]?.at(-1)?.role !== 'user') {
          return; // Nothing to answer. A retry never adds a second learner message.
        }

        this.setSide({ live: '' });
        let text = '';
        const collected = await this.collect(
          { model, turn: { kind: 'side', threadId }, log: outgoing },
          (frame) => {
            if (frame._tag !== 'delta') return;
            this.pushLive(() => {
              text += frame.delta;
              this.state = { ...this.state, side: { ...this.state.side, live: text } };
            });
          },
        );
        if (collected === undefined) {
          this.setSide({
            live: undefined,
            failure: fail(
              ClientFailure.Network,
              'The connection was lost before the answer ended.',
            ),
          });
          return;
        }
        const batch = [...collected.events];
        if (
          collected.error !== undefined &&
          !batch.some((event) => event._tag === 'SideTurnFailed')
        ) {
          batch.push({
            _tag: 'SideTurnFailed',
            id: this.newId(),
            at: this.now(),
            threadId,
            ...collected.error,
          });
        }
        if (batch.length > 0) {
          if (Result.isFailure(projectSession([...outgoing, ...batch]))) {
            this.setSide({
              live: undefined,
              failure: fail(
                ClientFailure.InvalidLog,
                'The answer does not fit the saved lesson.',
                false,
              ),
            });
            return;
          }
          await appendBatch(storage, this.sessionId, batch);
        }
        this.setSide({ live: undefined, failure: collected.error });
      });
      if (!result.acquired) {
        this.setSide({
          failure: fail(ClientFailure.Busy, 'Another tab is waiting for an answer.'),
        });
      }
    } catch (error) {
      this.setSide({ live: undefined, failure: failureOfThrown(error) });
    } finally {
      this.setSide({ running: false });
    }
  }

  // --- the request ---

  /**
   * Runs one request and gathers its frames. Resolves to `undefined` when the transport failed or
   * the stream ended before `done`; then nothing from it may be written.
   */
  private async collect(
    request: TurnRequest,
    onFrame: (frame: Frame) => void,
  ): Promise<Collected | undefined> {
    const collected: Collected = { events: [], error: undefined, done: false };
    const stream = streamTurn(request, {
      ...(this.deps.baseUrl === undefined ? {} : { baseUrl: this.deps.baseUrl }),
      ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }),
    });
    const exit = await Effect.runPromiseExit(
      Stream.runForEach(stream, (frame) =>
        Effect.sync(() => {
          if (frame._tag === 'event') collected.events.push(frame.event);
          else if (frame._tag === 'error') collected.error = frame.error;
          else if (frame._tag === 'done') collected.done = true;
          onFrame(frame);
        }),
      ),
    );
    return exit._tag === 'Success' && collected.done ? collected : undefined;
  }
}

class InvalidBatch extends Error {}

const unwrap = <A, E>(result: Result.Result<A, E>): A | undefined =>
  Result.isSuccess(result) ? result.success : undefined;

const failureOfThrown = (error: unknown): UiFailure =>
  error instanceof InvalidBatch
    ? fail(ClientFailure.InvalidLog, 'The change does not fit the saved lesson.', false)
    : storageFailure(error);

/**
 * Appends one batch. A timeout (`StorageBusy`) leaves the outcome unknown, so read the log back:
 * if the batch is there it succeeded, otherwise try again (a repeated batch is rejected as a whole
 * by its duplicate ids, so retrying cannot write it twice).
 */
export async function appendBatch(
  storage: StorageService,
  sessionId: string,
  events: ReadonlyArray<DomainEvent>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const exit = await Effect.runPromiseExit(storage.appendEvents(sessionId, events));
    if (exit._tag === 'Success') return;
    const error = Cause.squash(exit.cause);
    if (!(error instanceof StorageBusy) || attempt >= 3) throw error;
    const first = events[0];
    const log = await Effect.runPromise(storage.readSession(sessionId)).catch(() => undefined);
    if (first !== undefined && log?.some((event) => event.id === first.id)) return;
  }
}

/** True while another tab holds the turn lock of the session. */
export const isTurnRunningElsewhere = (sessionId: string) => isLockHeld(turnLockName(sessionId));

// --- registry ---

const runners = new Map<string, SessionRunner>();

/** The runner of a session, created on first use. Module level, so it outlives the screen. */
export function getRunner(sessionId: string, deps: RunnerDeps): SessionRunner {
  let runner = runners.get(sessionId);
  if (runner === undefined) {
    runner = new SessionRunner(sessionId, deps);
    runners.set(sessionId, runner);
  }
  return runner;
}

export type { ModelChoice };
