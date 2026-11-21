// State-transition tools (plan A4). Each tool turns a model call into domain events. The events are
// collected in `pending` and only released when the turn completes (see turn.ts), so a turn that
// fails half way changes nothing and can be retried.
import { Clock, Effect, Result, Schema } from 'effect';
import { tool, ToolError } from '@kd-learn/ai/port';
import type { TurnRequest } from '@kd-learn/ai/port';
import {
  AssessmentLevel,
  LessonPlan,
  currentStep,
  projectSession,
  validatePlan,
} from '@kd-learn/core';
import type { DomainEvent, PlanNode, Session } from '@kd-learn/core';

/** An event before the loop gives it an `id` and `at`. */
export type Draft<E = DomainEvent> = E extends unknown ? Omit<E, 'id' | 'at'> : never;

export interface ToolContext {
  /** The log as the client sent it; the open turn is its last turn. */
  readonly log: ReadonlyArray<DomainEvent>;
  readonly turnId: string;
  readonly newId: () => string;
  /** Events produced by tools in this turn, in order. Appended to by `apply`. */
  readonly pending: Array<DomainEvent>;
}

const fail = (message: string) => Effect.fail(new ToolError({ message }));

/** The session as it would be if the pending events were already in the log. */
export const sessionNow = (ctx: ToolContext): Result.Result<Session, ToolError> =>
  Result.mapError(
    projectSession([...ctx.log, ...ctx.pending]),
    (error) => new ToolError({ message: error.message }),
  );

/** Stamps the drafts, checks them against the projection, and queues them. Fails with a `ToolError` if the log would break. */
const apply = (ctx: ToolContext, drafts: ReadonlyArray<Draft>) =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    // The cast restores the union that `Draft` took apart; every draft carries its own `_tag`.
    const events = drafts.map((draft) => ({ ...draft, id: ctx.newId(), at }) as DomainEvent);
    const projected = projectSession([...ctx.log, ...ctx.pending, ...events]);
    if (Result.isFailure(projected)) return yield* fail(projected.failure.message);
    ctx.pending.push(...events);
    return projected.success;
  });

const alreadyMoved = (ctx: ToolContext) =>
  ctx.pending.length > 0
    ? fail('The lesson already moved forward in this turn. Continue the conversation instead.')
    : Effect.void;

const describeStep = (step: PlanNode) => `"${step.id}" - ${step.title} (goal: ${step.goal})`;

const AssessmentInput = Schema.Struct({
  level: AssessmentLevel,
  summary: Schema.NonEmptyString,
  strengths: Schema.Array(Schema.String),
  gaps: Schema.Array(Schema.String),
});

const submitAssessment = (ctx: ToolContext) =>
  tool({
    name: 'submit_assessment',
    description:
      'Finish the diagnostic phase. Call it once, when you have enough evidence about what the learner knows (or when told to). level is a coarse overall level; summary is two or three sentences; strengths and gaps are short phrases about the topic.',
    input: AssessmentInput,
    run: (input) =>
      Effect.gen(function* () {
        yield* alreadyMoved(ctx);
        yield* apply(ctx, [{ _tag: 'AssessmentRecorded', turnId: ctx.turnId, ...input }]);
        return 'Assessment recorded. Now write a short, friendly message telling the learner you will prepare a learning plan.';
      }),
  });

/** Plans above this size are almost certainly a mistake, and they overwhelm the learner. */
const MAX_PLAN_STEPS = 12;

const createPlan = (ctx: ToolContext) =>
  tool({
    name: 'create_plan',
    description:
      'Save the lesson plan. Call it once. nodes is a list of steps in teaching order; each has id (unique short slug), title, goal, and dependsOn (ids of steps to finish first; [] if none). The dependencies must not form a cycle.',
    input: LessonPlan,
    run: (plan) =>
      Effect.gen(function* () {
        yield* alreadyMoved(ctx);
        if (plan.nodes.length > MAX_PLAN_STEPS) {
          return yield* fail(
            `The plan has ${plan.nodes.length} steps; use at most ${MAX_PLAN_STEPS}. Merge small steps and call create_plan again.`,
          );
        }
        const valid = validatePlan(plan);
        if (Result.isFailure(valid)) {
          return yield* fail(`${valid.failure.message} Fix the plan and call create_plan again.`);
        }
        const session = yield* apply(ctx, [{ _tag: 'PlanCreated', turnId: ctx.turnId, plan }]);
        const first = currentStep(session);
        return `Plan saved with ${plan.nodes.length} steps. The first step is ${first ? describeStep(first) : 'unknown'}. Greet the learner and start teaching it.`;
      }),
  });

const completeStep = (ctx: ToolContext) =>
  tool({
    name: 'complete_step',
    description:
      'Mark the current step as learned. Call it only after the learner has shown they meet the step goal. stepId must be the id of the current step.',
    input: Schema.Struct({ stepId: Schema.NonEmptyString }),
    run: ({ stepId }) =>
      Effect.gen(function* () {
        // Models sometimes send the same call twice in parallel: the repeat is a no-op, not an error.
        const repeated = ctx.pending.some((e) => e._tag === 'StepCompleted' && e.stepId === stepId);
        if (repeated) return 'That step is already completed. Continue the conversation.';
        yield* alreadyMoved(ctx);
        const before = sessionNow(ctx);
        if (Result.isFailure(before)) return yield* Effect.fail(before.failure);
        const current = currentStep(before.success);
        if (current === undefined) return yield* fail('There is no step being taught right now.');
        if (stepId !== current.id) {
          return yield* fail(
            `The current step is ${describeStep(current)}. Only the current step can be completed.`,
          );
        }
        let after = yield* apply(ctx, [{ _tag: 'StepCompleted', turnId: ctx.turnId, stepId }]);
        // The last step is resolved: the session ends in the same turn (plan A4).
        if (after.state._tag === 'Teaching' && after.state.stepId === undefined) {
          after = yield* apply(ctx, [{ _tag: 'SessionCompleted', turnId: ctx.turnId }]);
        }
        const next = currentStep(after);
        return next === undefined
          ? 'Step completed. Every step of the plan is done: congratulate the learner and wrap up the lesson.'
          : `Step completed. The next step is ${describeStep(next)}. Finish your feedback, then lead the learner into it.`;
      }),
  });

/** The tools offered in the current state of the session (plan A4). */
export const toolsFor = (session: Session, ctx: ToolContext): NonNullable<TurnRequest['tools']> => {
  switch (session.state._tag) {
    case 'Probing':
      return [submitAssessment(ctx)];
    case 'Planning':
      return [createPlan(ctx)];
    case 'Teaching':
      return [completeStep(ctx)];
    case 'Done':
      return [];
  }
};
