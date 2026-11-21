// Practice routes (plan luyen-tap-graph.md A7, A8). Two modes, like turns:
// - Guest and demo: `POST /api/practice/issue` and `POST /api/practice/grade` keep no state. The
//   client sends the model choice (key included), the slice of its graph the exercises need, and
//   gets back the events to append to its own knowledge log. Types graded by code are graded on
//   the client (`gradeByCode` in @kd-learn/core), never sent here.
// - Account: paths below `ACCOUNT_PRACTICE_PATH`; the server writes the log. Before an exercise is
//   graded its answer key (`correctIndex`, `constraints`, `reference`) is never sent.
//   GET  /                               open practices (PracticeList)
//   POST /                               start one (StartPracticeRequest) -> PracticeView, 201
//   GET  /:practiceId                    one practice, open or ended (PracticeView)
//   POST /:practiceId/end                end it -> PracticeView
//   POST /exercises/:exerciseId/answer   submit and grade (AnswerRequest) -> ExerciseView
//   POST /exercises/:exerciseId/grade    grade the stored answer again (after a failure or a
//                                        dropped connection) -> ExerciseView
import { Schema } from 'effect';
import {
  EdgeId,
  ExerciseAnswer,
  ExerciseContent,
  ExerciseTypeId,
  Feedback,
  KnowledgeLog,
  PropositionId,
  Relation,
  Score,
  TeachingProfile,
} from '@kd-learn/core';
import { ModelChoice } from './contract.ts';

export const PRACTICE_ISSUE_PATH = '/api/practice/issue';
export const PRACTICE_GRADE_PATH = '/api/practice/grade';
export const ACCOUNT_PRACTICE_PATH = '/api/account/practice';

/** Exercises of one practice at most. */
export const MAX_PRACTICE_EXERCISES = 10;

/** What one exercise tests, as `selectExercises` chose it on the client. */
export const ExerciseTargetInput = Schema.Struct({
  type: ExerciseTypeId,
  propositionIds: Schema.NonEmptyArray(PropositionId).check(Schema.isMaxLength(6)),
  edgeIds: Schema.Array(EdgeId).check(Schema.isMaxLength(20)),
});
export type ExerciseTargetInput = typeof ExerciseTargetInput.Type;

/**
 * The part of the guest's graph the exercises need: the target propositions, their neighbours
 * (material for distractors) and the edges between them.
 */
export const KnowledgeSlice = Schema.Struct({
  propositions: Schema.Array(
    Schema.Struct({
      propositionId: PropositionId,
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
    }),
  ).check(Schema.isMaxLength(200)),
  edges: Schema.Array(
    Schema.Struct({
      edgeId: EdgeId,
      from: PropositionId,
      to: PropositionId,
      relation: Relation,
      label: Schema.String.check(Schema.isMaxLength(200)),
    }),
  ).check(Schema.isMaxLength(400)),
});
export type KnowledgeSlice = typeof KnowledgeSlice.Type;

/**
 * `POST /api/practice/issue`. `profile` is the guest's own; demo mode uses the server's profile
 * and keeps only its language. Decode with `onExcessProperty: 'error'`.
 */
export const IssueExercisesRequest = Schema.Struct({
  model: ModelChoice,
  profile: TeachingProfile,
  slice: KnowledgeSlice,
  targets: Schema.Array(ExerciseTargetInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PRACTICE_EXERCISES),
  ),
});
export type IssueExercisesRequest = typeof IssueExercisesRequest.Type;

/**
 * `PracticeStarted` and one `ExerciseIssued` per exercise written, to append in one batch (checked
 * append). Targets that no longer fit (an ordering chain that broke) are left out.
 */
export const IssueExercisesResponse = Schema.Struct({ events: KnowledgeLog });
export type IssueExercisesResponse = typeof IssueExercisesResponse.Type;

/** `POST /api/practice/grade`: model-graded types only (`shortAnswer`, `explainReasoning`). */
export const GradeAnswerRequest = Schema.Struct({
  model: ModelChoice,
  profile: TeachingProfile,
  exerciseId: Schema.NonEmptyString,
  content: ExerciseContent,
  answer: ExerciseAnswer,
});
export type GradeAnswerRequest = typeof GradeAnswerRequest.Type;

/** One `ExerciseGraded` to append after the guest's `AnswerSubmitted`. */
export const GradeAnswerResponse = Schema.Struct({ events: KnowledgeLog });
export type GradeAnswerResponse = typeof GradeAnswerResponse.Type;

// Account practice.

/** `POST /api/account/practice`. `types`: the types the screen can render (default: all). */
export const StartPracticeRequest = Schema.Struct({
  count: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_PRACTICE_EXERCISES),
    ),
  ),
  types: Schema.optionalKey(Schema.Array(ExerciseTypeId).check(Schema.isMinLength(1))),
});
export type StartPracticeRequest = typeof StartPracticeRequest.Type;

export const AnswerRequest = Schema.Struct({ answer: ExerciseAnswer });
export type AnswerRequest = typeof AnswerRequest.Type;

/** What the learner sees of an exercise before it is graded: no answer key. */
export const PublicExerciseContent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('multipleChoice'),
    question: Schema.String,
    options: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal('shortAnswer'), question: Schema.String }),
  Schema.Struct({ type: Schema.Literal('explainReasoning'), question: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('orderChain'),
    /** In the order shown. */
    items: Schema.Array(Schema.Struct({ propositionId: PropositionId, text: Schema.String })),
  }),
]);
export type PublicExerciseContent = typeof PublicExerciseContent.Type;

export const ExerciseGradeView = Schema.Struct({
  score: Score,
  feedback: Feedback,
  profileId: Schema.optionalKey(Schema.String),
  gradedAt: Schema.Number,
});

export const ExerciseView = Schema.Struct({
  exerciseId: Schema.NonEmptyString,
  practiceId: Schema.NonEmptyString,
  type: ExerciseTypeId,
  propositionIds: Schema.Array(PropositionId),
  edgeIds: Schema.Array(EdgeId),
  content: PublicExerciseContent,
  issuedAt: Schema.Number,
  answer: Schema.optionalKey(ExerciseAnswer),
  answeredAt: Schema.optionalKey(Schema.Number),
  grade: Schema.optionalKey(ExerciseGradeView),
  /** The full content with its answer key, once graded. */
  solution: Schema.optionalKey(ExerciseContent),
});
export type ExerciseView = typeof ExerciseView.Type;

export const PracticeView = Schema.Struct({
  practiceId: Schema.NonEmptyString,
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  exercises: Schema.Array(ExerciseView),
});
export type PracticeView = typeof PracticeView.Type;

export const PracticeList = Schema.Struct({ practices: Schema.Array(PracticeView) });
export type PracticeList = typeof PracticeList.Type;
