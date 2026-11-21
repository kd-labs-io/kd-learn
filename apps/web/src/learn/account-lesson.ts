// The learning screen's data for an account session (plan tai-khoan.md A1, A2). The server owns
// the log and runs the turns; this store only follows them:
//   1. read the snapshot (`GET .../sessions/:id`): events with their `seq`, and running turns;
//   2. follow the stream from the last `seq` seen (`?after=`). The first frame (`running`) gives
//      the text so far of each running turn, so a tab opened mid-turn shows it at once;
//   3. when the stream ends (proxy, server restart, network), connect again from the last `seq`.
// Closing the tab only closes the stream: the turn keeps running on the server.
//
// What the screen shows as "running" comes from the server (`running` and `turn` frames), never
// from "this tab sent something", so a reopened tab sees a live turn as live, not interrupted.
import {
  ApiError,
  accountClient,
  streamSession,
  type AccountClientOptions,
  type AccountFrame,
  type RunningTurn,
  type StartTurnRequest,
} from '@kd-learn/api';
import { projectSession, type DomainEvent } from '@kd-learn/core';
import { Effect, Stream } from 'effect';
import { onUserChange } from '../account/auth';
import type { RunnerState, UiFailure } from './runner';
import type { LessonActions, LessonView } from './source';

export interface AccountLessonDeps {
  readonly options: AccountClientOptions;
  /** Called on 401: the token expired or was revoked. */
  readonly onUnauthorized: () => void;
  /** Delay before reconnecting after the `n`-th failure in a row. */
  readonly backoff?: (n: number) => number;
}

export interface AccountLessonState {
  readonly view: LessonView;
  readonly runner: RunnerState;
}

interface Live {
  readonly turnId: string;
  readonly threadId: string | undefined;
  /** Text per assistant message, in arrival order. */
  readonly parts: Map<string, string>;
}

const GAP = Symbol('gap');

/** A turn the stream never reported (frames lost while reconnecting) stops blocking after this. */
const PENDING_MS = 10_000;

/** 409s an auto turn may get without anything being wrong: the server already runs or ran it. */
const QUIET_AUTO = new Set(['TurnInProgress', 'NothingToRun']);

const failureOf = (error: unknown): UiFailure =>
  error instanceof ApiError
    ? error.failure
    : { code: 'Network', message: 'The request did not reach the server.', retryable: true };

const textOf = (live: Live | undefined) =>
  live === undefined ? '' : [...live.parts.values()].join('\n\n');

export class AccountLesson implements LessonActions {
  private events: Array<DomainEvent> = [];
  private lastSeq = -1;
  private loaded = false;
  private missing = false;
  private loadError: string | undefined;
  private main: Live | undefined;
  private side: Live | undefined;
  /** Sent, waiting for the stream to report the turn. Keeps the composer disabled meanwhile. */
  private pendingMain = false;
  private pendingSide: string | undefined;
  private mainFailure: UiFailure | undefined;
  private sideFailure: { threadId: string; failure: UiFailure } | undefined;

  private snapshot: AccountLessonState;
  private readonly listeners = new Set<() => void>();
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly client;

  constructor(
    readonly sessionId: string,
    private readonly deps: AccountLessonDeps,
  ) {
    this.client = accountClient(deps.options);
    this.snapshot = this.build();
  }

  // --- subscription: the stream runs while someone listens ---

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    if (this.controller === undefined) this.open();
    return () => {
      this.listeners.delete(listener);
      // A short grace period: a re-render or StrictMode remount does not drop the stream.
      if (this.listeners.size === 0) {
        this.closeTimer = setTimeout(() => this.close(), 1000);
      }
    };
  };
  readonly getSnapshot = (): AccountLessonState => this.snapshot;

  close(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  private emit(now = true) {
    if (!now) {
      this.emitTimer ??= setTimeout(() => {
        this.emitTimer = undefined;
        this.snapshot = this.build();
        this.listeners.forEach((listener) => listener());
      }, 32);
      return;
    }
    this.snapshot = this.build();
    this.listeners.forEach((listener) => listener());
  }

  private build(): AccountLessonState {
    const view: LessonView = this.missing
      ? { status: 'not-found' }
      : !this.loaded
        ? this.loadError === undefined
          ? { status: 'loading' }
          : { status: 'error', message: this.loadError }
        : { status: 'ready', log: this.events, session: projectSession(this.events) };
    const sideThread = this.side?.threadId ?? this.pendingSide ?? this.sideFailure?.threadId;
    return {
      view,
      runner: {
        main: {
          running: this.main !== undefined || this.pendingMain,
          live:
            this.main === undefined
              ? undefined
              : { turnId: this.main.turnId, text: textOf(this.main) },
          failure: this.mainFailure,
        },
        side: {
          running: this.side !== undefined || this.pendingSide !== undefined,
          threadId: sideThread,
          live: this.side === undefined ? undefined : textOf(this.side),
          failure: this.sideFailure?.failure,
        },
      },
    };
  }

  // --- the stream ---

  private open() {
    const controller = new AbortController();
    this.controller = controller;
    void this.follow(controller.signal);
  }

  private async follow(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!this.loaded) await this.load(signal);
        if (signal.aborted) return;
        const ended = await this.stream(signal);
        // A clean end (server closed): connect again at once. A gap: reload the snapshot.
        if (ended === 'gap') this.loaded = false;
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          this.deps.onUnauthorized();
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          this.missing = true;
          this.emit();
          return;
        }
        if (!this.loaded) {
          this.loadError = failureOf(error).message;
          this.emit();
        }
        failures += 1;
        const delay = (this.deps.backoff ?? ((n) => Math.min(10_000, 500 * 2 ** n)))(failures);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async load(signal: AbortSignal) {
    const snapshot = await Effect.runPromise(this.client.snapshot(this.sessionId), {
      signal,
    }).catch((error: unknown) => {
      throw unwrapFiberError(error);
    });
    this.events = snapshot.events.map((entry) => entry.event);
    this.lastSeq = snapshot.events.at(-1)?.seq ?? -1;
    this.applyRunning(snapshot.running);
    this.loaded = true;
    this.loadError = undefined;
    this.emit();
  }

  /** Resolves when the stream ends; `gap` when a `seq` was skipped and the log must be reloaded. */
  private async stream(signal: AbortSignal): Promise<'ended' | 'gap'> {
    const exit = await Effect.runPromiseExit(
      Stream.runForEach(streamSession(this.sessionId, this.lastSeq, this.deps.options), (frame) =>
        this.apply(frame) === 'gap' ? Effect.fail(GAP) : Effect.void,
      ),
      { signal },
    );
    if (exit._tag === 'Failure') {
      if (signal.aborted) return 'ended';
      const reason = exit.cause.reasons.find((r) => r._tag === 'Fail');
      if (reason?._tag === 'Fail' && reason.error === GAP) return 'gap';
      throw reason?._tag === 'Fail' ? reason.error : new Error('The stream failed.');
    }
    return 'ended';
  }

  private applyRunning(turns: ReadonlyArray<RunningTurn>) {
    const toLive = (turn: RunningTurn | undefined): Live | undefined =>
      turn === undefined
        ? undefined
        : {
            turnId: turn.turnId,
            threadId: turn.threadId,
            parts: new Map(turn.text.map((part) => [part.messageId, part.text])),
          };
    this.main = toLive(turns.find((turn) => turn.kind === 'main'));
    this.side = toLive(turns.find((turn) => turn.kind === 'side'));
    if (this.main !== undefined) this.pendingMain = false;
    if (this.side !== undefined) this.pendingSide = undefined;
  }

  private apply(frame: AccountFrame): 'ok' | 'gap' {
    switch (frame._tag) {
      case 'running':
        this.applyRunning(frame.turns);
        this.emit();
        return 'ok';
      case 'log':
        if (frame.seq <= this.lastSeq) return 'ok';
        if (frame.seq !== this.lastSeq + 1) return 'gap';
        this.events = [...this.events, frame.event];
        this.lastSeq = frame.seq;
        this.emit();
        return 'ok';
      case 'delta': {
        const live =
          this.main?.turnId === frame.turnId
            ? this.main
            : this.side?.turnId === frame.turnId
              ? this.side
              : undefined;
        if (live === undefined) return 'ok';
        live.parts.set(frame.messageId, (live.parts.get(frame.messageId) ?? '') + frame.delta);
        this.emit(false);
        return 'ok';
      }
      case 'turn': {
        const live: Live | undefined =
          frame.status === 'running'
            ? { turnId: frame.turnId, threadId: frame.threadId, parts: new Map() }
            : undefined;
        if (frame.kind === 'main') {
          if (live !== undefined || this.main?.turnId === frame.turnId) this.main = live;
          this.pendingMain = false;
        } else {
          if (live !== undefined || this.side?.turnId === frame.turnId) this.side = live;
          this.pendingSide = undefined;
        }
        this.emit();
        return 'ok';
      }
    }
  }

  // --- actions ---

  private async start(request: StartTurnRequest) {
    const isSide = request.kind === 'side';
    if (isSide) {
      this.pendingSide = request.threadId;
      this.sideFailure = undefined;
    } else {
      if (this.main !== undefined || this.pendingMain) return;
      this.pendingMain = true;
      this.mainFailure = undefined;
    }
    this.emit();
    try {
      await Effect.runPromise(this.client.startTurn(this.sessionId, request)).catch(
        (error: unknown) => {
          throw unwrapFiberError(error);
        },
      );
      // The stream reports the turn; until then it counts as pending.
      setTimeout(() => {
        if (isSide) this.pendingSide = undefined;
        else this.pendingMain = false;
        this.emit();
      }, PENDING_MS);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.deps.onUnauthorized();
      const failure = failureOf(error);
      if (isSide) {
        this.pendingSide = undefined;
        this.sideFailure = { threadId: request.threadId, failure };
      } else {
        this.pendingMain = false;
        if (!(request.kind === 'auto' && QUIET_AUTO.has(failure.code))) {
          this.mainFailure = failure;
        }
      }
      this.emit();
    }
  }

  autoStart = () => {
    if (this.main !== undefined || this.pendingMain || this.mainFailure !== undefined) return;
    return this.start({ kind: 'auto' });
  };
  send = (input: string) => this.start({ kind: 'send', input });
  retry = () => this.start({ kind: 'retry' });
  sendSide = (threadId: string, content: string) => this.start({ kind: 'side', threadId, content });
  retrySide = (threadId: string) => this.start({ kind: 'side', threadId });

  skipStep = async (stepId: string) => {
    this.mainFailure = undefined;
    this.pendingMain = true;
    this.emit();
    try {
      await Effect.runPromise(this.client.skipStep(this.sessionId, stepId)).catch(
        (error: unknown) => {
          throw unwrapFiberError(error);
        },
      );
    } catch (error) {
      this.mainFailure = failureOf(error);
    } finally {
      this.pendingMain = false;
      this.emit();
    }
  };

  cancel = async () => {
    const turnId = this.main?.turnId;
    if (turnId === undefined) return;
    try {
      await Effect.runPromise(this.client.cancelTurn(this.sessionId, turnId)).catch(
        (error: unknown) => {
          throw unwrapFiberError(error);
        },
      );
    } catch (error) {
      this.mainFailure = failureOf(error);
      this.emit();
    }
  };

  clearFailure = () => {
    if (this.mainFailure === undefined && this.sideFailure === undefined) return;
    this.mainFailure = undefined;
    this.sideFailure = undefined;
    this.emit();
  };
}

/** `Effect.runPromise` rejects with a wrapper; get the `ApiError` back. */
function unwrapFiberError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof ApiError ? cause : error;
}

// --- registry: one store per (token, session), dropped when the user changes ---

const lessons = new Map<string, AccountLesson>();

export function getAccountLesson(
  token: string,
  sessionId: string,
  deps: AccountLessonDeps,
): AccountLesson {
  const key = `${token}:${sessionId}`;
  let lesson = lessons.get(key);
  if (lesson === undefined) {
    lesson = new AccountLesson(sessionId, deps);
    lessons.set(key, lesson);
  }
  return lesson;
}

export function dropAccountLessons(): void {
  lessons.forEach((lesson) => lesson.close());
  lessons.clear();
}

// Signing in or out drops every store of the previous user.
onUserChange(dropAccountLessons);
