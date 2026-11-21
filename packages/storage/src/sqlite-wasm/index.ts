// Browser driver of the storage port: SQLite (wa-sqlite, OPFS) in a Worker this package owns.
// CLIENT ONLY. Importing this module creates no Worker until `openWasmStorage` runs, but the Worker
// and the WASM file are part of its module graph, so apps must load it through a dynamic import
// guarded by `import.meta.env.SSR` (see apps/web/src/storage/client.ts). Then the server bundle
// never contains it.
import { Effect, Queue, Schema, Stream } from 'effect';
import { DomainEvent, type EventLog } from '@kd-learn/core';
import {
  StorageBusy,
  StorageFailure,
  StorageUnavailable,
  type AppendResult,
  type GuestProvider,
  type GuestSettings,
  type SessionSummary,
  type StorageChange,
  type StorageError,
  type StorageService,
} from '../port/index.ts';
import type { SettingsKey } from '../sqlite/schema.ts';
import type { AppendReply, Operation, Response, WireSession } from './protocol.ts';

export interface WasmStorageOptions {
  /** Database file name in OPFS. */
  readonly name?: string;
  /** Per call. A call that times out (usually another tab holds the write) fails with `StorageBusy`. */
  readonly timeoutMs?: number;
  /** BroadcastChannel that tells other tabs about commits. */
  readonly channelName?: string;
}

/** The port plus `close`. After `pagehide` the browser may kill the Worker: open a new one on `pageshow`. */
export interface WasmStorage extends StorageService {
  readonly close: Effect.Effect<void>;
}

const providers: ReadonlyArray<GuestProvider> = ['anthropic', 'gemini', 'openai-compatible'];
const decodeEvent = Schema.decodeUnknownSync(DomainEvent);

/**
 * Opens the database. Fails with `StorageUnavailable` only when this context cannot hold one (no
 * OPFS, no Worker): that is the case where falling back to memory is right. Other failures keep their
 * type (`StorageBusy` for an open that timed out, `StorageFailure` for a migration error or a
 * database newer than this app) and must not be hidden behind an empty fallback store.
 */
export const openWasmStorage = (
  options: WasmStorageOptions = {},
): Effect.Effect<WasmStorage, StorageError> =>
  Effect.tryPromise({
    try: () => connect(options),
    catch: (error) =>
      error instanceof StorageUnavailable ||
      error instanceof StorageBusy ||
      error instanceof StorageFailure
        ? error
        : new StorageUnavailable({
            message: error instanceof Error ? error.message : String(error),
          }),
  });

async function connect(options: WasmStorageOptions): Promise<WasmStorage> {
  const { name = 'kd-learn', timeoutMs = 8000, channelName = 'kd-learn-storage' } = options;
  if (typeof Worker === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    throw new StorageUnavailable({ message: 'OPFS or Worker is not available in this context' });
  }

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const failAll = (error: Error) => {
    pending.forEach((call) => call.reject(error));
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<Response>) => {
    const reply = event.data;
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    if (reply.ok) call.resolve(reply.result);
    else {
      call.reject(
        reply.kind === 'unavailable'
          ? new StorageUnavailable({ message: reply.message })
          : new StorageFailure({ message: reply.message }),
      );
    }
  };
  worker.onerror = (event) =>
    failAll(new StorageUnavailable({ message: `Storage worker crashed: ${event.message}` }));

  const send = <T>(operation: Operation, limit = timeoutMs): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new StorageBusy({ message: `${operation.op} did not finish in ${limit} ms` }));
      }, limit);
      pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value as T)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      worker.postMessage({ id, ...operation });
    });

  try {
    // Opening includes loading the WASM and running migrations, which may wait for another tab.
    await send({ op: 'open', name }, Math.max(timeoutMs, 15000));
  } catch (error) {
    worker.terminate();
    throw error;
  }

  const listeners = new Set<(change: StorageChange) => void>();
  const emit = (change: StorageChange) => listeners.forEach((listener) => listener(change));
  const channel =
    typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(channelName);
  if (channel) channel.onmessage = (event: MessageEvent<StorageChange>) => emit(event.data);
  /** Tell this tab's subscribers and the other tabs. Called after COMMIT only. */
  const committed = (change: StorageChange) => {
    emit(change);
    channel?.postMessage(change);
  };

  /** Runs a worker call as an Effect, mapping any thrown value to a typed storage error. */
  const call = <T>(operation: Operation) =>
    Effect.tryPromise({
      try: () => send<T>(operation),
      catch: (error) =>
        error instanceof StorageBusy ||
        error instanceof StorageFailure ||
        error instanceof StorageUnavailable
          ? error
          : new StorageFailure({ message: error instanceof Error ? error.message : String(error) }),
    });

  const decodeLog = (payloads: ReadonlyArray<string>) =>
    Effect.try({
      try: (): EventLog => payloads.map((payload) => decodeEvent(JSON.parse(payload))),
      catch: (error) =>
        new StorageFailure({
          message: `Stored event is not valid: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

  const settingsEntries = (settings: GuestSettings) => {
    const all: Record<SettingsKey, string | undefined> = {
      provider: settings.provider,
      model: settings.model,
      endpointId: settings.endpointId,
      apiKey: settings.apiKey,
    };
    const entries: Partial<Record<SettingsKey, string>> = {};
    const remove: SettingsKey[] = [];
    for (const key of Object.keys(all) as SettingsKey[]) {
      const value = all[key];
      if (value === undefined) remove.push(key);
      else entries[key] = value;
    }
    return { entries, remove };
  };

  const summarize = (row: WireSession): SessionSummary => {
    let topic = '';
    if (row.created !== undefined) {
      try {
        const event = decodeEvent(JSON.parse(row.created));
        if (event._tag === 'SessionCreated') topic = event.topic;
      } catch {
        // A damaged SessionCreated must not hide the session from the list.
      }
    }
    return {
      sessionId: row.sessionId,
      topic,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      eventCount: row.eventCount,
    };
  };

  return {
    persistent: true,

    appendEvents: (sessionId, events) =>
      events.length === 0
        ? // Nothing to write: report the current end of the log without a transaction.
          call<string[]>({ op: 'read', sessionId }).pipe(
            Effect.map((payloads): AppendResult => ({ lastSeq: payloads.length - 1 })),
          )
        : call<AppendReply>({
            op: 'append',
            sessionId,
            events: events.map((event) => ({
              id: event.id,
              tag: event._tag,
              at: event.at,
              payload: JSON.stringify(event),
            })),
          }).pipe(
            Effect.tap(() => Effect.sync(() => committed({ _tag: 'SessionChanged', sessionId }))),
          ),

    readSession: (sessionId) =>
      call<string[]>({ op: 'read', sessionId }).pipe(Effect.flatMap(decodeLog)),

    listSessions: call<WireSession[]>({ op: 'list' }).pipe(
      Effect.map((rows) => rows.map(summarize)),
    ),

    getSettings: call<Record<string, string>>({ op: 'getSettings' }).pipe(
      Effect.flatMap((stored) => {
        const { provider, model, endpointId, apiKey } = stored;
        if (provider === undefined || model === undefined) return Effect.succeed(undefined);
        if (!providers.includes(provider as GuestProvider)) {
          return Effect.fail(
            new StorageFailure({ message: `Unknown stored provider ${provider}` }),
          );
        }
        return Effect.succeed<GuestSettings>({
          provider: provider as GuestProvider,
          model,
          ...(endpointId === undefined ? {} : { endpointId }),
          ...(apiKey === undefined ? {} : { apiKey }),
        });
      }),
    ),

    saveSettings: (settings) =>
      call<void>({ op: 'putSettings', ...settingsEntries(settings) }).pipe(
        Effect.tap(() => Effect.sync(() => committed({ _tag: 'SettingsChanged' }))),
      ),

    deleteApiKey: call<void>({ op: 'putSettings', entries: {}, remove: ['apiKey'] }).pipe(
      Effect.tap(() => Effect.sync(() => committed({ _tag: 'SettingsChanged' }))),
    ),

    changes: Stream.callback<StorageChange>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (change: StorageChange) => void Queue.offerUnsafe(queue, change);
          listeners.add(listener);
          return listener;
        }),
        (listener) => Effect.sync(() => void listeners.delete(listener)),
      ),
    ),

    close: Effect.promise(async () => {
      await send({ op: 'close' }, 2000).catch(() => undefined);
      channel?.close();
      worker.terminate();
    }),
  };
}
