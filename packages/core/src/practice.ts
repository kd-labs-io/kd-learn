// Practice state and mastery (plan luyen-tap-graph.md A7), folded by `projectKnowledge` from the
// practice events of the knowledge log. Pure. The rules that need the graph (active propositions,
// edges) live in `knowledge.ts`; the checks here only look at one exercise.
import type { ExerciseAnswer, ExerciseContent, ExerciseTypeId } from './exercise-schema.ts';
import type { EdgeId, PropositionId } from './knowledge-ids.ts';

export interface ExerciseGrade {
  readonly score: number;
  readonly feedback: string;
  readonly profileId?: string;
  readonly gradedAt: number;
}

export interface Exercise {
  readonly exerciseId: string;
  readonly practiceId: string;
  readonly type: ExerciseTypeId;
  /** As issued. A proposition retired or merged later keeps its old id here. */
  readonly propositionIds: ReadonlyArray<PropositionId>;
  readonly edgeIds: ReadonlyArray<EdgeId>;
  readonly content: ExerciseContent;
  readonly issuedAt: number;
  readonly answer?: ExerciseAnswer;
  readonly answeredAt?: number;
  readonly grade?: ExerciseGrade;
}

export interface Practice {
  readonly practiceId: string;
  readonly startedAt: number;
  /** Absent while the practice is open. */
  readonly endedAt?: number;
  /** Its exercises, in the order they were issued. */
  readonly exerciseIds: ReadonlyArray<string>;
}

/**
 * How well one proposition is known: a Leitner box (1 = weakest, 5 = strongest) and when it is due
 * for review. Only propositions that were graded at least once have one.
 */
export interface Mastery {
  readonly box: number;
  readonly attempts: number;
  readonly lastScore: number;
  readonly lastGradedAt: number;
  readonly dueAt: number;
}

export const masteryBoxes = 5;
/** Days until the next review, by box (index 0 is box 1). */
export const boxIntervalDays: ReadonlyArray<number> = [1, 3, 7, 16, 35];
const day = 24 * 60 * 60 * 1000;

/**
 * Leitner rule (A7, fixed in step 6). A proposition starts in box 1 when it is first graded.
 * - score >= 0.75 (right): one box up, at most 5;
 * - 0.5 <= score < 0.75 (partly right): stays in its box;
 * - score < 0.5 (wrong): back to box 1.
 * It is due `boxIntervalDays[box - 1]` days after the grade.
 */
export const nextMastery = (previous: Mastery | undefined, score: number, at: number): Mastery => {
  const box = previous?.box ?? 1;
  const next =
    score >= 0.75
      ? Math.min(previous === undefined ? 2 : box + 1, masteryBoxes)
      : score >= 0.5
        ? box
        : 1;
  return {
    box: next,
    attempts: (previous?.attempts ?? 0) + 1,
    lastScore: score,
    lastGradedAt: at,
    dueAt: at + boxIntervalDays[next - 1]! * day,
  };
};

/**
 * Mastery of a proposition another one was merged into: the weaker record wins (lower box, then
 * earlier due), so a merge never hides a weak claim from review. Attempts add up.
 */
export const mergeMastery = (
  a: Mastery | undefined,
  b: Mastery | undefined,
): Mastery | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const weaker = a.box < b.box || (a.box === b.box && a.dueAt <= b.dueAt) ? a : b;
  return { ...weaker, attempts: a.attempts + b.attempts };
};

/** Problems of an issued exercise that only depend on the exercise itself. */
export const checkContent = (
  type: ExerciseTypeId,
  propositionIds: ReadonlyArray<PropositionId>,
  content: ExerciseContent,
): string | undefined => {
  if (content.type !== type) return `Content of type ${content.type} for a ${type} exercise.`;
  if (new Set(propositionIds).size !== propositionIds.length) {
    return 'An exercise lists a proposition twice.';
  }
  switch (content.type) {
    case 'multipleChoice':
      return content.correctIndex < content.options.length
        ? undefined
        : 'The correct option is not one of the options.';
    case 'orderChain': {
      const items = content.items.map((item) => item.propositionId);
      const ids = new Set(items);
      if (ids.size !== items.length) return 'An ordering exercise lists an item twice.';
      if (ids.size !== propositionIds.length || propositionIds.some((id) => !ids.has(id))) {
        return 'The items of an ordering exercise must be its propositions.';
      }
      if (content.constraints.some(({ before, after }) => !ids.has(before) || !ids.has(after))) {
        return 'An order constraint refers to a proposition that is not an item.';
      }
      return undefined;
    }
    case 'shortAnswer':
    case 'explainReasoning':
      return undefined;
  }
};

/** Problems of an answer to `exercise`. */
export const checkAnswer = (exercise: Exercise, answer: ExerciseAnswer): string | undefined => {
  const { content } = exercise;
  if (answer.type !== content.type) {
    return `Answer of type ${answer.type} to a ${content.type} exercise.`;
  }
  if (answer.type === 'multipleChoice' && content.type === 'multipleChoice') {
    return answer.choice < content.options.length ? undefined : 'The choice is not an option.';
  }
  if (answer.type === 'orderChain' && content.type === 'orderChain') {
    const items = new Set(content.items.map((item) => item.propositionId));
    const order = new Set(answer.order);
    return order.size === answer.order.length &&
      order.size === items.size &&
      answer.order.every((id) => items.has(id))
      ? undefined
      : 'The order must list every item once.';
  }
  return undefined;
};
