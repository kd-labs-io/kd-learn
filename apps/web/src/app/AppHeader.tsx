import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { LayoutHeader } from '@astryxdesign/core/Layout';
import { VStack } from '@astryxdesign/core/VStack';
import { accountClient } from '@kd-learn/api';
import { getLocale, locales, m, setLocale } from '@kd-learn/i18n';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { clientOptions, run, usePublicConfig } from '../account/api';
import { chooseLocalMode, signOut, useWho } from '../account/auth';
import { guestOnly, localModeOf } from './modes';

type Target = '/' | '/settings' | '/admin' | '/login' | '/graph' | '/sources';

/**
 * Header of the screens that are not a lesson (plan cai-thien-ux.md B1): brand and the main places
 * on the left, with the current one marked; who is using it, the language and the account actions
 * in one menu on the right. On a phone the places wrap under the brand: two rows, not three.
 */
export function AppHeader() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const current = useWho();
  const config = usePublicConfig().data ?? guestOnly;
  const go = (to: Target) => void navigate({ to });
  const wide = useMediaQuery('(min-width: 900px)');

  const mode = current.status === 'local' ? localModeOf(current, config) : undefined;
  const signedIn = current.status === 'signed-in';
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

  const places: Array<{ to: Target; label: string; testId: string }> = [
    { to: '/', label: m.nav_home(), testId: 'nav-home' },
    ...(signedIn || mode !== undefined
      ? [
          { to: '/graph' as const, label: m.nav_graph(), testId: 'nav-graph' },
          { to: '/sources' as const, label: m.nav_sources(), testId: 'nav-sources' },
        ]
      : []),
    ...(mode === 'demo'
      ? []
      : [{ to: '/settings' as const, label: m.nav_settings(), testId: 'nav-settings' }]),
  ];
  const isCurrent = (to: Target) => (to === '/' ? path === '/' : path.startsWith(to));

  const who =
    current.status === 'signed-in'
      ? current.user.email
      : mode === 'demo'
        ? m.mode_demo()
        : mode === 'guest'
          ? m.mode_guest()
          : m.account_menu();

  const items: Array<DropdownMenuOption> = [
    {
      type: 'section',
      title: m.locale_label(),
      items: locales.map((locale) => ({
        label: locale === 'vi' ? 'Tiếng Việt' : 'English',
        onClick: () => setLocale(locale),
        endContent: locale === getLocale() ? '✓' : undefined,
      })),
    },
    { type: 'divider' },
    ...(current.status === 'signed-in' && current.user.role === 'admin'
      ? [{ label: m.nav_admin(), onClick: () => go('/admin') }]
      : []),
    ...(canSwitch
      ? [
          {
            label: m.mode_switch(),
            onClick: () => {
              chooseLocalMode(undefined);
              go('/');
            },
          },
        ]
      : []),
    ...(current.status === 'local' && config.accounts && !canSwitch
      ? [{ label: m.auth_login(), onClick: () => go('/login') }]
      : []),
    ...(signedIn
      ? [{ label: m.auth_logout(), onClick: () => void logout(), variant: 'destructive' as const }]
      : []),
  ];

  const brand = (
    <Button label={m.app_name()} variant="ghost" onClick={() => go('/')} data-testid="nav-brand">
      <Heading level={3} accessibilityLevel={1} display="inline">
        {m.app_name()}
      </Heading>
    </Button>
  );
  const nav = (
    <HStack gap={1} vAlign="center" wrap="wrap" as="nav" aria-label={m.app_name()}>
      {places.map((place) => (
        <Button
          key={place.to}
          label={place.label}
          variant={isCurrent(place.to) ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => go(place.to)}
          aria-current={isCurrent(place.to) ? 'page' : undefined}
          data-testid={place.testId}
        />
      ))}
    </HStack>
  );
  const menu = (
    <DropdownMenu
      alignment="end"
      presentation="adaptive"
      renderTrigger={(trigger) => (
        <Button {...trigger} label={who} variant="ghost" size="sm" data-testid="who" />
      )}
      items={items}
    />
  );

  return (
    <LayoutHeader hasDivider padding={3} label={m.app_name()}>
      {wide ? (
        <HStack gap={4} vAlign="center" justify="between">
          <HStack gap={4} vAlign="center">
            {brand}
            {nav}
          </HStack>
          {menu}
        </HStack>
      ) : (
        // A phone: brand and menu on one row, the places on the next.
        <VStack gap={2}>
          <HStack gap={2} vAlign="center" justify="between">
            {brand}
            {menu}
          </HStack>
          {nav}
        </VStack>
      )}
    </LayoutHeader>
  );
}
