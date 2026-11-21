import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { LayoutHeader } from '@astryxdesign/core/Layout';
import { getLocale, locales, m, setLocale } from '@kd-learn/i18n';
import { useNavigate } from '@tanstack/react-router';

/** Header of the screens that are not a lesson: brand, navigation and the UI language. */
export function AppHeader() {
  const navigate = useNavigate();
  return (
    <LayoutHeader hasDivider padding={3} label={m.app_name()}>
      <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
        <Button
          label={m.app_name()}
          variant="ghost"
          onClick={() => void navigate({ to: '/' })}
          data-testid="nav-brand"
        >
          <Heading level={1} display="inline">
            {m.app_name()}
          </Heading>
        </Button>
        <HStack gap={2} vAlign="center">
          <Button
            label={m.nav_home()}
            variant="ghost"
            size="sm"
            onClick={() => void navigate({ to: '/' })}
          />
          <Button
            label={m.nav_settings()}
            variant="ghost"
            size="sm"
            onClick={() => void navigate({ to: '/settings' })}
            data-testid="nav-settings"
          />
          {locales.map((locale) => (
            <Button
              key={locale}
              size="sm"
              label={locale.toUpperCase()}
              tooltip={m.locale_label()}
              variant={locale === getLocale() ? 'primary' : 'ghost'}
              onClick={() => setLocale(locale)}
            />
          ))}
        </HStack>
      </HStack>
    </LayoutHeader>
  );
}
