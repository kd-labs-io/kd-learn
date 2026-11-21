import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { LayoutHeader } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { accountClient } from '@kd-learn/api';
import { getLocale, locales, m, setLocale } from '@kd-learn/i18n';
import { useNavigate } from '@tanstack/react-router';
import { clientOptions, run, usePublicConfig } from '../account/api';
import { chooseLocalMode, signOut, useWho } from '../account/auth';
import { guestOnly, localModeOf } from './modes';

/** Header of the screens that are not a lesson: brand, navigation, who is using it, language. */
export function AppHeader() {
  const navigate = useNavigate();
  const current = useWho();
  const config = usePublicConfig().data ?? guestOnly;
  const go = (to: '/' | '/settings' | '/admin' | '/login') => void navigate({ to });

  const mode = current.status === 'local' ? localModeOf(current, config) : undefined;
  // Another mode to switch to: the chooser only makes sense when the server offers more than one.
  const canSwitch =
    current.status === 'local' &&
    current.mode !== undefined &&
    [config.accounts, config.guestMode, config.demoMode].filter(Boolean).length > 1;

  const logout = async () => {
    if (current.status === 'signed-in') {
      // Revoke the token on the server; signing out locally does not wait for it.
      void run(accountClient(clientOptions(current.token)).logout()).catch(() => undefined);
    }
    signOut();
    go('/');
  };

  return (
    <LayoutHeader hasDivider padding={3} label={m.app_name()}>
      <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
        <Button
          label={m.app_name()}
          variant="ghost"
          onClick={() => go('/')}
          data-testid="nav-brand"
        >
          <Heading level={1} display="inline">
            {m.app_name()}
          </Heading>
        </Button>
        <HStack gap={2} vAlign="center" wrap="wrap">
          {current.status === 'signed-in' ? (
            <Text type="supporting" maxLines={1} data-testid="who">
              {current.user.email}
            </Text>
          ) : mode === 'demo' ? (
            <Text type="supporting" data-testid="who">
              {m.mode_demo()}
            </Text>
          ) : null}
          <Button
            label={m.nav_home()}
            variant="ghost"
            size="sm"
            onClick={() => go('/')}
            data-testid="nav-home"
          />
          {mode === 'demo' ? null : (
            <Button
              label={m.nav_settings()}
              variant="ghost"
              size="sm"
              onClick={() => go('/settings')}
              data-testid="nav-settings"
            />
          )}
          {current.status === 'signed-in' && current.user.role === 'admin' ? (
            <Button
              label={m.nav_admin()}
              variant="ghost"
              size="sm"
              onClick={() => go('/admin')}
              data-testid="nav-admin"
            />
          ) : null}
          {current.status === 'signed-in' ? (
            <Button
              label={m.auth_logout()}
              variant="ghost"
              size="sm"
              onClick={() => void logout()}
              data-testid="nav-logout"
            />
          ) : null}
          {current.status === 'local' && config.accounts && !canSwitch ? (
            <Button
              label={m.auth_login()}
              variant="ghost"
              size="sm"
              onClick={() => go('/login')}
              data-testid="nav-login"
            />
          ) : null}
          {canSwitch ? (
            <Button
              label={m.mode_switch()}
              variant="ghost"
              size="sm"
              onClick={() => {
                chooseLocalMode(undefined);
                go('/');
              }}
              data-testid="nav-mode"
            />
          ) : null}
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
