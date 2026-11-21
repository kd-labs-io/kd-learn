// Pure helpers that turn a projected session into what the learning screen shows.
import { m } from '@kd-learn/i18n';
import { findInterruptedTurn, type PlanNode, type Session } from '@kd-learn/core';
import { ClientFailure, type UiFailure } from './runner';

export interface ChatItem {
  readonly key: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** The learner's input of a turn that has no answer yet (failed or interrupted). */
  readonly pending?: boolean;
}

/** The main conversation: completed turns, then the input of an unanswered last turn. */
export function conversationOf(session: Session): ReadonlyArray<ChatItem> {
  const items: Array<ChatItem> = [];
  session.history.forEach((message, index) => {
    // Agent-started turns (first Prober turn, planning) have empty input: nothing to show.
    if (message.role === 'user' && message.content === '') return;
    items.push({ key: `h${index}`, role: message.role, content: message.content });
  });
  const last = session.turns.at(-1);
  if (last !== undefined && last.status !== 'completed' && last.input !== '') {
    items.push({ key: `p${last.turnId}`, role: 'user', content: last.input, pending: true });
  }
  return items;
}

export type StepStatus = 'done' | 'skipped' | 'current' | 'waiting';

export interface PlanRow {
  readonly node: PlanNode;
  readonly status: StepStatus;
}

export function planRows(session: Session): ReadonlyArray<PlanRow> {
  if (session.plan === undefined) return [];
  const current = session.state._tag === 'Teaching' ? session.state.stepId : undefined;
  return session.plan.nodes.map((node) => ({
    node,
    status: session.completedSteps.includes(node.id)
      ? 'done'
      : session.skippedSteps.includes(node.id)
        ? 'skipped'
        : node.id === current
          ? 'current'
          : 'waiting',
  }));
}

/** Where the learner can go to fix a failure. */
export type FailureAction = 'settings' | 'new-session' | undefined;

const SERVER_CODES = new Set([
  'InvalidRequest',
  'InvalidTurn',
  'ServerMisconfigured',
  'InternalError',
  'MethodNotAllowed',
  'OutputInvalid',
]);

export function failureText(failure: UiFailure): string {
  switch (failure.code) {
    case ClientFailure.Network:
      return m.error_Network();
    case ClientFailure.NoKey:
      return m.error_NoKey();
    case ClientFailure.Busy:
      return m.error_Busy();
    case ClientFailure.InvalidLog:
      return m.error_InvalidLog();
    case ClientFailure.Storage:
      return m.error_Storage();
    case 'HistoryTooLarge':
      return m.error_HistoryTooLarge();
    case 'UnknownEndpoint':
      return m.error_UnknownEndpoint();
    default:
      // A provider code that cannot be retried is a key, model or permission problem.
      return failure.retryable || SERVER_CODES.has(failure.code)
        ? m.error_generic({ message: failure.message })
        : m.error_provider_rejected();
  }
}

export function failureAction(failure: UiFailure): FailureAction {
  switch (failure.code) {
    case 'HistoryTooLarge':
      return 'new-session';
    case 'UnknownEndpoint':
    case ClientFailure.NoKey:
      return 'settings';
    default:
      return !failure.retryable &&
        !SERVER_CODES.has(failure.code) &&
        !Object.values(ClientFailure).includes(failure.code as never)
        ? 'settings'
        : undefined;
  }
}

/** What the screen says about the state of the last turn. */
export type TurnBanner =
  | { readonly kind: 'none' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'failed'; readonly failure: UiFailure };

/**
 * The persisted state wins over what this tab saw: a reload loses the in-memory failure, but the
 * log still says the last turn failed (`TurnFailed`) or never ended (interrupted, plan A3).
 * The in-memory failure is used while the log has nothing (no key, busy, network).
 */
export function turnBanner(session: Session, memory: UiFailure | undefined): TurnBanner {
  if (memory !== undefined) return { kind: 'failed', failure: memory };
  const last = session.turns.at(-1);
  if (last?.status === 'failed' && last.failure !== undefined) {
    return { kind: 'failed', failure: last.failure };
  }
  return findInterruptedTurn(session) === undefined ? { kind: 'none' } : { kind: 'interrupted' };
}

/** True when the learner must resolve the last turn (retry) before sending something new. */
export const hasUnresolvedTurn = (session: Session): boolean => {
  const last = session.turns.at(-1);
  return last !== undefined && last.status !== 'completed';
};
