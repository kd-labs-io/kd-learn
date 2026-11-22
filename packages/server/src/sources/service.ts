// Learning sources of accounts (plan nguon-hoc.md A2, A4). A note arrives chunked by the client and
// is `ready` at once. A PDF is stored `pending` with its file, and a durable `ingest` job (A1)
// extracts it in a worker thread: closing the tab does not stop it, a restart runs it again. The
// job writes the chunks and `ready` in one batch (`completeSource`), or `failed` with a code.
import { Cause, Effect, Exit } from 'effect';
import {
  SourceFailureCode,
  pdfSourceChunks,
  type SourceChunk,
  type SourceInfo,
} from '@kd-learn/core';
import { MAX_PDF_PAGES } from '@kd-learn/api';
import type { StorageService } from '@kd-learn/storage/port';
import type { ServerStorage } from '@kd-learn/storage/sqlite-node';
import { Schema } from 'effect';
import type { Logger } from '../handler.ts';
import type { JobKind, JobRunner } from '../jobs/runner.ts';
import { extractPdf, type PdfExtractor } from './pdf.ts';

export type SourceResult<A> =
  | { readonly _tag: 'Ok'; readonly value: A }
  | { readonly _tag: 'NotFound' }
  /** The source is not in a state for this (retry of a `ready` source, a job already running). */
  | { readonly _tag: 'Conflict'; readonly message: string };

export interface SourceService {
  readonly list: (userId: string) => ReadonlyArray<SourceInfo>;
  readonly get: (
    userId: string,
    sourceId: string,
  ) => { readonly source: SourceInfo; readonly chunks: ReadonlyArray<SourceChunk> } | undefined;
  readonly createNote: (
    userId: string,
    input: {
      readonly title: string;
      readonly origin: string;
      readonly chunks: ReadonlyArray<SourceChunk>;
    },
  ) => SourceResult<SourceInfo>;
  readonly createPdf: (
    userId: string,
    input: { readonly fileName: string; readonly file: Uint8Array },
  ) => SourceInfo;
  readonly retry: (userId: string, sourceId: string) => SourceResult<SourceInfo>;
  readonly remove: (userId: string, sourceId: string) => void;
}

export interface SourceServiceDeps {
  readonly storage: ServerStorage;
  readonly jobs: JobRunner;
  readonly log: Logger;
  /** Tests replace the worker. */
  readonly extract?: PdfExtractor;
  readonly newId?: () => string;
  readonly now?: () => number;
}

const IngestPayload = Schema.Struct({ sourceId: Schema.NonEmptyString });
type IngestPayload = typeof IngestPayload.Type;

const sync = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

/** A PDF's title from its file name: without the extension, at most 300 characters. */
export const titleFromFileName = (fileName: string): string => {
  const base = fileName
    .replace(/^.*[\\/]/, '')
    .replace(/\.pdf$/i, '')
    .trim();
  return (base === '' ? 'PDF' : base).slice(0, 300);
};

export const makeSourceService = (deps: SourceServiceDeps): SourceService => {
  const { storage, jobs, log } = deps;
  const extract = deps.extract ?? extractPdf;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;

  const failIfPending = (user: StorageService, sourceId: string, code: string, message: string) =>
    user
      .failSource(sourceId, { code, message })
      .pipe(Effect.catchTag('SourceConflict', () => Effect.void));

  const ingest: JobKind<IngestPayload> = {
    kind: 'ingest',
    payload: IngestPayload as never,
    // The worker's memory guard reads the RSS of the whole process (spike C1).
    global: 1,
    run: (userId, { sourceId }) => {
      const user = storage.forUser(userId);
      return Effect.gen(function* () {
        const info = yield* user.getSource(sourceId);
        if (info === undefined || info.state !== 'pending') return;
        const file = yield* user.readSourceFile(sourceId);
        if (file === undefined) {
          yield* failIfPending(user, sourceId, SourceFailureCode.Invalid, 'The file is gone.');
          return;
        }
        const extracted = yield* extract(file, { maxPages: MAX_PDF_PAGES });
        const outcome = pdfSourceChunks(extracted);
        if (outcome.ok) {
          // Deleted or completed meanwhile: nothing to do.
          yield* user
            .completeSource(sourceId, outcome.chunks)
            .pipe(Effect.catchTag('SourceConflict', () => Effect.void));
          log({ event: 'sources.ingested', fields: { chunks: outcome.chunks.length } });
        } else {
          yield* failIfPending(user, sourceId, outcome.failure.code, outcome.failure.message);
          log({ event: 'sources.ingest_failed', fields: { code: outcome.failure.code } });
        }
      }).pipe(
        // A storage error ends the job as failed; an interruption (process stop) propagates, so
        // the runner keeps the row and runs it again after the restart.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : failIfPending(
                user,
                sourceId,
                SourceFailureCode.Failed,
                'Reading this PDF failed.',
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => log({ event: 'sources.ingest_error', fields: {} })),
                ),
                Effect.ignore,
              ),
        ),
      ) as Effect.Effect<void>;
    },
    abandon: (userId, { sourceId }) => {
      const user = storage.forUser(userId);
      Effect.runSync(
        failIfPending(
          user,
          sourceId,
          SourceFailureCode.Interrupted,
          'Reading this PDF was interrupted too often. Try again.',
        ).pipe(Effect.ignore),
      );
    },
  };
  jobs.register(ingest);

  const enqueue = (userId: string, sourceId: string) =>
    jobs.enqueue(userId, ingest, sourceId, { sourceId });

  return {
    list: (userId) => sync(storage.forUser(userId).listSources),
    get: (userId, sourceId) => {
      const user = storage.forUser(userId);
      const source = sync(user.getSource(sourceId));
      if (source === undefined) return undefined;
      const chunks = sync(user.readChunks([sourceId])).map((stored) => stored.chunk);
      return { source, chunks };
    },
    createNote: (userId, input) => {
      const user = storage.forUser(userId);
      const sourceId = newId();
      const exit = Effect.runSyncExit(
        user.createSource({
          state: 'ready',
          info: {
            sourceId,
            kind: 'note',
            title: input.title,
            origin: input.origin,
            createdAt: now(),
          },
          chunks: input.chunks,
        }),
      );
      if (Exit.isFailure(exit)) {
        return { _tag: 'Conflict', message: 'The note is too large or its chunks are invalid.' };
      }
      return { _tag: 'Ok', value: sync(user.getSource(sourceId))! };
    },
    createPdf: (userId, input) => {
      const user = storage.forUser(userId);
      const sourceId = newId();
      sync(
        user.createSource({
          state: 'pending',
          info: {
            sourceId,
            kind: 'pdf',
            title: titleFromFileName(input.fileName),
            origin: input.fileName.slice(0, 2048),
            createdAt: now(),
          },
          file: input.file,
        }),
      );
      enqueue(userId, sourceId);
      return sync(user.getSource(sourceId))!;
    },
    retry: (userId, sourceId) => {
      const user = storage.forUser(userId);
      const info = sync(user.getSource(sourceId));
      if (info === undefined) return { _tag: 'NotFound' };
      if (info.kind !== 'pdf') {
        return { _tag: 'Conflict', message: 'Only a PDF can be read again.' };
      }
      if (jobs.state(userId, ingest.kind, sourceId) !== undefined) {
        return { _tag: 'Conflict', message: 'This PDF is being read.' };
      }
      const exit = Effect.runSyncExit(user.retrySource(sourceId));
      if (Exit.isFailure(exit)) {
        return { _tag: 'Conflict', message: 'This source cannot be read again.' };
      }
      enqueue(userId, sourceId);
      return { _tag: 'Ok', value: sync(user.getSource(sourceId))! };
    },
    remove: (userId, sourceId) => sync(storage.forUser(userId).deleteSource(sourceId)),
  };
};
