// What the sources screen needs, whoever keeps the sources: the local DB (guest, demo) or the
// server (account). Same pattern as `LessonSource` and `KnowledgeSource`. The list updates by
// itself: guest re-reads on `SourcesChanged`; account polls while a source is `pending`.
import { Effect } from 'effect';
import { MAX_PDF_BYTES, searchOptions, type SearchProvider } from '@kd-learn/api';
import type { SourceChunk, SourceInfo } from '@kd-learn/core';
import { getLocale, m } from '@kd-learn/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { errorText, keys, useAccountApi } from '../account/api';
import { apiBaseUrl } from '../learn/hooks';
import { getStorage, useStorageQuery } from '../storage';
import { guestSources } from './index';
import { attachWhenIdle, setLocalSessionSources, type SourceChange } from './attach';
import { readNoteFile } from './notes';

/** A source as the screen shows it. `interrupted`: pending, but nothing runs it any more (guest). */
export type SourceRow = SourceInfo & { readonly interrupted: boolean };

export type SourcesView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly sources: ReadonlyArray<SourceRow> };

export interface SourceLibrary {
  readonly view: SourcesView;
  /** Search sources usable for research here, the default first; empty: no research. */
  readonly providers: ReadonlyArray<SearchProvider>;
  /** Rejects with a message to show. Resolves once stored (a PDF may still be read). */
  addPdf(file: File): Promise<void>;
  /** One source per file. Resolves to the messages of the files that were refused. */
  addNotes(files: ReadonlyArray<File>): Promise<ReadonlyArray<string>>;
  /** With `sessionId`, the source is attached to that lesson once ready. */
  research(question: string, provider: SearchProvider, sessionId?: string): Promise<void>;
  retry(sourceId: string): Promise<void>;
  remove(sourceId: string): Promise<void>;
  chunks(sourceId: string): Promise<ReadonlyArray<SourceChunk>>;
}

const POLL_MS = 1500;

/** The language of a research: the interface language. */
const researchLanguage = () => getLocale();

/** Guest and demo: the local DB. */
export function useGuestSourceLibrary(mode: 'guest' | 'demo'): SourceLibrary {
  const list = useStorageQuery(
    () => Effect.promise(() => guestSources.list()),
    (change) => change._tag === 'SourcesChanged',
    [],
  );
  const providers = useQuery({
    queryKey: keys.searchOptions(undefined, mode),
    queryFn: () =>
      Effect.runPromise(searchOptions(mode, apiBaseUrl === '' ? {} : { baseUrl: apiBaseUrl })),
    staleTime: 30_000,
  });
  const view = useMemo((): SourcesView => {
    if (list.status === 'loading') return list;
    if (list.status === 'error') return { status: 'error', message: list.error.message };
    return { status: 'ready', sources: list.data };
  }, [list]);
  return {
    view,
    providers: providers.data ?? [],
    addPdf: async (file) => {
      if (file.size > MAX_PDF_BYTES) throw new Error(m.sources_pdf_too_large());
      // Stored pending at once; the reading goes on in this tab, past this screen.
      void guestSources.addPdf(file).catch(() => undefined);
    },
    addNotes: async (files) =>
      (await guestSources.addNotes(files)).flatMap((r) =>
        r._tag === 'Refused' ? [`${r.origin}: ${r.message}`] : [],
      ),
    research: async (question, provider, sessionId) => {
      void guestSources
        .addResearch({ question, language: researchLanguage(), provider })
        .then(async (added) => {
          if (sessionId === undefined || added._tag !== 'Added' || added.source.state !== 'ready') {
            return;
          }
          await attachWhenIdle(await getStorage(), sessionId, [added.source.sourceId]);
        })
        .catch(() => undefined);
    },
    retry: async (sourceId) => {
      void guestSources.retry(sourceId);
    },
    remove: (sourceId) => guestSources.remove(sourceId),
    chunks: async (sourceId) => {
      const storage = await getStorage();
      return (await Effect.runPromise(storage.readChunks([sourceId]))).map((s) => s.chunk);
    },
  };
}

/** Account: `/api/account/sources` through Query, polled while a source is pending. */
export function useAccountSourceLibrary(token: string): SourceLibrary {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: keys.sources(token),
    queryFn: () => call((api) => api.sources()),
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.state === 'pending') ? POLL_MS : false,
  });
  const providers = useQuery({
    queryKey: keys.searchOptions(token, 'account'),
    queryFn: () => call((api) => api.searchOptions()),
    staleTime: 30_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.sources(token) });
  const view = useMemo((): SourcesView => {
    if (list.isPending) return { status: 'loading' };
    if (list.isError) return { status: 'error', message: errorText(list.error) };
    return {
      status: 'ready',
      sources: list.data.map((s) => ({ ...s, interrupted: false })),
    };
  }, [list.isPending, list.isError, list.error, list.data]);
  const failing = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      throw new Error(errorText(error), { cause: error });
    } finally {
      await refresh();
    }
  };
  return {
    view,
    providers: providers.data?.providers ?? [],
    addPdf: (file) => failing(() => call((api) => api.uploadPdfSource(file, file.name))),
    addNotes: async (files) => {
      const refused: string[] = [];
      for (const file of files) {
        const note = await readNoteFile(file);
        if (!note.ok) {
          refused.push(`${note.origin}: ${note.failure.message}`);
          continue;
        }
        try {
          await call((api) =>
            api.createNoteSource({
              kind: 'note',
              title: note.title,
              origin: note.origin,
              chunks: note.chunks,
            }),
          );
        } catch (error) {
          refused.push(`${note.origin}: ${errorText(error)}`);
        }
      }
      await refresh();
      return refused;
    },
    research: (question, provider, sessionId) =>
      failing(() =>
        call((api) =>
          api.createResearch({
            question,
            language: researchLanguage(),
            provider,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        ),
      ),
    retry: (sourceId) => failing(() => call((api) => api.retrySource(sourceId))),
    remove: (sourceId) => failing(() => call((api) => api.deleteSource(sourceId))),
    chunks: async (sourceId) => (await call((api) => api.source(sourceId))).chunks,
  };
}
/** The sources of one lesson: the library to pick from, and attach/detach. */
export interface LessonSources {
  readonly library: SourceLibrary;
  /** Rejects with a message to show (a turn is running, an unknown source). */
  set(change: SourceChange): Promise<void>;
}

export function useGuestLessonSources(sessionId: string, mode: 'guest' | 'demo'): LessonSources {
  const library = useGuestSourceLibrary(mode);
  return {
    library,
    set: async (change) => {
      const result = await setLocalSessionSources(await getStorage(), sessionId, change);
      if (result === 'busy') throw new Error(m.sources_busy());
      if (result !== 'ok') throw new Error(m.sources_attach_failed());
    },
  };
}

export function useAccountLessonSources(token: string, sessionId: string): LessonSources {
  const { call } = useAccountApi();
  const library = useAccountSourceLibrary(token);
  return {
    library,
    set: async (change) => {
      try {
        await call((api) =>
          api.setSessionSources(sessionId, {
            attach: [...change.attach],
            detach: [...change.detach],
          }),
        );
      } catch (error) {
        throw new Error(errorText(error), { cause: error });
      }
    },
  };
}

const PROVIDER_KEY = 'kd-learn:search-provider';

/** The search source this device prefers, if it is offered; else the server's default (first). */
export const preferredProvider = (
  providers: ReadonlyArray<SearchProvider>,
): SearchProvider | undefined => {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(PROVIDER_KEY);
  } catch {
    // Storage blocked: the default.
  }
  return providers.find((p) => p === saved) ?? providers[0];
};

export const savePreferredProvider = (provider: SearchProvider): void => {
  try {
    localStorage.setItem(PROVIDER_KEY, provider);
  } catch {
    // Storage blocked: the choice lasts for this screen only.
  }
};
