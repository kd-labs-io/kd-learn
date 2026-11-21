// One AI port for account turns (plan tai-khoan.md A9): ACP refs go to the ACP adapter, the rest
// to TanStack AI. Agent processes are limited for the whole server; past the limit a turn fails
// at once with a retryable `AcpBusy` instead of queueing behind turns that may take minutes.
import { Effect, Layer, Stream } from 'effect';
import { AiPort, ProviderError } from '@kd-learn/ai/port';
import type { TurnRequest } from '@kd-learn/ai/port';

export const ACP_BUSY_RETRY_MS = 5_000;

const portOf = Effect.gen(function* () {
  return yield* AiPort;
});

/**
 * The ACP adapter, loaded on the first ACP turn only: it resolves agent binaries and a bridge
 * script at load time, which a server without ACP must not depend on.
 */
export const lazyAcpLayer = (): Layer.Layer<AiPort> => {
  let loaded: Promise<AiPort['Service']> | undefined;
  const load = () =>
    (loaded ??= import('@kd-learn/ai/acp').then((acp) =>
      Effect.runPromise(Effect.provide(portOf, acp.layer())),
    ));
  return Layer.succeed(AiPort, {
    runTurn: (<A>(request: TurnRequest<A>) =>
      Stream.unwrap(
        Effect.tryPromise({
          try: load,
          catch: (error) =>
            new ProviderError({
              message: `The ACP adapter could not be loaded: ${error instanceof Error ? error.message : 'unknown'}`,
            }),
        }).pipe(Effect.map((port) => port.runTurn(request))),
      )) as AiPort['Service']['runTurn'],
  });
};

export const routedAi = (options: {
  readonly api: Layer.Layer<AiPort>;
  readonly acp: Layer.Layer<AiPort>;
  readonly maxConcurrent: () => number;
}): Layer.Layer<AiPort> => {
  let running = 0;
  return Layer.effect(
    AiPort,
    Effect.gen(function* () {
      const api = yield* Effect.provide(portOf, options.api);
      const acp = yield* Effect.provide(portOf, options.acp);
      const runTurn = <A>(request: TurnRequest<A>) => {
        if (request.model.provider !== 'acp') return api.runTurn(request);
        return Stream.suspend(() => {
          if (running >= options.maxConcurrent()) {
            return Stream.fail(
              new ProviderError({
                message: 'Every agent slot on this server is busy. Try again in a moment.',
                code: 'AcpBusy',
                retryAfterMs: ACP_BUSY_RETRY_MS,
              }),
            );
          }
          running += 1;
          let released = false;
          const release = Effect.sync(() => {
            if (!released) running -= 1;
            released = true;
          });
          // Freed on every exit: end, failure, defect, interrupt (cancel or timeout).
          return acp.runTurn(request).pipe(Stream.ensuring(release));
        });
      };
      return { runTurn: runTurn as AiPort['Service']['runTurn'] };
    }),
  );
};
