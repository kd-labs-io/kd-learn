// Content and answer schemas of the exercise types (plan luyen-tap-graph.md A6). Pure schemas with
// no graph code, so the knowledge events can carry them and `exercises.ts` (the registry) can add
// eligibility and grading on top. An exercise is self-contained: it carries what grading needs
// (the correct option, the order constraints, the reference propositions), so it can be graded
// after the graph has changed, and a stateless server can grade it from what the client sends.
import { Schema } from 'effect';
import { PropositionId, Relation } from './knowledge-ids.ts';

/** Ids of the exercise types. Adding a type adds an id here, a module in `exercises.ts` and a renderer. */
export const ExerciseTypeId = Schema.Literals([
  'multipleChoice',
  'shortAnswer',
  'explainReasoning',
  'orderChain',
]);
export type ExerciseTypeId = typeof ExerciseTypeId.Type;

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const maxQuestionLength = 2000;
export const maxAnswerLength = 4000;
export const maxFeedbackLength = 2000;

/** What a model-graded exercise is graded against: the propositions and edges it tests. */
export const ExerciseReference = Schema.Struct({
  propositions: Schema.Array(Schema.Struct({ propositionId: PropositionId, text: Schema.String })),
  edges: Schema.Array(
    Schema.Struct({
      from: PropositionId,
      to: PropositionId,
      relation: Relation,
      label: Schema.String,
    }),
  ),
});
export type ExerciseReference = typeof ExerciseReference.Type;

/** One "before -> after" constraint of an ordering exercise. */
export const OrderConstraint = Schema.Struct({ before: PropositionId, after: PropositionId });
export type OrderConstraint = typeof OrderConstraint.Type;

export const MultipleChoiceContent = Schema.Struct({
  type: Schema.Literal('multipleChoice'),
  question: Text(maxQuestionLength),
  options: Schema.Array(Text(1000)).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
  /** Hidden from the learner on accounts until graded (A6). */
  correctIndex: Index,
});

export const ShortAnswerContent = Schema.Struct({
  type: Schema.Literal('shortAnswer'),
  question: Text(maxQuestionLength),
  reference: ExerciseReference,
});

export const ExplainReasoningContent = Schema.Struct({
  type: Schema.Literal('explainReasoning'),
  question: Text(maxQuestionLength),
  reference: ExerciseReference,
});

export const OrderChainContent = Schema.Struct({
  type: Schema.Literal('orderChain'),
  /** Shown in this order (shuffled when issued). */
  items: Schema.Array(Schema.Struct({ propositionId: PropositionId, text: Schema.String })).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(6),
  ),
  /** Every ordered link between two items when issued. Any order that respects all of them is right. */
  constraints: Schema.Array(OrderConstraint),
});

export const ExerciseContent = Schema.Union([
  MultipleChoiceContent,
  ShortAnswerContent,
  ExplainReasoningContent,
  OrderChainContent,
]);
export type ExerciseContent = typeof ExerciseContent.Type;

export const MultipleChoiceAnswer = Schema.Struct({
  type: Schema.Literal('multipleChoice'),
  choice: Index,
});
export const ShortAnswerAnswer = Schema.Struct({
  type: Schema.Literal('shortAnswer'),
  text: Text(maxAnswerLength),
});
export const ExplainReasoningAnswer = Schema.Struct({
  type: Schema.Literal('explainReasoning'),
  text: Text(maxAnswerLength),
});
export const OrderChainAnswer = Schema.Struct({
  type: Schema.Literal('orderChain'),
  order: Schema.Array(PropositionId),
});

export const ExerciseAnswer = Schema.Union([
  MultipleChoiceAnswer,
  ShortAnswerAnswer,
  ExplainReasoningAnswer,
  OrderChainAnswer,
]);
export type ExerciseAnswer = typeof ExerciseAnswer.Type;

/** Score of a graded exercise: 0 (wrong) to 1 (right). */
export const Score = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1),
);

/** The fixed scale of model grading (A6), and the score of each level. */
export const GradeLevel = Schema.Literals(['correct', 'partial', 'incorrect']);
export type GradeLevel = typeof GradeLevel.Type;
export const gradeLevelScore: Readonly<Record<GradeLevel, number>> = {
  correct: 1,
  partial: 0.5,
  incorrect: 0,
};
export const Feedback = Schema.String.check(Schema.isMaxLength(maxFeedbackLength));
