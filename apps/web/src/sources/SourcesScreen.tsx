// The sources screen (plan nguon-hoc.md A8): the learner's PDFs, notes and web research, for a
// guest (local DB) or an account (server), through `SourceLibrary`.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { FileInput } from '@astryxdesign/core/FileInput';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Item } from '@astryxdesign/core/Item';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { List } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { MAX_PDF_BYTES, MAX_RESEARCH_QUESTION, type SearchProvider } from '@kd-learn/api';
import type { SourceInfo } from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import { LoadingSkeleton } from '@kd-learn/ui/components/LoadingSkeleton';
import { WorkingText } from '@kd-learn/ui/components/WorkingText';
import { useState } from 'react';
import { ChunksDrawer } from './ChunksDrawer';
import {
  preferredProvider,
  savePreferredProvider,
  type SourceLibrary,
  type SourceRow,
} from './library';
import { Block } from '../app/Block';
import { pageWidth } from '../app/page';

export const kindText = (kind: SourceInfo['kind']) =>
  kind === 'pdf'
    ? m.sources_kind_pdf()
    : kind === 'note'
      ? m.sources_kind_note()
      : m.sources_kind_web();

export const providerText = (provider: SearchProvider) =>
  provider === 'searxng' ? m.search_searxng() : m.search_exa();

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

/** Message of a failure code the UI knows; the server's text otherwise. */
const failureText = (failure: NonNullable<SourceInfo['failure']>) => {
  switch (failure.code) {
    case 'NoText':
      return m.sources_fail_notext();
    case 'Encrypted':
      return m.sources_fail_encrypted();
    case 'Invalid':
      return m.sources_fail_invalid();
    case 'TooLarge':
      return m.sources_fail_toolarge();
    case 'Timeout':
      return m.sources_fail_timeout();
    case 'Interrupted':
      return m.sources_interrupted();
    case 'NoResults':
      return m.sources_fail_noresults();
    default:
      return failure.message;
  }
};

export const stateText = (source: SourceRow) =>
  source.interrupted
    ? m.sources_interrupted()
    : source.state === 'pending'
      ? source.kind === 'web'
        ? m.sources_researching()
        : m.sources_reading()
      : source.state === 'failed'
        ? failureText(source.failure ?? { code: 'Failed', message: '' })
        : m.sources_ready({ chunks: source.chunkCount ?? 0, size: sizeText(source.bytes ?? 0) });

export function SourcesScreen({ library }: { readonly library: SourceLibrary }) {
  const view = library.view;
  return (
    <Layout
      contentWidth={pageWidth}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6}>
            <Heading level={2}>{m.sources_title()}</Heading>
            <Block>
              <AddSources library={library} />
            </Block>
            <Block>
              {view.status === 'loading' ? (
                <LoadingSkeleton variant="list" label={m.loading()} />
              ) : view.status === 'error' ? (
                <Banner status="error" title={view.message} />
              ) : (
                <SourceList library={library} sources={view.sources} />
              )}
            </Block>
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function AddSources({ library }: { readonly library: SourceLibrary }) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [provider, setProvider] = useState<SearchProvider | undefined>(undefined);
  const chosen = provider ?? preferredProvider(library.providers);

  const act = async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const text = await work();
      if (text !== undefined) setMessage({ ok: false, text });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack gap={4}>
      {message ? (
        <Banner
          status={message.ok ? 'success' : 'error'}
          title={message.text}
          data-testid="sources-message"
        />
      ) : null}
      <HStack gap={4} wrap="wrap" vAlign="start">
        <FileInput
          label={m.sources_add_pdf()}
          description={m.sources_add_pdf_hint()}
          accept=".pdf,application/pdf"
          maxSize={MAX_PDF_BYTES}
          value={null}
          isLoading={busy}
          onChange={(file) => {
            if (file instanceof File) void act(async () => (await library.addPdf(file), undefined));
          }}
          data-testid="sources-pdf"
        />
        <FileInput
          label={m.sources_add_notes()}
          description={m.sources_add_notes_hint()}
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          isMultiple
          value={[]}
          isLoading={busy}
          onChange={(files) => {
            const list = Array.isArray(files) ? files : files === null ? [] : [files];
            if (list.length > 0) {
              void act(async () => {
                const refused = await library.addNotes(list);
                return refused.length === 0 ? undefined : refused.join('\n');
              });
            }
          }}
          data-testid="sources-notes"
        />
      </HStack>
      {chosen === undefined ? (
        <Text type="supporting" data-testid="sources-no-research">
          {m.sources_research_off()}
        </Text>
      ) : (
        <HStack gap={2} wrap="wrap" vAlign="end">
          <TextInput
            label={m.sources_research()}
            placeholder={m.sources_research_placeholder()}
            value={question}
            onChange={(value) => setQuestion(value.slice(0, MAX_RESEARCH_QUESTION))}
            data-testid="sources-research-question"
          />
          {library.providers.length > 1 ? (
            <Selector
              label={m.search_source()}
              options={library.providers.map((p) => ({ value: p, label: providerText(p) }))}
              value={chosen}
              onChange={(value) => {
                setProvider(value as SearchProvider);
                savePreferredProvider(value as SearchProvider);
              }}
              data-testid="sources-research-provider"
            />
          ) : null}
          <Button
            label={m.sources_research_start()}
            isDisabled={question.trim() === ''}
            isLoading={busy}
            onClick={() =>
              void act(async () => {
                await library.research(question.trim(), chosen);
                setQuestion('');
                return undefined;
              })
            }
            data-testid="sources-research-start"
          />
        </HStack>
      )}
    </VStack>
  );
}

function SourceList({
  library,
  sources,
}: {
  readonly library: SourceLibrary;
  readonly sources: ReadonlyArray<SourceRow>;
}) {
  const [open, setOpen] = useState<SourceRow | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const guard = (work: Promise<void>) =>
    void work.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  if (sources.length === 0) {
    return <EmptyState title={m.sources_empty()} description={m.sources_empty_hint()} />;
  }
  return (
    <VStack gap={2}>
      {error ? <Banner status="error" title={error} /> : null}
      <List data-testid="sources-list">
        {sources.map((source) => (
          <Item
            key={source.sourceId}
            label={source.title}
            labelLines={2}
            description={`${kindText(source.kind)} · ${stateText(source)}`}
            data-testid="source-row"
            data-state={source.interrupted ? 'interrupted' : source.state}
            endContent={
              <HStack gap={1}>
                {source.state === 'pending' && !source.interrupted ? (
                  <WorkingText label={stateText(source)} showLabel={false} />
                ) : null}
                {source.state === 'ready' ? (
                  <Button
                    label={m.sources_view()}
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpen(source)}
                    data-testid="source-view"
                  />
                ) : null}
                {source.state === 'failed' || source.interrupted ? (
                  <Button
                    label={m.sources_retry()}
                    size="sm"
                    variant="ghost"
                    onClick={() => guard(library.retry(source.sourceId))}
                    data-testid="source-retry"
                  />
                ) : null}
                <Button
                  label={m.sources_delete()}
                  size="sm"
                  variant="ghost"
                  onClick={() => guard(library.remove(source.sourceId))}
                  data-testid="source-delete"
                />
              </HStack>
            }
          />
        ))}
      </List>
      <ChunksDrawer
        title={open?.title}
        load={() => library.chunks(open?.sourceId ?? '')}
        onClose={() => setOpen(undefined)}
      />
    </VStack>
  );
}
