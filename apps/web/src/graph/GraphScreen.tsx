// Knowledge graph screen (plan luyen-tap-graph.md A9, phase 3 step 9). The list is the main way in,
// and the only one for keyboard and screen readers: search, filter by topic, a statement's detail
// (sources, links in and out, mastery) and removing it. The figure (sigma, loaded lazily on the
// client) follows the selection and can be cut without losing anything.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { HStack } from '@astryxdesign/core/HStack';
import { Item } from '@astryxdesign/core/Item';
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout';
import { List } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import type { EdgeView, GraphView, PropositionView } from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { relationText } from './relation';
import type { KnowledgeSource, PendingExtraction } from './source';

const GraphFigure = lazy(() => import('./GraphFigure'));

/** Rows shown before "Show more": a long list stays cheap to render. */
const PAGE = 100;
const ALL_TOPICS = '';
/** Sessions to extract shown one banner each; the rest behind a button. */
const MAX_BANNERS = 3;

const masteryText = (p: PropositionView) =>
  p.mastery === undefined ? m.graph_mastery_none() : m.graph_mastery({ box: p.mastery.box });

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function GraphScreen({ source }: { readonly source: KnowledgeSource }) {
  const view = source.view;
  if (view.status === 'ready') {
    return (
      <ReadyGraph source={source} graph={view.graph} topics={view.topics} pending={view.pending} />
    );
  }
  return (
    <Layout
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          {view.status === 'loading' ? (
            <Spinner label={m.learn_loading()} />
          ) : (
            <Banner status="error" title={view.message} />
          )}
        </LayoutContent>
      }
    />
  );
}

function ReadyGraph({
  source,
  graph,
  topics,
  pending,
}: {
  readonly source: KnowledgeSource;
  readonly graph: GraphView;
  readonly topics: ReadonlyMap<string, string>;
  readonly pending: ReadonlyArray<PendingExtraction>;
}) {
  const wide = useMediaQuery('(min-width: 980px)');
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState(ALL_TOPICS);
  const [session, setSession] = useState(ALL_TOPICS);
  const [limit, setLimit] = useState(PAGE);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // The figure needs WebGL and the DOM: never rendered (nor its chunk loaded) on the server.
  const [client, setClient] = useState(false);
  useEffect(() => setClient(true), []);

  const byId = useMemo(
    () => new Map(graph.propositions.map((p) => [p.propositionId, p])),
    [graph.propositions],
  );
  const topicOptions = useMemo(() => {
    const all = [...new Set(graph.propositions.map((p) => p.topic))].sort((a, b) =>
      a.localeCompare(b),
    );
    return [
      { value: ALL_TOPICS, label: m.graph_topic_all() },
      ...all.map((t) => ({ value: t, label: t })),
    ];
  }, [graph.propositions]);
  const sessionOptions = useMemo(() => {
    const ids = [...new Set(graph.propositions.flatMap((p) => p.sources.map((s) => s.sessionId)))];
    return [
      { value: ALL_TOPICS, label: m.graph_session_all() },
      ...ids.map((id) => ({ value: id, label: topics.get(id) || m.graph_source_unknown() })),
    ];
  }, [graph.propositions, topics]);
  const matching = useMemo(() => {
    const needle = fold(query.trim());
    return graph.propositions.filter(
      (p) =>
        (topic === ALL_TOPICS || p.topic === topic) &&
        (session === ALL_TOPICS || p.sources.some((s) => s.sessionId === session)) &&
        (needle === '' || fold(p.text).includes(needle)),
    );
  }, [graph.propositions, query, topic, session]);
  // A retired or merged proposition leaves the selection.
  const selected = selectedId === undefined ? undefined : byId.get(selectedId);

  const detail = (
    <PropositionDetail
      proposition={selected}
      graph={graph}
      byId={byId}
      topics={topics}
      onSelect={setSelectedId}
      onRetire={async (id) => {
        await source.retire(id);
        setSelectedId(undefined);
      }}
    />
  );

  const list = (
    <VStack gap={4}>
      <Heading level={2}>{m.graph_title()}</Heading>
      <PendingBanners pending={pending} onExtract={source.extract} />
      {graph.propositions.length === 0 ? (
        <EmptyState
          title={m.graph_empty_title()}
          description={m.graph_empty_body()}
          headingLevel={3}
        />
      ) : (
        <>
          <HStack gap={3} wrap="wrap" vAlign="end">
            <TextInput
              label={m.graph_search()}
              placeholder={m.graph_search_placeholder()}
              value={query}
              onChange={(value) => {
                setQuery(value);
                setLimit(PAGE);
              }}
              type="search"
              data-testid="graph-search"
            />
            <Selector
              label={m.graph_topic()}
              options={topicOptions}
              value={topic}
              onChange={(value) => {
                setTopic(value as string);
                setLimit(PAGE);
              }}
              data-testid="graph-topic"
            />
            <Selector
              label={m.graph_session()}
              options={sessionOptions}
              value={session}
              onChange={(value) => {
                setSession(value as string);
                setLimit(PAGE);
              }}
              data-testid="graph-session"
            />
          </HStack>
          <Text type="supporting" data-testid="graph-count">
            {m.graph_count({
              shown: Math.min(limit, matching.length),
              total: graph.propositions.length,
            })}
          </Text>
          {matching.length === 0 ? (
            <Text>{m.graph_no_match()}</Text>
          ) : (
            <List hasDividers density="compact" data-testid="graph-list">
              {matching.slice(0, limit).map((p) => (
                <Item
                  key={p.propositionId}
                  label={p.text}
                  labelLines={2}
                  description={`${p.topic} · ${masteryText(p)}`}
                  isSelected={p.propositionId === selectedId}
                  onClick={() => setSelectedId(p.propositionId)}
                  data-testid="graph-item"
                />
              ))}
            </List>
          )}
          {matching.length > limit ? (
            <Button
              label={m.graph_show_more()}
              variant="secondary"
              onClick={() => setLimit((n) => n + PAGE)}
              data-testid="graph-more"
            />
          ) : null}
          {client ? (
            <Suspense fallback={null}>
              <GraphFigure
                graph={graph}
                selectedId={selected?.propositionId}
                onSelect={setSelectedId}
              />
            </Suspense>
          ) : null}
        </>
      )}
    </VStack>
  );

  return (
    <Layout
      header={<AppHeader />}
      end={
        wide ? (
          <LayoutPanel width={420} hasDivider label={m.graph_detail_title()}>
            {detail}
          </LayoutPanel>
        ) : undefined
      }
      content={
        <LayoutContent padding={wide ? 6 : 4}>
          <VStack gap={6}>
            {list}
            {wide ? null : detail}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function PendingBanners({
  pending,
  onExtract,
}: {
  readonly pending: ReadonlyArray<PendingExtraction>;
  readonly onExtract: (sessionId: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [all, setAll] = useState(false);
  const running = pending.filter((p) => p.state === 'running');
  const waiting = pending.filter((p) => p.state !== 'running');
  const shown = all ? waiting : waiting.slice(0, MAX_BANNERS);
  const retry = (sessionId: string) => {
    setError(undefined);
    onExtract(sessionId).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };
  return (
    <>
      {running.length > 0 ? (
        <HStack gap={2} vAlign="center" data-testid="graph-extracting">
          <Spinner size="sm" label={m.graph_extracting({ count: running.length })} />
          <Text type="supporting">{m.graph_extracting({ count: running.length })}</Text>
        </HStack>
      ) : null}
      {shown.map((p) => (
        <Banner
          key={p.sessionId}
          status={p.state === 'failed' ? 'warning' : 'info'}
          title={
            p.state === 'failed'
              ? m.graph_extract_failed({ topic: p.topic, reason: p.message ?? '' })
              : m.graph_extract_not_run({ topic: p.topic })
          }
          endContent={
            <Button
              label={p.state === 'failed' ? m.graph_extract_retry() : m.graph_extract_now()}
              size="sm"
              variant="secondary"
              onClick={() => retry(p.sessionId)}
              data-testid="graph-extract"
            />
          }
          data-testid="graph-pending"
        />
      ))}
      {waiting.length > shown.length ? (
        <Button
          label={m.graph_extract_more({ count: waiting.length - shown.length })}
          variant="ghost"
          size="sm"
          onClick={() => setAll(true)}
        />
      ) : null}
      {error === undefined ? null : <Banner status="error" title={error} />}
    </>
  );
}

function PropositionDetail({
  proposition,
  graph,
  byId,
  topics,
  onSelect,
  onRetire,
}: {
  readonly proposition: PropositionView | undefined;
  readonly graph: GraphView;
  readonly byId: ReadonlyMap<string, PropositionView>;
  readonly topics: ReadonlyMap<string, string>;
  readonly onSelect: (id: string) => void;
  readonly onRetire: (id: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  if (proposition === undefined) {
    return <Text type="supporting">{m.graph_detail_none()}</Text>;
  }
  const id = proposition.propositionId;
  const out = graph.edges.filter((e) => e.from === id);
  const into = graph.edges.filter((e) => e.to === id);
  const edgeItems = (edges: ReadonlyArray<EdgeView>, other: (e: EdgeView) => string) =>
    edges.length === 0 ? (
      <Text type="supporting">{m.graph_edges_none()}</Text>
    ) : (
      <List density="compact">
        {edges.map((e) => {
          const target = byId.get(other(e));
          return (
            <Item
              key={e.edgeId}
              label={target?.text ?? ''}
              labelLines={2}
              description={`${relationText(e.relation)} · ${e.label}`}
              onClick={() => onSelect(other(e))}
              data-testid="graph-edge"
            />
          );
        })}
      </List>
    );

  return (
    <VStack gap={4} data-testid="graph-detail">
      <Heading level={3}>{m.graph_detail_title()}</Heading>
      <Text data-testid="graph-detail-text">{proposition.text}</Text>
      <Text type="supporting">{`${proposition.topic} · ${masteryText(proposition)}`}</Text>
      <VStack gap={2}>
        <Text type="label">{m.graph_sources()}</Text>
        <List density="compact">
          {proposition.sources.map((s) => (
            <Item
              key={`${s.sessionId}/${s.stepId ?? ''}`}
              label={topics.get(s.sessionId) || m.graph_source_unknown()}
            />
          ))}
        </List>
      </VStack>
      <VStack gap={2}>
        <Text type="label">{m.graph_edges_out()}</Text>
        {edgeItems(out, (e) => e.to)}
      </VStack>
      <VStack gap={2}>
        <Text type="label">{m.graph_edges_in()}</Text>
        {edgeItems(into, (e) => e.from)}
      </VStack>
      {confirming ? (
        <VStack gap={2}>
          <Text>{m.graph_retire_confirm()}</Text>
          <HStack gap={2}>
            <Button
              label={m.graph_retire()}
              variant="destructive"
              isLoading={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                onRetire(id)
                  .catch((e: unknown) =>
                    setError(
                      m.graph_retire_failed({ reason: e instanceof Error ? e.message : String(e) }),
                    ),
                  )
                  .finally(() => {
                    setBusy(false);
                    setConfirming(false);
                  });
              }}
              data-testid="graph-retire-confirm"
            />
            <Button
              label={m.profile_cancel()}
              variant="ghost"
              onClick={() => setConfirming(false)}
            />
          </HStack>
        </VStack>
      ) : (
        <Button
          label={m.graph_retire()}
          variant="secondary"
          onClick={() => setConfirming(true)}
          data-testid="graph-retire"
        />
      )}
      {error === undefined ? null : <Banner status="error" title={error} />}
    </VStack>
  );
}
