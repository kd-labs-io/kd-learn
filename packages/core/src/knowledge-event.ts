// Events of the knowledge log (plan luyen-tap-graph.md A1, A3): one append-only log per owner that
// holds the graph of every session and, from step 6, the practice results. Plain JSON, like the
// session events, but a separate union: the two logs live in different tables and never mix.
import { Schema } from 'effect';
import { StepId } from './plan.ts';

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Fields every event carries. `id` is made by the writer. `at` is epoch ms. */
const base = {
  id: Schema.NonEmptyString,
  at: NonNegativeInt,
};

export const PropositionId = Schema.NonEmptyString;
export type PropositionId = typeof PropositionId.Type;

export const EdgeId = Schema.NonEmptyString;
export type EdgeId = typeof EdgeId.Type;

/** Longest proposition text. A proposition is one claim; anything longer is not one. */
export const maxPropositionLength = 1000;
const PropositionText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maxPropositionLength),
);
const Topic = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Label = Schema.String.check(Schema.isMaxLength(200));

/**
 * Relation of an edge, read as "from RELATION to" (fixed in step 1):
 * - `requires`: from needs to be understood first, so `to` comes before `from`;
 * - `implies`: from logically leads to `to`, so `from` comes before `to`;
 * - `supports`: from is evidence or a reason for `to`;
 * - `exampleOf`: from is an instance of `to`;
 * - `contrastsWith`: the two are commonly confused. Undirected: both directions are one edge.
 * `requires` and `implies` are the ordered relations: together they must stay acyclic, and a
 * reasoning chain is a path along them.
 */
export const Relation = Schema.Literals([
  'requires',
  'implies',
  'supports',
  'exampleOf',
  'contrastsWith',
]);
export type Relation = typeof Relation.Type;

/** Where a proposition was taught or shown: a session, and the plan step when there was one. */
export const PropositionSource = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  stepId: Schema.optionalKey(StepId),
});
export type PropositionSource = typeof PropositionSource.Type;

/** A new proposition: one self-contained claim (no "it", no "as above"). */
export const PropositionAdded = Schema.TaggedStruct('PropositionAdded', {
  ...base,
  propositionId: PropositionId,
  text: PropositionText,
  topic: Topic,
  source: PropositionSource,
});

/**
 * Another session taught a proposition the graph already has (merge found it the same). Not in the
 * first event list of A1: merge "adds a source" to the old proposition and needs an event for it.
 */
export const PropositionSourced = Schema.TaggedStruct('PropositionSourced', {
  ...base,
  propositionId: PropositionId,
  source: PropositionSource,
});

/** New wording of an existing proposition. Same claim; a different claim is a new proposition. */
export const PropositionRevised = Schema.TaggedStruct('PropositionRevised', {
  ...base,
  propositionId: PropositionId,
  text: PropositionText,
});

/**
 * Two existing propositions are the same claim: `from` is folded into `into`. Its sources move to
 * `into`, its edges are re-pointed to `into` (self-loops and duplicates are dropped), and `from`
 * stops being active.
 */
export const PropositionsMerged = Schema.TaggedStruct('PropositionsMerged', {
  ...base,
  from: PropositionId,
  into: PropositionId,
});

/** The learner dropped a wrong proposition. Its edges go with it. */
export const PropositionRetired = Schema.TaggedStruct('PropositionRetired', {
  ...base,
  propositionId: PropositionId,
});

export const EdgeAdded = Schema.TaggedStruct('EdgeAdded', {
  ...base,
  edgeId: EdgeId,
  from: PropositionId,
  to: PropositionId,
  relation: Relation,
  /** Short phrase that explains the link. */
  label: Label,
});

export const EdgeRemoved = Schema.TaggedStruct('EdgeRemoved', {
  ...base,
  edgeId: EdgeId,
});

/** Written before the model is called, like `TurnStarted` (A3). */
export const ExtractionStarted = Schema.TaggedStruct('ExtractionStarted', {
  ...base,
  sessionId: Schema.NonEmptyString,
  extractionId: Schema.NonEmptyString,
});

/**
 * Last event of the batch that holds the result of one extraction. At most one per session: a
 * second one is rejected, so two writers extracting one session cannot both add propositions.
 */
export const SessionExtracted = Schema.TaggedStruct('SessionExtracted', {
  ...base,
  sessionId: Schema.NonEmptyString,
  extractionId: Schema.NonEmptyString,
  /** Profile whose prompts ran the extraction (A2). */
  profileId: Schema.NonEmptyString,
});

/** `message` must never contain a key. `Interrupted` and `Conflict` are written by the runner. */
export const ExtractionFailed = Schema.TaggedStruct('ExtractionFailed', {
  ...base,
  sessionId: Schema.NonEmptyString,
  extractionId: Schema.NonEmptyString,
  code: Schema.NonEmptyString,
  message: Schema.String,
  retryable: Schema.Boolean,
});

export const KnowledgeEvent = Schema.Union([
  PropositionAdded,
  PropositionSourced,
  PropositionRevised,
  PropositionsMerged,
  PropositionRetired,
  EdgeAdded,
  EdgeRemoved,
  ExtractionStarted,
  SessionExtracted,
  ExtractionFailed,
]);
export type KnowledgeEvent = typeof KnowledgeEvent.Type;

/** The knowledge log of one owner, oldest first. */
export const KnowledgeLog = Schema.Array(KnowledgeEvent);
export type KnowledgeLog = typeof KnowledgeLog.Type;
