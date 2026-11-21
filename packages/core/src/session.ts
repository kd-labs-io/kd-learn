// Session projection (plan A1, A3, A4): the event log is the source of truth, `Session` is derived from it.
// Pure and total: a log that breaks the rules gives a `ProjectionError` instead of a half-built session.
// The log comes from the client, so nothing in it is trusted.
import { Data, Result } from 'effect';
import type { DomainEvent } from './event.ts';
import { isPlanResolved, nextStep, validatePlan } from './plan.ts';
import type { LessonPlan, PlanNode, StepId } from './plan.ts';
import type { TeachingProfile } from './profile.ts';

/** `probing -> planning -> teaching(step) -> done` (plan A4). */
export type SessionState =
  | {
      readonly _tag: 'Probing';
      /** Turns completed while probing, to compare with `profile.maxProbeQuestions` (N). */
      readonly turnsCompleted: number;
    }
  | { readonly _tag: 'Planning' }
  | {
      readonly _tag: 'Teaching';
      /**
       * The step being taught. Undefined only between the event that resolved the last step and
       * `SessionCompleted`, which the writer appends in the same transaction.
       */
      readonly stepId: StepId | undefined;
      /** Completed turns spent on this step without finishing it, to compare with `profile.maxTurnsPerStep` (M). */
      readonly turnsInStep: number;
    }
  | { readonly _tag: 'Done' };

export type TurnStatus = 'started' | 'completed' | 'failed';

export interface Turn {
  readonly turnId: string;
  readonly input: string;
  readonly status: TurnStatus;
  /** Present when `status` is `failed`. */
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface HistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface SideMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly stepId?: StepId;
}

export interface Assessment {
  readonly level: 'beginner' | 'intermediate' | 'advanced';
  readonly summary: string;
  readonly strengths: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
}

export interface Session {
  readonly sessionId: string;
  readonly topic: string;
  readonly profile: TeachingProfile;
  readonly state: SessionState;
  readonly assessment: Assessment | undefined;
  readonly plan: LessonPlan | undefined;
  readonly completedSteps: ReadonlyArray<StepId>;
  readonly skippedSteps: ReadonlyArray<StepId>;
  /** Every turn in order, with its status. */
  readonly turns: ReadonlyArray<Turn>;
  /**
   * Main-thread messages for the model: user input and assistant messages of completed turns only.
   * A failed or interrupted turn leaves no trace here, so a retry can resend the same input.
   */
  readonly history: ReadonlyArray<HistoryMessage>;
  /** Side chat messages by thread id (plan A5). Not part of `history`. */
  readonly sideThreads: Readonly<Record<string, ReadonlyArray<SideMessage>>>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** The log breaks a rule. `index` is the position of the offending event (-1 for an empty log). */
export class ProjectionError extends Data.TaggedError('ProjectionError')<{
  readonly index: number;
  readonly message: string;
}> {}

interface TurnDraft {
  turnId: string;
  input: string;
  status: TurnStatus;
  failure?: Turn['failure'];
  messages: Array<string>;
  /** The turn moved the session on (assessment, plan, step), so it does not count towards N or M. */
  moved: boolean;
}

/** Builds the session from an event log, oldest event first. */
export const projectSession = (
  events: ReadonlyArray<DomainEvent>,
): Result.Result<Session, ProjectionError> => {
  const first = events[0];
  if (first === undefined) {
    return Result.fail(new ProjectionError({ index: -1, message: 'The event log is empty.' }));
  }
  if (first._tag !== 'SessionCreated') {
    return Result.fail(
      new ProjectionError({ index: 0, message: 'The first event must be SessionCreated.' }),
    );
  }

  let state: SessionState = { _tag: 'Probing', turnsCompleted: 0 };
  let assessment: Assessment | undefined;
  let plan: LessonPlan | undefined;
  const completed: Array<StepId> = [];
  const skipped: Array<StepId> = [];
  const resolved = new Set<StepId>();
  const turns: Array<TurnDraft> = [];
  const turnById = new Map<string, TurnDraft>();
  const sideThreads: Record<string, Array<SideMessage>> = {};
  let inputTokens = 0;
  let outputTokens = 0;

  const fail = (index: number, message: string) =>
    Result.fail(new ProjectionError({ index, message }));

  /** Moves to the next step of the plan, or leaves the session waiting for `SessionCompleted`. */
  const advance = () => {
    state = { _tag: 'Teaching', stepId: nextStep(plan!, resolved)?.id, turnsInStep: 0 };
  };

  for (let index = 1; index < events.length; index++) {
    const event = events[index]!;
    // Turn-scoped events must belong to a turn that has started and not ended.
    const openTurn = (turnId: string) => {
      const turn = turnById.get(turnId);
      if (turn === undefined) return `Event ${event._tag} refers to unknown turn "${turnId}".`;
      if (turn.status !== 'started') return `Turn "${turnId}" has already ended.`;
      return turn;
    };

    switch (event._tag) {
      case 'SessionCreated':
        return fail(index, 'SessionCreated may only be the first event.');

      case 'TurnStarted': {
        if (state._tag === 'Done') return fail(index, 'The session is done; no more turns.');
        if (turnById.has(event.turnId))
          return fail(index, `Turn "${event.turnId}" already exists.`);
        const turn: TurnDraft = {
          turnId: event.turnId,
          input: event.input,
          status: 'started',
          messages: [],
          moved: false,
        };
        turns.push(turn);
        turnById.set(turn.turnId, turn);
        break;
      }

      case 'MessageAppended': {
        const turn = openTurn(event.turnId);
        if (typeof turn === 'string') return fail(index, turn);
        turn.messages.push(event.content);
        break;
      }

      case 'UsageRecorded': {
        const turn = openTurn(event.turnId);
        if (typeof turn === 'string') return fail(index, turn);
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        break;
      }

      case 'TurnCompleted': {
        const turn = openTurn(event.turnId);
        if (typeof turn === 'string') return fail(index, turn);
        turn.status = 'completed';
        if (!turn.moved) {
          if (state._tag === 'Probing') {
            state = { _tag: 'Probing', turnsCompleted: state.turnsCompleted + 1 };
          } else if (state._tag === 'Teaching') {
            state = { _tag: 'Teaching', stepId: state.stepId, turnsInStep: state.turnsInStep + 1 };
          }
        }
        break;
      }

      case 'TurnFailed': {
        const turn = openTurn(event.turnId);
        if (typeof turn === 'string') return fail(index, turn);
        turn.status = 'failed';
        turn.failure = { code: event.code, message: event.message, retryable: event.retryable };
        break;
      }

      case 'AssessmentRecorded': {
        const turn = openTurn(event.turnId);
        if (typeof turn === 'string') return fail(index, turn);
        if (state._tag !== 'Probing') {
          return fail(
            index,
            `AssessmentRecorded is only valid while probing (state: ${state._tag}).`,
          );
        }
        assessment = {
          level: event.level,
          summary: event.summary,
          strengths: event.strengths,
          gaps: event.gaps,
        };
        turn.moved = true;
        state = { _tag: 'Planning' };
        break;
      }

      case 'PlanCreated': {
        const turn = openTurn(event.turnId);
        if (typeof turn === 'string') return fail(index, turn);
        if (state._tag !== 'Planning') {
          return fail(index, `PlanCreated is only valid while planning (state: ${state._tag}).`);
        }
        const valid = validatePlan(event.plan);
        if (Result.isFailure(valid)) return fail(index, valid.failure.message);
        plan = valid.success;
        turn.moved = true;
        advance();
        break;
      }

      case 'StepCompleted':
      case 'StepSkipped': {
        if (event._tag === 'StepCompleted') {
          const turn = openTurn(event.turnId);
          if (typeof turn === 'string') return fail(index, turn);
          turn.moved = true;
        }
        if (state._tag !== 'Teaching' || state.stepId === undefined) {
          return fail(index, `${event._tag} is only valid while a step is being taught.`);
        }
        if (event.stepId !== state.stepId) {
          return fail(
            index,
            `${event._tag} is for step "${event.stepId}" but the current step is "${state.stepId}".`,
          );
        }
        (event._tag === 'StepCompleted' ? completed : skipped).push(event.stepId);
        resolved.add(event.stepId);
        advance();
        break;
      }

      case 'SessionCompleted': {
        const turn = openTurn(event.turnId);
        if (typeof turn === 'string') return fail(index, turn);
        if (state._tag !== 'Teaching' || plan === undefined || !isPlanResolved(plan, resolved)) {
          return fail(index, 'SessionCompleted is only valid when every step is resolved.');
        }
        turn.moved = true;
        state = { _tag: 'Done' };
        break;
      }

      case 'SideMessageAppended': {
        const thread = (sideThreads[event.threadId] ??= []);
        thread.push({
          messageId: event.messageId,
          role: event.role,
          content: event.content,
          ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        });
        if (event.usage !== undefined) {
          inputTokens += event.usage.inputTokens;
          outputTokens += event.usage.outputTokens;
        }
        break;
      }

      case 'SideTurnFailed':
        // Changes no state: the UI reads the log to offer a retry.
        break;
    }
  }

  const history: Array<HistoryMessage> = [];
  for (const turn of turns) {
    if (turn.status !== 'completed') continue;
    history.push({ role: 'user', content: turn.input });
    for (const content of turn.messages) history.push({ role: 'assistant', content });
  }

  return Result.succeed({
    sessionId: first.sessionId,
    topic: first.topic,
    profile: first.profile,
    state,
    assessment,
    plan,
    completedSteps: completed,
    skippedSteps: skipped,
    turns: turns.map(({ turnId, input, status, failure }) => ({
      turnId,
      input,
      status,
      ...(failure === undefined ? {} : { failure }),
    })),
    history,
    sideThreads,
    usage: { inputTokens, outputTokens },
  });
};

/**
 * The latest turn if it started and never ended (plan A3): the page was reloaded or the connection
 * dropped mid-turn. The UI offers a retry that resends `input`. Older open turns were superseded
 * by a later turn and are ignored.
 */
export const findInterruptedTurn = (session: Session): Turn | undefined => {
  const last = session.turns.at(-1);
  return last?.status === 'started' ? last : undefined;
};

/** The node being taught, if the session is teaching. */
export const currentStep = (session: Session): PlanNode | undefined => {
  if (session.state._tag !== 'Teaching' || session.plan === undefined) return undefined;
  const { stepId } = session.state;
  return session.plan.nodes.find((node) => node.id === stepId);
};

/** Plan A4: after M turns on a step the learner may skip it. */
export const canSkipStep = (session: Session): boolean =>
  session.state._tag === 'Teaching' &&
  session.state.stepId !== undefined &&
  session.state.turnsInStep >= session.profile.maxTurnsPerStep;
