// Side chat (plan A5): a separate thread next to the lesson. It sees the plan, the current step and
// a few recent main messages, has no tools, and never changes the session state or the main history.
// Like the main turn, the client writes the learner's message first (`SideMessageAppended`, role
// user), so the log ends with it, and this loop only produces the assistant's answer.
import { Clock, Effect, Result, Stream } from 'effect';
import { AiPort } from '@kd-learn/ai/port';
import type { AiError, ModelRef } from '@kd-learn/ai/port';
import { currentStep, projectSession } from '@kd-learn/core';
import type { DomainEvent, EventLog } from '@kd-learn/core';
import { sideSystem, toMessages } from './context.ts';
import { InvalidTurn, failureOf, makeCollector, modelName } from './turn.ts';
import type { AgentOutput } from './turn.ts';

export interface SideChatParams {
  /** The whole event log. It must end with the learner's message in thread `threadId`. */
  readonly log: EventLog;
  readonly threadId: string;
  readonly model: ModelRef;
  readonly newId: () => string;
}

/**
 * Answers the last learner message of a side thread. Produces `Delta`s, then one
 * `SideMessageAppended` (assistant, with usage) and `Done`; on a provider failure a
 * `SideTurnFailed` event, `Error` and `Done`.
 */
export const runSideChat = (
  params: SideChatParams,
): Stream.Stream<AgentOutput, InvalidTurn, AiPort> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const projected = projectSession(params.log);
      if (Result.isFailure(projected)) {
        return Stream.fail(new InvalidTurn({ message: projected.failure.message }));
      }
      const session = projected.success;
      const thread = session.sideThreads[params.threadId] ?? [];
      if (thread.at(-1)?.role !== 'user') {
        return Stream.fail(
          new InvalidTurn({ message: 'The side thread must end with a message from the learner.' }),
        );
      }
      const ai = yield* AiPort;
      const collector = makeCollector();
      const messageId = params.newId();
      const stepId = currentStep(session)?.id;

      const live = ai
        .runTurn({
          model: params.model,
          system: sideSystem(session),
          messages: toMessages(thread.map(({ role, content }) => ({ role, content }))),
          maxSteps: 1,
        })
        .pipe(
          Stream.flatMap((event) =>
            Stream.fromIterable(
              collector
                .observe(event)
                .map((delta): AgentOutput => ({ _tag: 'Delta', messageId, delta })),
            ),
          ),
        );

      const completed = Stream.unwrap(
        Effect.map(Clock.currentTimeMillis, (at) => {
          const event: DomainEvent = {
            _tag: 'SideMessageAppended',
            id: params.newId(),
            at,
            threadId: params.threadId,
            messageId,
            role: 'assistant',
            content: collector.text(),
            ...(stepId === undefined ? {} : { stepId }),
            usage: { model: modelName(params.model), ...collector.usage() },
          };
          return Stream.fromIterable<AgentOutput>([
            { _tag: 'Event', event },
            { _tag: 'Done', outcome: 'completed' },
          ]);
        }),
      );

      const failed = (error: AiError) =>
        Stream.unwrap(
          Effect.map(Clock.currentTimeMillis, (at) => {
            const failure = failureOf(error, params.model);
            const event: DomainEvent = {
              _tag: 'SideTurnFailed',
              id: params.newId(),
              at,
              threadId: params.threadId,
              ...failure,
            };
            return Stream.fromIterable<AgentOutput>([
              { _tag: 'Event', event },
              { _tag: 'Error', error: failure },
              { _tag: 'Done', outcome: 'failed' },
            ]);
          }),
        );

      return live.pipe(Stream.concat(completed), Stream.catch(failed));
    }),
  );
