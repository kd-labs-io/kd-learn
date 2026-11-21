// Wraps the AI port for one demo turn: caps model calls at the reservation and output tokens per
// call, and counts the calls made so the turn can settle (plan tai-khoan.md A8).
// The count assumes the tool loop is the only source of extra calls. A structured `output` with no
// tools is one provider call (TanStack AI 1.4 skips the agent loop and makes only the structured
// call, or harvests it from the one call in native combined mode): extraction counts one per step.
// With tools and `output` together the structured call may come on top of `maxSteps`; nothing
// sends that today.
import { Effect, Layer, Stream } from 'effect';
import { AiPort } from '@kd-learn/ai/port';
import type { TurnEvent, TurnRequest } from '@kd-learn/ai/port';

/**
 * Output cap per call of the roles whose calls need more than a turn's (phase 3 A8); the
 * reservation and the settling stay as in phase 2.
 */
export const DEMO_ROLE_OUTPUT_CAPS = {
  /** Extractor, auditor and merge: the step 4 check needed 16,384 for a Vietnamese session. */
  extractor: 16_384,
} as const;

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
          let inResults = false;
          const steps = Math.min(request.maxSteps ?? left, left);
          return port
            .runTurn({ ...request, maxSteps: steps, maxOutputTokens: limits.maxOutputTokens })
            .pipe(
              Stream.tap((event: TurnEvent<A>) =>
                Effect.sync(() => {
                  // A round of tool results means one more model call, unless the cap ends the
                  // loop. The adapter sends `Usage` between a call and its result: skip it.
                  if (event._tag === 'Usage') return;
                  if (event._tag === 'ToolResult') {
                    if (!inResults && calls < steps) {
                      calls += 1;
                      meter.calls += 1;
                    }
                    inResults = true;
                  } else {
                    inResults = false;
                  }
                }),
              ),
            );
        });
      return { runTurn: runTurn as AiPort['Service']['runTurn'] };
    }),
  ).pipe(Layer.provide(inner));
