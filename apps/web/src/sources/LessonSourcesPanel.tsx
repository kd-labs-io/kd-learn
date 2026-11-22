// The sources of one lesson (phase 4 A2): tick a ready source to attach it, untick to detach. A
// source that was deleted from the library stays listed while it is attached, so it can go.
import { Banner } from '@astryxdesign/core/Banner';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { Heading } from '@astryxdesign/core/Heading';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { Session } from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import { useState } from 'react';
import type { LessonSources } from './library';
import { kindText } from './SourcesScreen';

export function LessonSourcesPanel({
  session,
  sources,
}: {
  readonly session: Session;
  readonly sources: LessonSources;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const view = sources.library.view;
  const attached = session.sources.map((s) => s.sourceId);
  const ready = view.status === 'ready' ? view.sources.filter((s) => s.state === 'ready') : [];
  const rows = [
    ...ready.map((s) => ({ sourceId: s.sourceId, title: s.title, kind: s.kind })),
    ...session.sources.filter((s) => !ready.some((r) => r.sourceId === s.sourceId)),
  ];

  const change = async (next: string[]) => {
    setError(undefined);
    try {
      await sources.set({
        attach: next.filter((id) => !attached.includes(id)),
        detach: attached.filter((id) => !next.includes(id)),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <VStack gap={3} data-testid="lesson-sources">
      <Heading level={3}>{m.lesson_sources_title()}</Heading>
      <Text type="supporting">{m.lesson_sources_hint()}</Text>
      {error ? <Banner status="error" title={error} /> : null}
      {view.status === 'loading' ? <Spinner size="sm" label={m.learn_loading()} /> : null}
      {view.status === 'error' ? <Banner status="error" title={view.message} /> : null}
      {view.status === 'ready' && rows.length === 0 ? (
        <Text type="supporting">{m.sources_empty_hint()}</Text>
      ) : (
        <CheckboxList
          label={m.lesson_sources_title()}
          isLabelHidden
          value={attached}
          changeAction={change}
        >
          {rows.map((row) => (
            <CheckboxListItem
              key={row.sourceId}
              value={row.sourceId}
              label={row.title}
              description={kindText(row.kind)}
              data-testid="lesson-source"
            />
          ))}
        </CheckboxList>
      )}
    </VStack>
  );
}
