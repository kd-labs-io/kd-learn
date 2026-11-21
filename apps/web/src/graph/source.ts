// What the graph screen needs, whoever keeps the knowledge log: the local DB (guest, demo) or the
// server (account). Same pattern as `LessonSource` (learn/source.ts). The screen updates by itself:
// guest re-reads on `KnowledgeChanged`; account polls the extraction list only while an extraction
// is queued or running, and reads the graph again when one ends.
import { Effect } from 'effect';
import { toGraphView, type GraphView } from '@kd-learn/api';
import type { KnowledgeEvent, KnowledgeGraph } from '@kd-learn/core';
import { appendKnowledgeChecked } from '@kd-learn/storage/port';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { errorText, keys, useAccountApi } from '../account/api';
import { guestExtractor } from '../knowledge';
import { getStorage, useKnowledge, useSessionList } from '../storage';

/** A session whose extraction is not done: what the screen shows, and whether it can retry it. */
export interface PendingExtraction {
  readonly sessionId: string;
  readonly topic: string;
  readonly state: 'running' | 'failed' | 'notRun';
  readonly message?: string;
}

export type GraphScreenView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly graph: GraphView;
      /** Session id to topic, for the sources of a proposition. */
      readonly topics: ReadonlyMap<string, string>;
      readonly pending: ReadonlyArray<PendingExtraction>;
    };

export interface KnowledgeSource {
  readonly view: GraphScreenView;
  /** Rejects when the store refuses (conflict, storage failure). */
  retire(propositionId: string): Promise<void>;
  /** Extract a session now, or again after a failure. */
  extract(sessionId: string): Promise<void>;
}

const retireEvent = (propositionId: string): KnowledgeEvent => ({
  _tag: 'PropositionRetired',
  id: crypto.randomUUID(),
  at: Date.now(),
  propositionId,
});

/** Sessions of a local graph whose last attempt did not extract them. */
const localPending = (
  graph: KnowledgeGraph,
  running: ReadonlySet<string>,
  topics: ReadonlyMap<string, string>,
): PendingExtraction[] =>
  Object.entries(graph.extractions).flatMap(([sessionId, extraction]): PendingExtraction[] => {
    if (extraction.extractedBy !== undefined) return [];
    const last = extraction.attempts.at(-1);
    if (last === undefined) return [];
    const topic = topics.get(sessionId) ?? '';
    if (running.has(sessionId)) return [{ sessionId, topic, state: 'running' }];
    // `started` but not running in this tab: another tab runs it, or it was interrupted. Either way
    // a retry queues behind the lock and closes an interrupted attempt first.
    return last.status === 'failed'
      ? [{ sessionId, topic, state: 'failed', message: last.failure?.message ?? '' }]
      : [{ sessionId, topic, state: 'notRun' }];
  });

/** Guest and demo: the local knowledge log. */
export function useGuestKnowledgeSource(): KnowledgeSource {
  const knowledge = useKnowledge();
  const sessions = useSessionList();
  const running = useSyncExternalStore(
    guestExtractor.subscribe,
    guestExtractor.running,
    guestExtractor.running,
  );
  const topics = useMemo(
    () =>
      new Map(
        (sessions.status === 'ready' ? sessions.data : []).map((s) => [s.sessionId, s.topic]),
      ),
    [sessions],
  );
  // The graph view depends on the log alone: a new object only when the log changes, so the
  // figure is not rebuilt when an extraction starts or a session is renamed.
  const projected = useMemo(() => {
    if (knowledge.status !== 'ready') return undefined;
    const graph = knowledge.data.graph;
    return graph._tag === 'Failure'
      ? ({ failure: graph.failure.message } as const)
      : ({ graph: graph.success, view: toGraphView(graph.success) } as const);
  }, [knowledge]);
  const view = useMemo((): GraphScreenView => {
    if (knowledge.status === 'loading') return knowledge;
    if (knowledge.status === 'error') return { status: 'error', message: knowledge.error.message };
    if (projected === undefined) return { status: 'loading' };
    if ('failure' in projected) return { status: 'error', message: projected.failure };
    return {
      status: 'ready',
      graph: projected.view,
      topics,
      pending: localPending(projected.graph, running, topics),
    };
  }, [knowledge, projected, running, topics]);
  return {
    view,
    // No knowledge lock: a retire must not wait for an extraction. The checked append rebuilds on
    // a conflict, and an extraction fits its batch to the graph as it is when it writes.
    retire: async (propositionId) => {
      const storage = await getStorage();
      await Effect.runPromise(
        appendKnowledgeChecked(storage, (graph) =>
          graph.propositions[propositionId] === undefined ? [] : [retireEvent(propositionId)],
        ),
      );
    },
    extract: async (sessionId) => {
      const result = await guestExtractor.extract(sessionId);
      if (result._tag === 'Failed') throw new Error(result.failure.message);
    },
  };
}

const POLL_MS = 1500;

/** Account: `GET /api/account/knowledge` through Query, refreshed when an extraction ends. */
export function useAccountKnowledgeSource(token: string): KnowledgeSource {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const graph = useQuery({
    queryKey: keys.knowledge(token),
    queryFn: () => call((api) => api.knowledge()),
  });
  const extractions = useQuery({
    queryKey: keys.extractions(token),
    queryFn: () => call((api) => api.extractions()),
    // Poll only while something runs (the list reads every session of the account).
    refetchInterval: (query) =>
      query.state.data?.sessions.some((s) => s.state === 'queued' || s.state === 'running')
        ? POLL_MS
        : false,
  });

  // An extraction that ends changes the graph: read it again.
  const active = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Set(
      (extractions.data?.sessions ?? [])
        .filter((s) => s.state === 'queued' || s.state === 'running')
        .map((s) => s.sessionId),
    );
    const ended = [...active.current].some((id) => !now.has(id));
    active.current = now;
    if (ended) void queryClient.invalidateQueries({ queryKey: keys.knowledge(token) });
  }, [extractions.data, queryClient, token]);

  const retire = useMutation({
    mutationFn: (propositionId: string) => call((api) => api.retireProposition(propositionId)),
    onSuccess: (next: GraphView) => queryClient.setQueryData(keys.knowledge(token), next),
  });
  const extract = useMutation({
    mutationFn: (sessionId: string) => call((api) => api.extractSession(sessionId)),
    onSuccess: (list) => queryClient.setQueryData(keys.extractions(token), list),
  });

  const view = useMemo((): GraphScreenView => {
    if (graph.isPending) return { status: 'loading' };
    if (graph.isError) return { status: 'error', message: errorText(graph.error) };
    const sessions = extractions.data?.sessions ?? [];
    return {
      status: 'ready',
      graph: graph.data,
      topics: new Map(sessions.map((s) => [s.sessionId, s.topic])),
      pending: sessions.flatMap((s): PendingExtraction[] => {
        const base = { sessionId: s.sessionId, topic: s.topic };
        switch (s.state) {
          case 'queued':
          case 'running':
            return [{ ...base, state: 'running' }];
          case 'failed':
            return [{ ...base, state: 'failed', message: s.failure?.message ?? '' }];
          case 'none':
            // A completed session never attempted (no model then): offer to run it.
            return s.completed ? [{ ...base, state: 'notRun' }] : [];
          case 'extracted':
            return [];
        }
      }),
    };
  }, [graph.isPending, graph.isError, graph.error, graph.data, extractions.data]);

  return {
    view,
    retire: async (propositionId) => void (await retire.mutateAsync(propositionId)),
    extract: async (sessionId) => void (await extract.mutateAsync(sessionId)),
  };
}
