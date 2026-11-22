// In-memory driver: tests, and the fallback when OPFS is not available (private windows, some
// WebKit contexts). `persistent` is false so the UI can warn that nothing survives a reload.
import { Effect, Queue, Schema, Stream } from 'effect';
import {
  SavedProfile,
  type DomainEvent,
  type FigureBody,
  type KnowledgeEvent,
  type SourceChunk,
  type SourceInfo,
  type TeachingProfile,
} from '@kd-learn/core';
import { checkChunks, checkFigures, checkNewSourceInfo } from '../sqlite/codec.ts';
import {
  KnowledgeConflict,
  SourceConflict,
  StorageFailure,
  type AppendResult,
  type GuestSettings,
  type SessionSummary,
  type StorageChange,
  type StorageService,
} from '../port/index.ts';

export const makeMemoryStorage = (): StorageService => {
  const sessions = new Map<string, DomainEvent[]>();
  const eventIds = new Set<string>();
  const figureBodies = new Map<string, FigureBody>();
  const knowledge: KnowledgeEvent[] = [];
  const knowledgeIds = new Set<string>();
  let settings: GuestSettings | undefined;
  let profile: TeachingProfile | undefined;
  const sources = new Map<
    string,
    { info: SourceInfo; chunks: ReadonlyArray<SourceChunk>; file?: Uint8Array }
  >();
  const failure = (error: unknown) =>
    new StorageFailure({ message: error instanceof Error ? error.message : String(error) });
  const changed = () => emit({ _tag: 'SourcesChanged' });
  const listeners = new Set<(change: StorageChange) => void>();
  const emit = (change: StorageChange) => listeners.forEach((listener) => listener(change));

  return {
    persistent: false,

    appendEvents: (sessionId, events, figures = []) =>
      Effect.suspend(() => {
        // Validate the whole batch before touching state: all or none.
        try {
          checkFigures(events, figures);
        } catch (error) {
          return Effect.fail(failure(error));
        }
        if (figures.some((figure) => figureBodies.has(figure.figureId))) {
          return Effect.fail(new StorageFailure({ message: 'Duplicate figure id' }));
        }
        const batchIds = new Set<string>();
        for (const event of events) {
          if (eventIds.has(event.id) || batchIds.has(event.id)) {
            return Effect.fail(new StorageFailure({ message: `Duplicate event id ${event.id}` }));
          }
          batchIds.add(event.id);
        }
        const log = sessions.get(sessionId) ?? [];
        log.push(...events);
        sessions.set(sessionId, log);
        batchIds.forEach((id) => eventIds.add(id));
        figures.forEach((figure) => figureBodies.set(figure.figureId, figure));
        if (events.length > 0) emit({ _tag: 'SessionChanged', sessionId });
        return Effect.succeed({ lastSeq: log.length - 1 });
      }),

    readSession: (sessionId) => Effect.sync(() => [...(sessions.get(sessionId) ?? [])]),

    readFigure: (figureId) => Effect.sync(() => figureBodies.get(figureId)),

    listSessions: Effect.sync(() => {
      const rows: SessionSummary[] = [];
      for (const [sessionId, log] of sessions) {
        const first = log[0];
        const last = log[log.length - 1];
        if (!first || !last) continue;
        const created = log.find((event) => event._tag === 'SessionCreated');
        rows.push({
          sessionId,
          topic: created?.topic ?? '',
          createdAt: first.at,
          updatedAt: last.at,
          eventCount: log.length,
        });
      }
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    }),

    appendKnowledge: (events, { expectedLastSeq }) =>
      Effect.suspend((): Effect.Effect<AppendResult, StorageFailure | KnowledgeConflict> => {
        const lastSeq = knowledge.length - 1;
        if (expectedLastSeq !== lastSeq) {
          return Effect.fail(new KnowledgeConflict({ expectedLastSeq, lastSeq }));
        }
        const batchIds = new Set<string>();
        for (const event of events) {
          if (knowledgeIds.has(event.id) || batchIds.has(event.id)) {
            return Effect.fail(new StorageFailure({ message: `Duplicate event id ${event.id}` }));
          }
          batchIds.add(event.id);
        }
        knowledge.push(...events);
        batchIds.forEach((id) => knowledgeIds.add(id));
        if (events.length > 0) emit({ _tag: 'KnowledgeChanged' });
        return Effect.succeed({ lastSeq: knowledge.length - 1 });
      }),

    readKnowledge: Effect.sync(() => [...knowledge]),

    createSource: (source) =>
      Effect.try({
        try: () => {
          const info = checkNewSourceInfo(source.info);
          if (sources.has(info.sourceId)) throw new Error(`Duplicate source ${info.sourceId}`);
          if (source.state === 'ready') {
            const bytes = checkChunks(source.chunks);
            sources.set(info.sourceId, {
              info: { ...info, state: 'ready', bytes, chunkCount: source.chunks.length },
              chunks: structuredClone([...source.chunks]),
            });
          } else {
            sources.set(info.sourceId, {
              info,
              chunks: [],
              ...(source.file === undefined ? {} : { file: source.file.slice() }),
            });
          }
          changed();
        },
        catch: failure,
      }),

    completeSource: (sourceId, chunks, options) =>
      Effect.try({
        try: () => {
          const bytes = checkChunks(chunks);
          const entry = sources.get(sourceId);
          if (entry?.info.state !== 'pending') {
            throw new SourceConflict({ message: 'The source is not pending.' });
          }
          const { failure: _failure, ...info } = entry.info;
          sources.set(sourceId, {
            info: {
              ...info,
              ...(options?.title === undefined ? {} : { title: options.title }),
              state: 'ready',
              bytes,
              chunkCount: chunks.length,
            },
            chunks: structuredClone([...chunks]),
          });
          changed();
        },
        catch: (error) => (error instanceof SourceConflict ? error : failure(error)),
      }),

    failSource: (sourceId, why) =>
      Effect.suspend(() => {
        const entry = sources.get(sourceId);
        if (entry?.info.state !== 'pending') {
          return Effect.fail(new SourceConflict({ message: 'The source is not pending.' }));
        }
        entry.info = { ...entry.info, state: 'failed', failure: why };
        changed();
        return Effect.void;
      }),

    retrySource: (sourceId) =>
      Effect.suspend(() => {
        const entry = sources.get(sourceId);
        if (entry === undefined || entry.info.state === 'ready') {
          return Effect.fail(new SourceConflict({ message: 'The source cannot run again.' }));
        }
        const { failure: _failure, ...info } = entry.info;
        entry.info = { ...info, state: 'pending' };
        changed();
        return Effect.void;
      }),

    listSources: Effect.sync(() =>
      [...sources.values()]
        .map((entry) => entry.info)
        .sort((a, b) => b.createdAt - a.createdAt || a.sourceId.localeCompare(b.sourceId)),
    ),

    getSource: (sourceId) => Effect.sync(() => sources.get(sourceId)?.info),

    readSourceFile: (sourceId) => Effect.sync(() => sources.get(sourceId)?.file?.slice()),

    readChunks: (sourceIds) =>
      Effect.sync(() =>
        sourceIds.flatMap((sourceId) => {
          const entry = sources.get(sourceId);
          return entry === undefined
            ? []
            : entry.chunks.map((chunk) => ({ sourceId, title: entry.info.title, chunk }));
        }),
      ),

    deleteSource: (sourceId) =>
      Effect.sync(() => {
        sources.delete(sourceId);
        changed();
      }),

    getSettings: Effect.sync(() => settings),

    saveSettings: (next) =>
      Effect.sync(() => {
        settings = next;
        emit({ _tag: 'SettingsChanged' });
      }),

    deleteApiKey: Effect.sync(() => {
      if (settings) {
        const { apiKey: _apiKey, ...rest } = settings;
        settings = rest;
      }
      emit({ _tag: 'SettingsChanged' });
    }),

    deleteImageApiKey: Effect.sync(() => {
      if (settings?.image) {
        const { apiKey: _apiKey, ...image } = settings.image;
        settings = { ...settings, image };
      }
      emit({ _tag: 'SettingsChanged' });
    }),

    getProfile: Effect.sync(() => profile),

    saveProfile: (next) =>
      Effect.suspend(() => {
        if (
          next !== undefined &&
          Schema.decodeUnknownResult(SavedProfile)(next)._tag === 'Failure'
        ) {
          return Effect.fail(new StorageFailure({ message: 'Profile is not valid' }));
        }
        profile = next === undefined ? undefined : structuredClone(next);
        emit({ _tag: 'ProfileChanged' });
        return Effect.void;
      }),

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
  };
};
