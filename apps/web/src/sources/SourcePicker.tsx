// Sources for a new lesson (phase 4 A2): ready sources to attach in the creating batch, and a web
// research on the topic, attached when it is ready.
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { Switch } from '@astryxdesign/core/Switch';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import type { SourceLibrary } from './library';
import { kindText } from './SourcesScreen';

export interface PickedSources {
  readonly sourceIds: ReadonlyArray<string>;
  readonly research: boolean;
}

export const noSources: PickedSources = { sourceIds: [], research: false };

export function SourcePicker({
  library,
  value,
  onChange,
}: {
  readonly library: SourceLibrary;
  readonly value: PickedSources;
  readonly onChange: (next: PickedSources) => void;
}) {
  const ready =
    library.view.status === 'ready' ? library.view.sources.filter((s) => s.state === 'ready') : [];
  return (
    <VStack gap={2}>
      {ready.length === 0 ? null : (
        <CheckboxList
          label={m.home_sources()}
          value={[...value.sourceIds]}
          onChange={(sourceIds) => onChange({ ...value, sourceIds: sourceIds.slice(0, 20) })}
          density="compact"
          data-testid="home-sources"
        >
          {ready.map((s) => (
            <CheckboxListItem
              key={s.sourceId}
              value={s.sourceId}
              label={s.title}
              description={kindText(s.kind)}
              data-testid="home-source"
            />
          ))}
        </CheckboxList>
      )}
      {library.providers.length === 0 ? null : (
        <Switch
          label={m.home_research()}
          description={m.home_research_hint()}
          value={value.research}
          onChange={(research) => onChange({ ...value, research })}
          data-testid="home-research"
        />
      )}
    </VStack>
  );
}
