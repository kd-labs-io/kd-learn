// Wraps the AI port for one demo turn: caps model calls at the reservation and output tokens per
// call, and counts the calls made so the turn can settle (plan tai-khoan.md A8).
import { Effect, Layer, Stream } from 'effect';
import { AiPort } from '@kd-learn/ai/port';
import type { TurnEvent, TurnRequest } from '@kd-learn/ai/port';

export interface Meter {
  /** Model calls charged so far. Rounds up: a tool round counts the call that follows it. */
  calls: number;
}

export const meteredAi = (
  inner: Layer.Layer<AiPort>,
  limits: { readonly calls: number; readonly maxOutputTokens: number },
  meter: Meter,
): Layer.Layer<AiPort> =>
  Layer.effect(
    AiPort,
    Effect.gen(function* () {
      const port = yield* AiPort;
      const runTurn = <A>(request: TurnRequest<A>) =>
        Stream.suspend(() => {
          const left = limits.calls - meter.calls;
          if (left <= 0) return Stream.die(new Error('The demo reservation is used up.'));
          meter.calls += 1;
          let calls = 1;
          let inTools = false;
          const steps = Math.min(request.maxSteps ?? left, left);
          return port
            .runTurn({ ...request, maxSteps: steps, maxOutputTokens: limits.maxOutputTokens })
            .pipe(
              Stream.tap((event: TurnEvent<A>) =>
                Effect.sync(() => {
                  const tool = event._tag === 'ToolCall' || event._tag === 'ToolResult';
                  // A round of tool calls means one more model call, unless the cap ends the loop.
                  if (tool && !inTools && calls < steps) {
                    calls += 1;
                    meter.calls += 1;
                  }
                  inTools = tool;
                }),
              ),
            );
        });
      return { runTurn: runTurn as AiPort['Service']['runTurn'] };
    }),
  ).pipe(Layer.provide(inner));
