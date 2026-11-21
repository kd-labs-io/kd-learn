// Storage port (plan 3.2): append events, read sessions, settings.
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
import type { DomainEvent, EventLog } from '@kd-learn/core';

/** Result of one successful `appendEvents`. */
export interface AppendResult {
  /** Position (0-based, per session) of the last event of the batch. */
  readonly lastSeq: number;
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
  /** Only for `openai-compatible`. */
  readonly baseURL?: string;
  /** Absent after `deleteApiKey`. */
  readonly apiKey?: string;
}

/** Something changed in the store, possibly written by another tab. Re-read what you show. */
export type StorageChange =
  | { readonly _tag: 'SessionChanged'; readonly sessionId: string }
  | { readonly _tag: 'SettingsChanged' };

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
  ) => Effect.Effect<AppendResult, StorageError>;

  /** The event log of one session, oldest first. Empty for an unknown session. */
  readonly readSession: (sessionId: string) => Effect.Effect<EventLog, StorageError>;

  /** All sessions, most recently updated first. */
  readonly listSessions: Effect.Effect<ReadonlyArray<SessionSummary>, StorageError>;

  /** Undefined until the learner has saved provider and model. */
  readonly getSettings: Effect.Effect<GuestSettings | undefined, StorageError>;

  /** Replaces the settings. An absent `apiKey` removes the stored key. */
  readonly saveSettings: (settings: GuestSettings) => Effect.Effect<void, StorageError>;

  /** Removes only the key (plan A7). Provider and model stay. */
  readonly deleteApiKey: Effect.Effect<void, StorageError>;

  /**
   * Commits made through this driver or by other tabs. Each subscriber gets its own queue.
   * Notifications may repeat; treat them as "re-read".
   */
  readonly changes: Stream.Stream<StorageChange>;
}

export class Storage extends Context.Service<Storage, StorageService>()(
  '@kd-learn/storage/Storage',
) {}
