// A fake AI port for the session tests: each call to `runTurn` plays the next scripted program.
// Not a test file itself.
import { Deferred, Effect, Layer, Schema, Stream } from 'effect';
import { AiPort, ProviderError } from '@kd-learn/ai/port';
import type { AiError, TurnEvent, TurnRequest } from '@kd-learn/ai/port';

type Program = (request: TurnRequest) => Stream.Stream<TurnEvent<never>, AiError>;

const end: ReadonlyArray<TurnEvent<never>> = [
  { _tag: 'Usage', inputTokens: 10, outputTokens: 5 },
  { _tag: 'Finish', reason: 'stop' },
];

export const say =
  (text: string): Program =>
  () =>
    Stream.fromIterable<TurnEvent<never>>([
      { _tag: 'TextDelta', messageId: 'm1', delta: text },
      ...end,
    ]);

/** A tool call, run like the TanStack adapter does, then a sentence. */
export const callTool =
  (name: string, input: unknown, then: string): Program =>
  (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const spec = request.tools?.find((tool) => tool.name === name);
        if (spec === undefined) throw new Error(`No tool ${name}`);
        const decoded = yield* Schema.decodeUnknownEffect(spec.input)(input).pipe(Effect.orDie);
        const output = yield* spec.run(decoded).pipe(Effect.orDie);
        return Stream.fromIterable<TurnEvent<never>>([
          { _tag: 'ToolCall', id: 'c1', name, input },
          { _tag: 'ToolResult', id: 'c1', output: String(output) },
          { _tag: 'TextDelta', messageId: 'm2', delta: then },
          ...end,
        ]);
      }),
    );

/** A structured result (extraction, practice), as the adapter emits it after decoding. */
export const structured =
  (value: unknown): Program =>
  () =>
    Stream.fromIterable<TurnEvent<never>>([
      { _tag: 'StructuredResult', value } as unknown as TurnEvent<never>,
      ...end,
    ]);

/** Waits for `release()` before running `program` (to hold a job mid-call). */
export const held = (program: Program) => {
  const gate = Effect.runSync(Deferred.make<void>());
  const wrapped: Program = (request) =>
    Stream.unwrap(Deferred.await(gate).pipe(Effect.map(() => program(request))));
  return { program: wrapped, release: () => Effect.runSync(Deferred.succeed(gate, undefined)) };
};

export const failWith =
  (message: string): Program =>
  () =>
    Stream.fail(new ProviderError({ message, code: 'ProviderError' }));

export const die =
  (message: string): Program =>
  () =>
    Stream.die(new Error(message));

/**
 * Sends `before`, then waits for `release()`; the stream of an interrupted turn records it.
 * Call `release` with no arguments to finish with `after`.
 */
export const gated = (before: string, after: string) => {
  const gate = Effect.runSync(Deferred.make<void>());
  const state = { started: false, interrupted: false };
  const program: Program = () =>
    Stream.concat(
      Stream.fromIterable<TurnEvent<never>>([
        { _tag: 'TextDelta', messageId: 'm1', delta: before },
      ]),
      Stream.fromEffect(
        Deferred.await(gate).pipe(
          Effect.onInterrupt(() => Effect.sync(() => (state.interrupted = true))),
          Effect.tap(() => Effect.sync(() => (state.started = true))),
        ),
      ).pipe(
        Stream.flatMap(() =>
          Stream.fromIterable<TurnEvent<never>>([
            { _tag: 'TextDelta', messageId: 'm1', delta: after },
            ...end,
          ]),
        ),
      ),
    );
  return { program, release: () => Effect.runSync(Deferred.succeed(gate, undefined)), state };
};

export const scriptedAi = (programs: Program[]) => {
  const requests: TurnRequest[] = [];
  const layer = Layer.succeed(AiPort, {
    runTurn: ((request: TurnRequest) => {
      requests.push(request);
      const next = programs.shift();
      if (next === undefined) return Stream.die(new Error('No scripted program left'));
      return next(request);
    }) as AiPort['Service']['runTurn'],
  });
  return { layer, requests, programs };
};
