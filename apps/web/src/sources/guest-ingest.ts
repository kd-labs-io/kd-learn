// Sources in guest and demo mode (plan nguon-hoc.md A2, A4). Everything stays on the device: a
// note is chunked and stored `ready`; a PDF is stored `pending` with its file, read in the browser
// (`./pdf.ts`), then written `ready` or `failed` in one batch. Plain TypeScript, no React.
//
// The tab reading a PDF holds the Web Lock `kd-learn:ingest:<sourceId>`, which lives exactly as
// long as the tab. A `pending` source nobody holds the lock of was cut (tab closed, reload): the
// list shows it as interrupted, and `retry` reads the kept file again.
import { Effect } from 'effect';
import { MAX_PDF_BYTES } from '@kd-learn/api';
import { SourceFailureCode, type SourceInfo } from '@kd-learn/core';
import type { StorageService } from '@kd-learn/storage/port';
import { isLockHeld, withLock, type WithLock } from '../learn/locks';
import { readNoteFile, type NoteRead } from './notes';
import { extractPdfInBrowser, type PdfChunks } from './pdf';

export const ingestLockName = (sourceId: string) => `kd-learn:ingest:${sourceId}`;

export interface GuestSourcesDeps {
  readonly storage: () => Promise<StorageService>;
  /** Tests replace pdfjs. */
  readonly extract?: (data: Uint8Array) => Promise<PdfChunks>;
  readonly lock?: WithLock;
  readonly isHeld?: (name: string) => Promise<boolean>;
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** A source as the list shows it: `interrupted` is a `pending` source no tab is reading. */
export type GuestSourceView = SourceInfo & { readonly interrupted: boolean };

export type AddResult =
  | { readonly _tag: 'Added'; readonly source: SourceInfo }
  | { readonly _tag: 'Refused'; readonly origin: string; readonly message: string };

const titleOfPdf = (fileName: string) => {
  const base = fileName
    .replace(/^.*[\\/]/, '')
    .replace(/\.pdf$/i, '')
    .trim();
  return (base === '' ? 'PDF' : base).slice(0, 300);
};

export const makeGuestSources = (deps: GuestSourcesDeps) => {
  const extract = deps.extract ?? extractPdfInBrowser;
  const lock = deps.lock ?? withLock;
  const isHeld = deps.isHeld ?? isLockHeld;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const run = async <A, E>(use: (storage: StorageService) => Effect.Effect<A, E>) =>
    Effect.runPromise(use(await deps.storage()));

  /** Reads the kept file of a pending source under its lock. False when another tab reads it. */
  const readPending = async (sourceId: string): Promise<boolean> => {
    const outcome = await lock(ingestLockName(sourceId), async () => {
      const info = await run((s) => s.getSource(sourceId));
      if (info?.state !== 'pending') return;
      const file = await run((s) => s.readSourceFile(sourceId));
      const result: PdfChunks =
        file === undefined
          ? {
              ok: false,
              failure: { code: SourceFailureCode.Invalid, message: 'The file is gone.' },
            }
          : await extract(file).catch((): PdfChunks => ({
              ok: false,
              failure: { code: SourceFailureCode.Failed, message: 'Reading this PDF failed.' },
            }));
      // Deleted meanwhile, or completed by another path: `SourceConflict` means nothing to do.
      await run((s) =>
        (result.ok
          ? s.completeSource(sourceId, result.chunks)
          : s.failSource(sourceId, result.failure)
        ).pipe(Effect.catchTag('SourceConflict', () => Effect.void)),
      );
    });
    return outcome.acquired;
  };

  return {
    list: async (): Promise<GuestSourceView[]> => {
      const sources = await run((s) => s.listSources);
      return Promise.all(
        sources.map(async (source) => ({
          ...source,
          interrupted:
            source.state === 'pending' && !(await isHeld(ingestLockName(source.sourceId))),
        })),
      );
    },

    /** One source per note file; a file that cannot be read is refused, the others are added. */
    addNotes: async (files: ReadonlyArray<File>, read = readNoteFile): Promise<AddResult[]> => {
      const results: AddResult[] = [];
      for (const file of files) {
        const note: NoteRead = await read(file);
        if (!note.ok) {
          results.push({ _tag: 'Refused', origin: note.origin, message: note.failure.message });
          continue;
        }
        const sourceId = newId();
        await run((s) =>
          s.createSource({
            state: 'ready',
            info: {
              sourceId,
              kind: 'note',
              title: note.title,
              origin: note.origin,
              createdAt: now(),
            },
            chunks: note.chunks,
          }),
        );
        const source = (await run((s) => s.getSource(sourceId)))!;
        results.push({ _tag: 'Added', source });
      }
      return results;
    },

    /**
     * Stores the PDF `pending` and reads it. Resolves when it is `ready` or `failed`; the source is
     * in the list (and the `SourcesChanged` change sent) from the start.
     */
    addPdf: async (file: File): Promise<AddResult> => {
      const origin = file.name.slice(0, 2048);
      if (file.size > MAX_PDF_BYTES) {
        return { _tag: 'Refused', origin, message: 'A PDF may be 20 MiB at most.' };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sourceId = newId();
      await run((s) =>
        s.createSource({
          state: 'pending',
          info: { sourceId, kind: 'pdf', title: titleOfPdf(file.name), origin, createdAt: now() },
          file: bytes,
        }),
      );
      await readPending(sourceId);
      return { _tag: 'Added', source: (await run((s) => s.getSource(sourceId)))! };
    },

    /** Reads an interrupted or failed PDF again from its kept file. */
    retry: async (sourceId: string): Promise<'started' | 'busy' | 'notFound'> => {
      const info = await run((s) => s.getSource(sourceId));
      if (info === undefined || info.kind !== 'pdf') return 'notFound';
      if (await isHeld(ingestLockName(sourceId))) return 'busy';
      if (info.state === 'failed') await run((s) => s.retrySource(sourceId));
      return (await readPending(sourceId)) ? 'started' : 'busy';
    },

    remove: (sourceId: string) => run((s) => s.deleteSource(sourceId)),
  };
};

export type GuestSources = ReturnType<typeof makeGuestSources>;
