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
  type Exercise,
  ExerciseAnswer,
  ExerciseContent,
  ExerciseTypeId,
  Feedback,
  type KnowledgeGraph,
  KnowledgeLog,
  maxPropositionLength,
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
  edgeIds: Schema.Array(EdgeId).check(Schema.isMaxLength(100)),
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
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxPropositionLength)),
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

/** Mastery of one proposition an exercise tests, as it is after the grade. */
export const MasteryView = Schema.Struct({
  propositionId: PropositionId,
  box: Schema.Int,
  attempts: Schema.Int,
  lastScore: Score,
  dueAt: Schema.Number,
});
export type MasteryView = typeof MasteryView.Type;

export const ExerciseView = Schema.Struct({
  exerciseId: Schema.NonEmptyString,
  practiceId: Schema.NonEmptyString,
  type: ExerciseTypeId,
  content: PublicExerciseContent,
  issuedAt: Schema.Number,
  answer: Schema.optionalKey(ExerciseAnswer),
  answeredAt: Schema.optionalKey(Schema.Number),
  grade: Schema.optionalKey(ExerciseGradeView),
  /** The full content with its answer key, once graded. */
  solution: Schema.optionalKey(ExerciseContent),
  /**
   * What it tests, once graded. Hidden before: with the graph they give the answer away (the
   * proposition a multiple choice asks for, the edges of an ordering).
   */
  propositionIds: Schema.optionalKey(Schema.Array(PropositionId)),
  edgeIds: Schema.optionalKey(Schema.Array(EdgeId)),
  /**
   * Mastery of the propositions it tests, as the graph has it now (A7), once graded. Absent for a
   * proposition retired since; a merged one shows the proposition it was merged into.
   */
  mastery: Schema.optionalKey(Schema.Array(MasteryView)),
});
export type ExerciseView = typeof ExerciseView.Type;

export const PracticeView = Schema.Struct({
  practiceId: Schema.NonEmptyString,
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  exercises: Schema.Array(ExerciseView),
});
export type PracticeView = typeof PracticeView.Type;

export const PracticeList = Schema.Struct({
  practices: Schema.Array(PracticeView),
  /** Active propositions of the graph: 0 means there is nothing to practice yet. */
  propositionCount: Schema.Int,
});
export type PracticeList = typeof PracticeList.Type;

// Views of the projected graph, shared by the server (account) and the web app (guest), so both
// modes hide the same fields.

/** The learner-facing part of a content, picked field by field so an answer key cannot slip out. */
export const publicContent = (content: ExerciseContent): PublicExerciseContent => {
  switch (content.type) {
    case 'multipleChoice':
      return { type: content.type, question: content.question, options: content.options };
    case 'shortAnswer':
    case 'explainReasoning':
      return { type: content.type, question: content.question };
    case 'orderChain':
      return {
        type: content.type,
        items: content.items.map(({ propositionId, text }) => ({ propositionId, text })),
      };
  }
};

/** Follows merges to the proposition kept; undefined for a retired one. */
const activeId = (graph: KnowledgeGraph, id: PropositionId): PropositionId | undefined => {
  let current = id;
  for (let i = 0; i < 100; i++) {
    if (graph.propositions[current] !== undefined) return current;
    const gone = graph.inactive[current];
    if (gone?._tag !== 'Merged') return undefined;
    current = gone.into;
  }
  return undefined;
};

const masteryOf = (graph: KnowledgeGraph, exercise: Exercise): ReadonlyArray<MasteryView> => {
  const seen = new Set<PropositionId>();
  const out: Array<MasteryView> = [];
  for (const id of exercise.propositionIds) {
    const active = activeId(graph, id);
    if (active === undefined || seen.has(active)) continue;
    seen.add(active);
    const mastery = graph.mastery[active];
    if (mastery === undefined) continue;
    out.push({
      propositionId: active,
      box: mastery.box,
      attempts: mastery.attempts,
      lastScore: mastery.lastScore,
      dueAt: mastery.dueAt,
    });
  }
  return out;
};

export const exerciseView = (graph: KnowledgeGraph, exercise: Exercise): ExerciseView => ({
  exerciseId: exercise.exerciseId,
  practiceId: exercise.practiceId,
  type: exercise.type,
  content: publicContent(exercise.content),
  issuedAt: exercise.issuedAt,
  ...(exercise.answer === undefined ? {} : { answer: exercise.answer }),
  ...(exercise.answeredAt === undefined ? {} : { answeredAt: exercise.answeredAt }),
  ...(exercise.grade === undefined
    ? {}
    : {
        grade: exercise.grade,
        solution: exercise.content,
        propositionIds: exercise.propositionIds,
        edgeIds: exercise.edgeIds,
        mastery: masteryOf(graph, exercise),
      }),
});

export const practiceView = (
  graph: KnowledgeGraph,
  practiceId: string,
): PracticeView | undefined => {
  const practice = graph.practices[practiceId];
  if (practice === undefined) return undefined;
  return {
    practiceId,
    startedAt: practice.startedAt,
    ...(practice.endedAt === undefined ? {} : { endedAt: practice.endedAt }),
    exercises: practice.exerciseIds.map((id) => exerciseView(graph, graph.exercises[id]!)),
  };
};

/** The open practices, oldest first, and the size of the graph. */
export const practiceList = (graph: KnowledgeGraph): PracticeList => ({
  practices: Object.values(graph.practices)
    .filter((p) => p.endedAt === undefined)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((p) => practiceView(graph, p.practiceId)!),
  propositionCount: Object.keys(graph.propositions).length,
});
