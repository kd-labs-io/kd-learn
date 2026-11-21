// Checked append to the knowledge log (plan luyen-tap-graph.md A3): read the log, project it with
// the new batch, append only if nothing slipped in between. Every writer of the knowledge log
// (extraction, practice, retiring a proposition) goes through this, because the log is strict and
// append-only: one batch that does not project would break the owner's whole graph for good.
import { Data, Effect, Result } from 'effect';
import {
  projectKnowledge,
  type KnowledgeEvent,
  type KnowledgeGraph,
  type KnowledgeLog,
} from '@kd-learn/core';
import {
  KnowledgeConflict,
  StorageFailure,
  type StorageError,
  type StorageService,
} from './index.ts';

/** The batch does not project on the current log (for example it merges into a retired proposition). */
export class KnowledgeRejected extends Data.TaggedError('KnowledgeRejected')<{
  /** Index of the offending event in the batch. */
  readonly index: number;
  readonly message: string;
}> {}

export interface CheckedAppend {
  readonly lastSeq: number;
  /** The graph after the batch. */
  readonly graph: KnowledgeGraph;
}

/**
 * Builds a batch from the current graph and appends it with `expectedLastSeq`. When another writer
 * got in first, reads again and rebuilds, up to `attempts` times; then `KnowledgeConflict`.
 * An empty batch writes nothing.
 */
export const appendKnowledgeChecked = (
  storage: StorageService,
  build: (graph: KnowledgeGraph, log: KnowledgeLog) => ReadonlyArray<KnowledgeEvent>,
  options: { readonly attempts?: number } = {},
): Effect.Effect<CheckedAppend, StorageError | KnowledgeConflict | KnowledgeRejected> => {
  const { attempts = 3 } = options;
  const once: Effect.Effect<CheckedAppend, StorageError | KnowledgeConflict | KnowledgeRejected> =
    Effect.gen(function* () {
      const log = yield* storage.readKnowledge;
      const current = projectKnowledge(log);
      if (Result.isFailure(current)) {
        return yield* new StorageFailure({
          message: `Stored knowledge log does not project: ${current.failure.message}`,
        });
      }
      const batch = build(current.success, log);
      const next = projectKnowledge([...log, ...batch]);
      if (Result.isFailure(next)) {
        return yield* new KnowledgeRejected({
          index: next.failure.index - log.length,
          message: next.failure.message,
        });
      }
      const { lastSeq } = yield* storage.appendKnowledge(batch, {
        expectedLastSeq: log.length - 1,
      });
      return { lastSeq, graph: next.success };
    });
  const attempt = (left: number): typeof once =>
    once.pipe(
      Effect.catchTag('KnowledgeConflict', (conflict) =>
        left > 1 ? attempt(left - 1) : Effect.fail(conflict),
      ),
    );
  return attempt(attempts);
};
