// The search source this device uses for research (phase 4 A6), when the server offers more than one.
import { Selector } from '@astryxdesign/core/Selector';
import type { SearchProvider } from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import { useState } from 'react';
import { preferredProvider, savePreferredProvider } from './library';
import { providerText } from './SourcesScreen';

export function SearchPreference({
  providers,
}: {
  readonly providers: ReadonlyArray<SearchProvider>;
}) {
  const [chosen, setChosen] = useState<SearchProvider | undefined>(undefined);
  const value = chosen ?? preferredProvider(providers);
  if (providers.length < 2 || value === undefined) return null;
  return (
    <Selector
      label={m.settings_search()}
      options={providers.map((p) => ({ value: p, label: providerText(p) }))}
      value={value}
      onChange={(next) => {
        setChosen(next as SearchProvider);
        savePreferredProvider(next as SearchProvider);
      }}
      data-testid="settings-search"
    />
  );
}
