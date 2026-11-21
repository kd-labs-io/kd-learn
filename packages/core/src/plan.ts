// Lesson plan as a DAG (plan A4): validation and next-step selection. Pure.
import { Data, Result, Schema } from 'effect';

export const StepId = Schema.NonEmptyString;
export type StepId = typeof StepId.Type;

export const PlanNode = Schema.Struct({
  id: StepId,
  title: Schema.NonEmptyString,
  goal: Schema.NonEmptyString,
  /** Ids of the nodes that must be resolved before this one. */
  dependsOn: Schema.Array(StepId),
});
export type PlanNode = typeof PlanNode.Type;

/**
 * Structural schema only. A plan that decodes can still be invalid (cycle, unknown dependency),
 * so call `validatePlan` before trusting it. Node order is the tie-breaker for step selection.
 */
export const LessonPlan = Schema.Struct({
  nodes: Schema.NonEmptyArray(PlanNode),
});
export type LessonPlan = typeof LessonPlan.Type;

/** The plan is not a valid DAG. `message` is written so it can be sent back to the model as a `ToolError`. */
export class PlanInvalid extends Data.TaggedError('PlanInvalid')<{
  readonly reason: 'DuplicateId' | 'UnknownDependency' | 'Cycle';
  readonly message: string;
  /** Ids involved: the duplicate id, the node and its unknown dependency, or the cycle path. */
  readonly ids: ReadonlyArray<string>;
}> {}

/** Checks unique ids, known dependencies and no cycle (a self-dependency is a cycle). */
export const validatePlan = (plan: LessonPlan): Result.Result<LessonPlan, PlanInvalid> => {
  const byId = new Map<string, PlanNode>();
  for (const node of plan.nodes) {
    if (byId.has(node.id)) {
      return Result.fail(
        new PlanInvalid({
          reason: 'DuplicateId',
          message: `Step id "${node.id}" is used more than once.`,
          ids: [node.id],
        }),
      );
    }
    byId.set(node.id, node);
  }
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        return Result.fail(
          new PlanInvalid({
            reason: 'UnknownDependency',
            message: `Step "${node.id}" depends on "${dep}", which is not a step in the plan.`,
            ids: [node.id, dep],
          }),
        );
      }
    }
  }
  const cycle = findCycle(plan.nodes, byId);
  if (cycle) {
    return Result.fail(
      new PlanInvalid({
        reason: 'Cycle',
        message: `The plan has a dependency cycle: ${cycle.join(' -> ')}.`,
        ids: cycle,
      }),
    );
  }
  return Result.succeed(plan);
};

/** Depth-first search. Returns a cycle as a closed path (first id repeated at the end), if any. */
const findCycle = (
  nodes: ReadonlyArray<PlanNode>,
  byId: ReadonlyMap<string, PlanNode>,
): ReadonlyArray<string> | undefined => {
  const state = new Map<string, 'visiting' | 'done'>();
  const path: Array<string> = [];
  const visit = (id: string): ReadonlyArray<string> | undefined => {
    const seen = state.get(id);
    if (seen === 'done') return undefined;
    if (seen === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const node of nodes) {
    const found = visit(node.id);
    if (found) return found;
  }
  return undefined;
};

/**
 * The first node (in plan order) that is not resolved and whose dependencies are all resolved.
 * `resolved` holds completed and skipped step ids. Undefined means every node is resolved
 * (or, for an invalid plan with a cycle, that nothing can start).
 */
export const nextStep = (plan: LessonPlan, resolved: ReadonlySet<string>): PlanNode | undefined =>
  plan.nodes.find((node) => !resolved.has(node.id) && node.dependsOn.every((d) => resolved.has(d)));

/** True when every node is resolved, which is when the session is complete. */
export const isPlanResolved = (plan: LessonPlan, resolved: ReadonlySet<string>): boolean =>
  plan.nodes.every((node) => resolved.has(node.id));
