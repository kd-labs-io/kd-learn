// Domain events (plan A1-A5). Every event is plain JSON: it travels over SSE and is stored in SQLite.
// Events are appended only when complete; one turn is written in one transaction.
import { Schema } from 'effect';
import { LessonPlan, StepId } from './plan.ts';
import { TeachingProfile } from './profile.ts';

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Fields every event carries. `id` is made by the writer (core has no id generator). `at` is epoch ms. */
const base = {
  id: Schema.NonEmptyString,
  at: NonNegativeInt,
};

const TurnId = Schema.NonEmptyString;
const MessageId = Schema.NonEmptyString;

/** Mirrors `FinishReason` of the AI port. Duplicated because core imports no other package. */
export const FinishReason = Schema.Literals([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'unknown',
]);
export type FinishReason = typeof FinishReason.Type;

/** Coarse level the Prober reports. Kept small on purpose; the Teacher reads `summary` and `gaps`. */
export const AssessmentLevel = Schema.Literals(['beginner', 'intermediate', 'advanced']);
export type AssessmentLevel = typeof AssessmentLevel.Type;

/** First event of a log. Snapshots the profile so the log is self-contained (the server keeps no state). */
export const SessionCreated = Schema.TaggedStruct('SessionCreated', {
  ...base,
  sessionId: Schema.NonEmptyString,
  topic: Schema.NonEmptyString,
  profile: TeachingProfile,
});

/** Written by the client before the request, so the learner's input is never lost. `input` may be empty for agent-initiated turns. */
export const TurnStarted = Schema.TaggedStruct('TurnStarted', {
  ...base,
  turnId: TurnId,
  input: Schema.String,
});

/** One complete assistant message of a turn (the text deltas merged). */
export const MessageAppended = Schema.TaggedStruct('MessageAppended', {
  ...base,
  turnId: TurnId,
  messageId: MessageId,
  agent: Schema.Literals(['prober', 'teacher']),
  content: Schema.String,
});

/** Token usage summed over the model calls of one turn. `model` is what served them, to price them later. */
export const UsageRecorded = Schema.TaggedStruct('UsageRecorded', {
  ...base,
  turnId: TurnId,
  model: Schema.NonEmptyString,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});

/** Usage of one side chat answer (it has no turn, so no `UsageRecorded`). */
export const SideUsage = Schema.Struct({
  model: Schema.NonEmptyString,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});
export type SideUsage = typeof SideUsage.Type;

export const TurnCompleted = Schema.TaggedStruct('TurnCompleted', {
  ...base,
  turnId: TurnId,
  reason: FinishReason,
});

/** `message` must never contain a key (plan A7). */
export const TurnFailed = Schema.TaggedStruct('TurnFailed', {
  ...base,
  turnId: TurnId,
  code: Schema.NonEmptyString,
  message: Schema.String,
  retryable: Schema.Boolean,
});

/** Result of the Prober's `submit_assessment` tool. `level` is coarse; the Teacher reads `summary` and `gaps`. */
export const AssessmentRecorded = Schema.TaggedStruct('AssessmentRecorded', {
  ...base,
  turnId: TurnId,
  level: AssessmentLevel,
  summary: Schema.NonEmptyString,
  strengths: Schema.Array(Schema.String),
  gaps: Schema.Array(Schema.String),
});

/** Result of the Teacher's `create_plan` tool. The projection validates the DAG. */
export const PlanCreated = Schema.TaggedStruct('PlanCreated', {
  ...base,
  turnId: TurnId,
  plan: LessonPlan,
});

/** Result of the Teacher's `complete_step` tool. */
export const StepCompleted = Schema.TaggedStruct('StepCompleted', {
  ...base,
  turnId: TurnId,
  stepId: StepId,
});

/** The learner chose "next step" after M turns. A learner action, so it has no turn. */
export const StepSkipped = Schema.TaggedStruct('StepSkipped', {
  ...base,
  stepId: StepId,
});

/**
 * Written in the same transaction as the event that resolved the last step. `turnId` is the turn
 * whose tool completed the step; absent when the learner skipped the last step (`StepSkipped` has
 * no turn, so neither has the event that follows it).
 */
export const SessionCompleted = Schema.TaggedStruct('SessionCompleted', {
  ...base,
  turnId: Schema.optionalKey(TurnId),
});

/** Side chat (A5): own thread, never part of the main history, never changes session state. */
export const SideMessageAppended = Schema.TaggedStruct('SideMessageAppended', {
  ...base,
  threadId: Schema.NonEmptyString,
  messageId: MessageId,
  role: Schema.Literals(['user', 'assistant']),
  content: Schema.String,
  /** Step the learner was on. Absent before teaching starts. */
  stepId: Schema.optionalKey(StepId),
  /** Usage of the model call that produced an assistant message. */
  usage: Schema.optionalKey(SideUsage),
});

/**
 * A side chat answer failed. The learner's message is already in the log (the client writes it first),
 * so the UI can offer a retry. `message` must never contain a key (plan A7). Changes no session state.
 */
export const SideTurnFailed = Schema.TaggedStruct('SideTurnFailed', {
  ...base,
  threadId: Schema.NonEmptyString,
  code: Schema.NonEmptyString,
  message: Schema.String,
  retryable: Schema.Boolean,
});

export const DomainEvent = Schema.Union([
  SessionCreated,
  TurnStarted,
  MessageAppended,
  UsageRecorded,
  TurnCompleted,
  TurnFailed,
  AssessmentRecorded,
  PlanCreated,
  StepCompleted,
  StepSkipped,
  SessionCompleted,
  SideMessageAppended,
  SideTurnFailed,
]);
export type DomainEvent = typeof DomainEvent.Type;

/** The event log of one session, oldest first. This is what the client sends with every turn. */
export const EventLog = Schema.Array(DomainEvent);
export type EventLog = typeof EventLog.Type;
