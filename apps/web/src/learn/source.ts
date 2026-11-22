// What the learning screen needs, whoever keeps the log: the guest runner over the local DB, or
// the account store over the server's snapshot and stream (plan step 8: one screen for both).
import type { EventLog, ProjectionError, Session } from '@kd-learn/core';
import type { Result } from 'effect';
import type { LessonSources } from '../sources/library';
import type { RunnerState } from './runner';
import type { FigureBodyLoader } from '@kd-learn/ui/components/LessonFigure';

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
  /**
   * Resolves to `false` when nothing was kept (the server refused the turn), so the screen gives
   * the text back. The guest runner writes the input before the request and resolves to nothing.
   */
  send(input: string): void | Promise<void | boolean>;
  retry(): void | Promise<void | boolean>;
  skipStep(stepId: string): void | Promise<void>;
  /** Like `send`: `false` when the message was not kept. */
  sendSide(threadId: string, content: string): void | Promise<void | boolean>;
  retrySide(threadId: string): void | Promise<void | boolean>;
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
  /** Sources to attach and the chunks citations open (phase 4). */
  readonly sources?: LessonSources;
  /** Reads a figure body (phase 5). */
  readonly loadFigure: FigureBodyLoader;
}
