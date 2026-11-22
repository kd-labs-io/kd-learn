// "Appearance" in settings (plan theme-va-dien-thoai.md A5): color mode and built-in theme, applied
// at once. Guests keep it on the device; a signed-in account also saves it on the server (A3).
import { Heading } from '@astryxdesign/core/Heading';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import type { ColorModeChoice } from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import { builtInThemeIds } from '@kd-learn/tokens';
import { useThemeControl } from './ThemeRoot';
import { Block } from '../app/Block';

const modeLabels: Record<ColorModeChoice, () => string> = {
  system: m.appearance_mode_system,
  light: m.appearance_mode_light,
  dark: m.appearance_mode_dark,
};

const themeLabels: Record<string, { name: () => string; hint: () => string }> = {
  kd: { name: m.appearance_theme_kd, hint: m.appearance_theme_kd_hint },
  'kd-contrast': {
    name: m.appearance_theme_kd_contrast,
    hint: m.appearance_theme_kd_contrast_hint,
  },
  ocean: { name: m.appearance_theme_ocean, hint: m.appearance_theme_ocean_hint },
};

export function AppearanceSettings({ isSynced }: { isSynced: boolean }) {
  const { appearance, setAppearance } = useThemeControl();
  return (
    <Block gap={3} data-testid="appearance">
      <Heading level={3}>{m.appearance_title()}</Heading>
      <Text type="supporting" color="secondary">
        {isSynced ? m.appearance_synced() : m.appearance_device()}
      </Text>
      <Text type="label">{m.appearance_mode()}</Text>
      <SegmentedControl
        label={m.appearance_mode()}
        value={appearance.mode}
        onChange={(mode) => setAppearance({ ...appearance, mode: mode as ColorModeChoice })}
        data-testid="appearance-mode"
      >
        {(['system', 'light', 'dark'] as const).map((mode) => (
          <SegmentedControlItem
            key={mode}
            value={mode}
            label={modeLabels[mode]()}
            data-testid={`appearance-mode-${mode}`}
          />
        ))}
      </SegmentedControl>
      <RadioList
        label={m.appearance_theme()}
        value={appearance.theme}
        onChange={(theme) => setAppearance({ ...appearance, theme })}
        data-testid="appearance-theme"
      >
        {builtInThemeIds.map((id) => (
          <RadioListItem
            key={id}
            value={id}
            label={themeLabels[id]?.name() ?? id}
            description={themeLabels[id]?.hint()}
            data-testid={`appearance-theme-${id}`}
          />
        ))}
      </RadioList>
    </Block>
  );
}
