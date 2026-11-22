// Storage port (plan 3.2): append events, read sessions, the knowledge log, settings.
// Pure: only `effect` and `@kd-learn/core` may be imported here, so `packages/agent` may depend on it.
// Shape fixed in step 5 after the SQLite WASM spike (step 1, see plan/progress/phase-1.md).
//
// Rules every driver follows:
// - Every call is asynchronous (the browser driver sends a message to a Worker).
// - No interactive transactions. The unit of writing is one batch: `appendEvents` is atomic.
//   A transaction held open across messages would block every other tab (plan risk 20).
// - Events are append-only. A driver never updates or deletes one.
import { Context, Data } from 'effect';
import type { Effect, Stream } from 'effect';
import type {
  FigureBody,
  DomainEvent,
  EventLog,
  KnowledgeEvent,
  KnowledgeLog,
  SavedProfile,
  SourceChunk,
  SourceFailure,
  SourceInfo,
  TeachingProfile,
} from '@kd-learn/core';

/** Result of one successful `appendEvents` or `appendKnowledge`. */
export interface AppendResult {
  /** Position (0-based, per session or per knowledge log) of the last event of the batch. */
  readonly lastSeq: number;
}

/** Options of `appendKnowledge`. */
export interface AppendKnowledgeOptions {
  /**
   * Append only if the log still ends at this seq (`-1` for an empty log): the writer projected the
   * log it read plus the batch, and nothing may have slipped in between. Checked inside the write
   * transaction. Required: the log is strict and append-only, so a batch written blind could make
   * it unprojectable for good. Use `appendKnowledgeChecked` (`./knowledge.ts`) rather than this.
   */
  readonly expectedLastSeq: number;
}

/** One row of the session list. Built from the log. */
export interface SessionSummary {
  readonly sessionId: string;
  /** Topic of the `SessionCreated` event. Empty when the log has none. */
  readonly topic: string;
  /** `at` of the first event (epoch ms). */
  readonly createdAt: number;
  /** `at` of the last event (epoch ms). */
  readonly updatedAt: number;
  readonly eventCount: number;
}

/** Provider names of the guest settings. Mirrors the HTTP providers of the AI port (this port cannot import it). */
export type GuestProvider = 'anthropic' | 'gemini' | 'openai-compatible';

/** Guest provider, model and key (plan A7). The key lives only in the local DB. */
export interface GuestSettings {
  readonly provider: GuestProvider;
  readonly model: string;
  /** Only for `openai-compatible`: id of an endpoint the server allows (plan A6), never a URL. */
  readonly endpointId?: string;
  /** Absent after `deleteApiKey`. */
  readonly apiKey?: string;
  /** The image model (phase 5 A6), with its own key. Absent: no images. */
  readonly image?: GuestImageSettings;
}

/** The guest's image model: Gemini or an endpoint that makes images. */
export interface GuestImageSettings {
  readonly provider: 'gemini' | 'openai-compatible';
  readonly model: string;
  readonly endpointId?: string;
  /** Absent after `deleteImageApiKey`. */
  readonly apiKey?: string;
}

/** Something changed in the store, possibly written by another tab. Re-read what you show. */
export type StorageChange =
  | { readonly _tag: 'SessionChanged'; readonly sessionId: string }
  | { readonly _tag: 'SettingsChanged' }
  | { readonly _tag: 'ProfileChanged' }
  | { readonly _tag: 'KnowledgeChanged' }
  | { readonly _tag: 'SourcesChanged' };

/** A new source (phase 4 A2): `pending` with the original file, or `ready` with its chunks. */
export type NewSource =
  | {
      readonly state: 'pending';
      readonly info: Omit<SourceInfo, 'state' | 'failure' | 'bytes' | 'chunkCount'>;
      /** The original file, kept until `completeSource` or `deleteSource`. Absent for research. */
      readonly file?: Uint8Array;
    }
  | {
      readonly state: 'ready';
      readonly info: Omit<SourceInfo, 'state' | 'failure' | 'bytes' | 'chunkCount'>;
      readonly chunks: ReadonlyArray<SourceChunk>;
    };

/** A chunk with the source it belongs to (`readChunks`). */
export interface StoredChunk {
  readonly sourceId: string;
  readonly title: string;
  readonly chunk: SourceChunk;
}

/** No usable storage in this context (no OPFS, no Worker). The caller may fall back to memory. */
export class StorageUnavailable extends Data.TaggedError('StorageUnavailable')<{
  readonly message: string;
}> {}

/** The call did not finish in time, usually because another tab holds a write. Safe to retry reads. */
export class StorageBusy extends Data.TaggedError('StorageBusy')<{
  readonly message: string;
}> {}

/** The store rejected the call (constraint, corrupt row, driver bug). A rejected batch wrote nothing. */
export class StorageFailure extends Data.TaggedError('StorageFailure')<{
  readonly message: string;
}> {}

export type StorageError = StorageUnavailable | StorageBusy | StorageFailure;

/**
 * `appendKnowledge` with `expectedLastSeq`: the log has moved on since the writer read it. Nothing
 * was written. Read the log again, project it with the batch, and retry or give up.
 */
export class KnowledgeConflict extends Data.TaggedError('KnowledgeConflict')<{
  readonly expectedLastSeq: number;
  readonly lastSeq: number;
}> {}

/**
 * A source call that does not fit the source's state (`completeSource` on a source that is not
 * pending, `retrySource` without a file). Nothing was written.
 */
export class SourceConflict extends Data.TaggedError('SourceConflict')<{
  readonly message: string;
}> {}

export interface StorageService {
  /** False for the in-memory fallback: data is lost when the page closes. The UI should warn. */
  readonly persistent: boolean;

  /**
   * Appends `events` to a session in one atomic batch: all of them or none. This is the "one turn,
   * one transaction" write of plan A3. `seq` is assigned inside the transaction, so two tabs writing
   * to one session never collide. Event ids are unique: a duplicate id fails the whole batch.
   */
  readonly appendEvents: (
    sessionId: string,
    events: ReadonlyArray<DomainEvent>,
    /**
     * Bodies of the batch's `FigureAdded` events (phase 5 A1), written in the same transaction.
     * Every figure needs exactly one body of the declared size; otherwise nothing is written.
     */
    figures?: ReadonlyArray<FigureBody>,
  ) => Effect.Effect<AppendResult, StorageError>;

  /** The body of one figure of this owner, or undefined. */
  readonly readFigure: (figureId: string) => Effect.Effect<FigureBody | undefined, StorageError>;

  /** The event log of one session, oldest first. Empty for an unknown session. */
  readonly readSession: (sessionId: string) => Effect.Effect<EventLog, StorageError>;

  /** All sessions, most recently updated first. */
  readonly listSessions: Effect.Effect<ReadonlyArray<SessionSummary>, StorageError>;

  /**
   * Appends to the owner's knowledge log (graph and practice, plan luyen-tap-graph.md A1) in one
   * atomic batch, like `appendEvents`. Event ids are unique per owner. The batch is written only if
   * the log still ends at `expectedLastSeq`; otherwise `KnowledgeConflict`.
   */
  readonly appendKnowledge: (
    events: ReadonlyArray<KnowledgeEvent>,
    options: AppendKnowledgeOptions,
  ) => Effect.Effect<AppendResult, StorageError | KnowledgeConflict>;

  /** The owner's knowledge log, oldest first. Its last seq is `length - 1`. */
  readonly readKnowledge: Effect.Effect<KnowledgeLog, StorageError>;

  /** Undefined until the learner has saved provider and model. */
  readonly getSettings: Effect.Effect<GuestSettings | undefined, StorageError>;

  /** Replaces the settings. An absent `apiKey` removes the stored key. */
  readonly saveSettings: (settings: GuestSettings) => Effect.Effect<void, StorageError>;

  /** Removes only the key (plan A7). Provider and model stay. */
  readonly deleteApiKey: Effect.Effect<void, StorageError>;

  /** Removes only the image key (phase 5 A6). The image model stays. */
  readonly deleteImageApiKey: Effect.Effect<void, StorageError>;

  /**
   * The teaching profile this person saved (phase 3 A2), as a `TeachingProfile` so a profile saved
   * under looser limits still reads back. Undefined: none saved, use the default profile.
   */
  readonly getProfile: Effect.Effect<TeachingProfile | undefined, StorageError>;

  /**
   * Replaces the saved profile; undefined goes back to the default. A driver rejects a profile that
   * is not a valid `SavedProfile` (limits of length and range) with `StorageFailure`.
   */
  readonly saveProfile: (profile: SavedProfile | undefined) => Effect.Effect<void, StorageError>;

  /** Creates a source (phase 4 A2). A duplicate id fails. Chunks over the size limit fail. */
  readonly createSource: (source: NewSource) => Effect.Effect<void, StorageError>;

  /**
   * Writes the chunks of a `pending` source and makes it `ready` in one batch; drops its file. The
   * `title` replaces the first one when given (a PDF title read from the file).
   */
  readonly completeSource: (
    sourceId: string,
    chunks: ReadonlyArray<SourceChunk>,
    options?: { readonly title?: string },
  ) => Effect.Effect<void, StorageError | SourceConflict>;

  /** Marks a `pending` source `failed`. The file stays, so `retrySource` can run it again. */
  readonly failSource: (
    sourceId: string,
    failure: SourceFailure,
  ) => Effect.Effect<void, StorageError | SourceConflict>;

  /** Puts a `failed` source (or a `pending` one nobody runs) back to `pending`. */
  readonly retrySource: (sourceId: string) => Effect.Effect<void, StorageError | SourceConflict>;

  /** Every source, newest first. */
  readonly listSources: Effect.Effect<ReadonlyArray<SourceInfo>, StorageError>;

  readonly getSource: (sourceId: string) => Effect.Effect<SourceInfo | undefined, StorageError>;

  /** The original file of a pending or failed source. */
  readonly readSourceFile: (
    sourceId: string,
  ) => Effect.Effect<Uint8Array | undefined, StorageError>;

  /** Every chunk of these sources (unknown ids are skipped), in source then chunk order. */
  readonly readChunks: (
    sourceIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<StoredChunk>, StorageError>;

  /** Deletes the source with its chunks and file. Unknown ids are a no-op. */
  readonly deleteSource: (sourceId: string) => Effect.Effect<void, StorageError>;

  /**
   * Commits made through this driver or by other tabs. Each subscriber gets its own queue.
   * Notifications may repeat; treat them as "re-read".
   */
  readonly changes: Stream.Stream<StorageChange>;
}

export class Storage extends Context.Service<Storage, StorageService>()(
  '@kd-learn/storage/Storage',
) {}

export { appendKnowledgeChecked, KnowledgeRejected, type CheckedAppend } from './knowledge.ts';
