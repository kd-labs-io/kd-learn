// Test helpers: a scripted fake AiPort and a driver that plays turns against an event log.
// Mirrors what the TanStack adapter does with tools: decode the input, run the tool, and send a
// failure back to the model as a tool result instead of ending the turn.
import { Effect, Schema, Stream } from 'effect';
import { AiPort, OutputInvalid } from '@kd-learn/ai/port';
import type { AiError, FinishReason, TurnEvent, TurnRequest } from '@kd-learn/ai/port';
import type { DomainEvent } from '@kd-learn/core';
import type { AgentOutput } from './turn.ts';

/** One thing the fake model does during a call to `runTurn`, in order. */
export type Action =
  | { readonly say: string }
  | { readonly call: string; readonly input: unknown }
  | { readonly fail: AiError }
  /** A structured result, decoded with `request.output` (a decode failure is `OutputInvalid`). */
  | { readonly result: unknown }
  | { readonly usage: readonly [input: number, output: number] }
  | { readonly finish: FinishReason };

/** `script[i]` is the list of actions for the i-th call to `runTurn`. */
export const fakeAi = (script: ReadonlyArray<ReadonlyArray<Action>>) => {
  const requests: Array<TurnRequest> = [];
  const toolResults: Array<string> = [];
  let call = 0;
  let message = 0;

  const run = (request: TurnRequest): Stream.Stream<TurnEvent<never>, AiError> => {
    requests.push(request);
    const actions = script[call++];
    if (actions === undefined) throw new Error(`No script for call ${call}`);
    return Stream.unwrap(
      Effect.sync(() => {
        let messageId = `msg${++message}`;
        let usage: readonly [number, number] = [10, 5];
        let finish: FinishReason = 'stop';
        const events: Array<Effect.Effect<ReadonlyArray<TurnEvent<never>>, AiError>> = [];
        for (const action of actions) {
          if ('say' in action) {
            const id = messageId;
            // Two deltas per message, to exercise merging.
            const mid = Math.ceil(action.say.length / 2);
            events.push(
              Effect.succeed([
                { _tag: 'TextDelta', messageId: id, delta: action.say.slice(0, mid) },
                { _tag: 'TextDelta', messageId: id, delta: action.say.slice(mid) },
              ]),
            );
          } else if ('call' in action) {
            const callId = `call${toolResults.length + 1}`;
            const spec = request.tools?.find((t) => t.name === action.call);
            events.push(
              Effect.gen(function* () {
                const base: TurnEvent<never> = {
                  _tag: 'ToolCall',
                  id: callId,
                  name: action.call,
                  input: action.input,
                };
                const output =
                  spec === undefined
                    ? `Error: unknown tool ${action.call}`
                    : yield* Schema.decodeUnknownEffect(spec.input)(action.input).pipe(
                        Effect.flatMap((input) => spec.run(input)),
                        Effect.map((value) => String(value)),
                        Effect.catch((error) => Effect.succeed(`Error: ${error.message}`)),
                      );
                toolResults.push(output);
                return [base, { _tag: 'ToolResult', id: callId, output } as const];
              }),
            );
            // The model speaks again after a tool result: a new provider message.
            messageId = `msg${++message}`;
          } else if ('fail' in action) {
            events.push(Effect.fail(action.fail));
          } else if ('result' in action) {
            const output = request.output;
            events.push(
              output === undefined
                ? Effect.fail(new OutputInvalid({ message: 'No output schema', raw: '' }))
                : Schema.decodeUnknownEffect(output)(action.result).pipe(
                    Effect.map((value): ReadonlyArray<TurnEvent<never>> => [
                      { _tag: 'StructuredResult', value: value as never },
                    ]),
                    Effect.mapError(
                      (error) =>
                        new OutputInvalid({
                          message: error.message,
                          raw: JSON.stringify(action.result),
                        }),
                    ),
                  ),
            );
          } else if ('usage' in action) {
            usage = action.usage;
          } else {
            finish = action.finish;
          }
        }
        return Stream.fromIterable(events).pipe(
          Stream.mapEffect((effect) => effect),
          Stream.flattenIterable,
          Stream.concat(
            Stream.fromIterable<TurnEvent<never>>([
              { _tag: 'Usage', inputTokens: usage[0], outputTokens: usage[1] },
              { _tag: 'Finish', reason: finish },
            ]),
          ),
        );
      }),
    );
  };

  const layer = Effect.provideService(AiPort, {
    runTurn: run as AiPort['Service']['runTurn'],
  });
  return { layer, requests, toolResults };
};

/** Deterministic ids and a counter for events the tests write themselves. */
export const counterIds = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}${++n}`;
};

/** Runs a stream of outputs against the fake model and collects it. */
export const collect = <E>(
  stream: Stream.Stream<AgentOutput, E, AiPort>,
  fake: Pick<ReturnType<typeof fakeAi>, 'layer'>,
) => Effect.runPromise(Stream.runCollect(stream).pipe(fake.layer));

/** The events among the outputs. */
export const eventsOf = (outputs: ReadonlyArray<AgentOutput>): Array<DomainEvent> =>
  outputs.flatMap((o) => (o._tag === 'Event' ? [o.event] : []));
