// What the learning screen needs, whoever keeps the log: the guest runner over the local DB, or
// the account store over the server's snapshot and stream (plan step 8: one screen for both).
import type { EventLog, ProjectionError, Session } from '@kd-learn/core';
import type { Result } from 'effect';
import type { RunnerState } from './runner';

export type LessonView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  /** No such session (for an account, also one that belongs to someone else). */
  | { readonly status: 'not-found' }
  | {
      readonly status: 'ready';
      readonly log: EventLog;
      readonly session: Result.Result<Session, ProjectionError>;
    };

/** The actions of the screen. None of them rejects: failures show up in `RunnerState`. */
export interface LessonActions {
  /** The turn that needs no input (first Prober turn, planning), when it is due. */
  autoStart(): void | Promise<void>;
  send(input: string): void | Promise<void>;
  retry(): void | Promise<void>;
  skipStep(stepId: string): void | Promise<void>;
  sendSide(threadId: string, content: string): void | Promise<void>;
  retrySide(threadId: string): void | Promise<void>;
  clearFailure(): void;
  /** Stops the running main turn. Only where turns outlive the page (accounts). */
  cancel?: () => void | Promise<void>;
}

export interface LessonSource {
  readonly view: LessonView;
  readonly state: RunnerState;
  readonly actions: LessonActions;
  /** Another tab runs the open turn (guest mode, Web Lock). Always false for accounts. */
  readonly elsewhere: boolean;
  /** False when nothing is kept after closing (guest in-memory fallback). */
  readonly persistent: boolean | undefined;
}
