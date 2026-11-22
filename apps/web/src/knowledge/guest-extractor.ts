// Extraction in guest and demo mode (phase 3 A3). The tab writes `ExtractionStarted`, sends the
// session log, its graph slice (A4) and the profile to `POST /api/knowledge/extract`, and writes the
// batch it gets back, fitted to the graph as it is then. Plain TypeScript, no React.
//
// The knowledge log is shared by every session, so one extraction runs at a time across tabs: they
// queue on the Web Lock `kd-learn:knowledge`. Whoever holds the lock knows no other extraction runs,
// so an attempt still open at that point was interrupted (tab closed mid-way) and is closed first.
import { Effect, Result } from 'effect';
import { extractSession, type ClientError, type ExtractOutcome, type Failure } from '@kd-learn/api';
import {
  extractionStatus,
  fitKnowledgeBatch,
  projectKnowledge,
  projectSession,
  selectSessionSlice,
  sessionDocumentSlice,
  usedSourceRefs,
  sessionQueryText,
  type KnowledgeEvent,
  type KnowledgeGraph,
} from '@kd-learn/core';
import { appendKnowledgeChecked, type StorageService } from '@kd-learn/storage/port';
import { modelChoiceOf } from '../learn/model';

export const KNOWLEDGE_LOCK = 'kd-learn:knowledge';
/** Slice budget in demo mode, where the whole request is capped at 256 KiB (A8). */
const DEMO_SLICE_BYTES = 32 * 1024;
/** Documents budget in demo mode (A3). */
const DEMO_DOCUMENT_BYTES = 32 * 1024;

/** Waits for the lock (unlike the turn lock, which refuses): extractions queue, they never fail. */
export type QueuedLock = <A>(name: string, run: () => Promise<A>) => Promise<A>;

let tail: Promise<unknown> = Promise.resolve();
/** Web Locks across tabs; a promise chain in this tab where they do not exist. */
export const queuedLock: QueuedLock = (name, run) => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks !== undefined) return locks.request(name, run);
  const next = tail.then(run, run);
  tail = next.catch(() => undefined);
  return next;
};

export type ExtractResult =
  | { readonly _tag: 'Extracted' }
  /** Nothing ran: already extracted or attempted (auto), no completed turn, no key. */
  | { readonly _tag: 'Skipped'; readonly reason: 'done' | 'attempted' | 'empty' | 'noKey' }
  | { readonly _tag: 'Failed'; readonly failure: Failure };

export interface GuestExtractorDeps {
  readonly storage: () => Promise<StorageService>;
  readonly demo?: () => boolean;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly lock?: QueuedLock;
  readonly newId?: () => string;
  readonly now?: () => number;
}

const graphOf = (log: Parameters<typeof projectKnowledge>[0]): KnowledgeGraph => {
  const projected = projectKnowledge(log);
  if (Result.isFailure(projected)) throw new Error('The knowledge log does not project.');
  return projected.success;
};

export const makeGuestExtractor = (deps: GuestExtractorDeps) => {
  const lock = deps.lock ?? queuedLock;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  let running: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  const failedEvent = (
    sessionId: string,
    extractionId: string,
    failure: Failure,
  ): KnowledgeEvent => ({
    _tag: 'ExtractionFailed',
    id: newId(),
    at: now(),
    sessionId,
    extractionId,
    ...failure,
  });

  const run = async (sessionId: string, auto: boolean): Promise<ExtractResult> => {
    const storage = await deps.storage();
    const log = await Effect.runPromise(storage.readSession(sessionId));
    const session = projectSession(log);
    if (Result.isFailure(session) || !log.some((event) => event._tag === 'TurnCompleted')) {
      return { _tag: 'Skipped', reason: 'empty' };
    }
    const graph = graphOf(await Effect.runPromise(storage.readKnowledge));
    const status = extractionStatus(graph, sessionId);
    if (status === 'extracted') return { _tag: 'Skipped', reason: 'done' };
    // Only a session never attempted runs by itself (A3).
    if (auto && status !== 'none') return { _tag: 'Skipped', reason: 'attempted' };
    const model = deps.demo?.()
      ? ({ provider: 'demo' } as const)
      : modelChoiceOf(await Effect.runPromise(storage.getSettings));
    // No key: no attempt is written, as in accounts with no model.
    if (model === undefined) return { _tag: 'Skipped', reason: 'noKey' };

    const extractionId = newId();
    await Effect.runPromise(
      appendKnowledgeChecked(storage, (current) => {
        const batch: KnowledgeEvent[] = [];
        // We hold the lock: an open attempt is not running anywhere.
        for (const [id, extraction] of Object.entries(current.extractions)) {
          const last = extraction.attempts.at(-1);
          if (last?.status === 'started') {
            batch.push(
              failedEvent(id, last.extractionId, {
                code: 'Interrupted',
                message: 'The extraction was interrupted.',
                retryable: true,
              }),
            );
          }
        }
        batch.push({ _tag: 'ExtractionStarted', id: newId(), at: now(), sessionId, extractionId });
        return batch;
      }),
    );

    const profile = await Effect.runPromise(storage.getProfile);
    // The chunks the session was taught from (phase 4 A3); a deleted source is skipped.
    const used = usedSourceRefs(log);
    const documentSlice =
      used.length === 0
        ? []
        : sessionDocumentSlice(
            log,
            await Effect.runPromise(
              storage.readChunks([...new Set(used.map((ref) => ref.sourceId))]),
            ),
            // The demo request is capped at 256 KiB with the log (A3).
            model.provider === 'demo' ? DEMO_DOCUMENT_BYTES : undefined,
          );
    const outcome: ExtractOutcome | ClientError = await Effect.runPromise(
      extractSession(
        {
          model,
          extractionId,
          log,
          slice: selectSessionSlice(
            graph,
            sessionQueryText(session.success),
            // A demo request is capped at 256 KiB with the log: keep the slice small.
            model.provider === 'demo' ? { maxBytes: DEMO_SLICE_BYTES } : {},
          ),
          ...(profile === undefined || model.provider === 'demo' ? {} : { profile }),
          ...(documentSlice.length === 0 ? {} : { documentSlice }),
        },
        {
          ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        },
      ).pipe(Effect.catch((error) => Effect.succeed(error))),
    );

    const fail = async (failure: Failure): Promise<ExtractResult> => {
      await Effect.runPromise(
        appendKnowledgeChecked(storage, () => [failedEvent(sessionId, extractionId, failure)]),
      );
      return { _tag: 'Failed', failure };
    };
    if (outcome._tag === 'ClientError') {
      return fail({ code: 'Network', message: outcome.message, retryable: true });
    }
    if (outcome._tag === 'Failed') return fail(outcome.error);
    const written = await Effect.runPromise(
      appendKnowledgeChecked(
        storage,
        (current) => fitKnowledgeBatch(current, outcome.events).events,
      ).pipe(Effect.result),
    );
    if (Result.isFailure(written)) {
      // The graph moved under the extraction in a way the batch cannot follow (A3).
      return fail({
        code: 'Conflict',
        message: 'The result no longer fits the graph. Try again.',
        retryable: true,
      });
    }
    return { _tag: 'Extracted' };
  };

  const start = async (sessionId: string, auto: boolean): Promise<ExtractResult> => {
    running = new Set([...running, sessionId]);
    emit();
    try {
      return await lock(KNOWLEDGE_LOCK, () => run(sessionId, auto));
    } catch (error) {
      return {
        _tag: 'Failed',
        failure: {
          code: 'Storage',
          message: error instanceof Error ? error.message : 'The local database failed.',
          retryable: true,
        },
      };
    } finally {
      running = new Set([...running].filter((id) => id !== sessionId));
      emit();
    }
  };

  return {
    /** The session was just completed: extract it if it was never attempted. Never rejects. */
    sessionCompleted: (sessionId: string) => start(sessionId, true),
    /** "Extract now" and retry. Never rejects. */
    extract: (sessionId: string) => start(sessionId, false),
    /** Sessions this tab is extracting or waiting to extract. A new set on every change. */
    running: (): ReadonlySet<string> => running,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export type GuestExtractor = ReturnType<typeof makeGuestExtractor>;
