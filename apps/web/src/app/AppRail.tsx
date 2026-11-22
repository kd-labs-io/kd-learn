import { Divider } from '@astryxdesign/core/Divider';
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { VStack } from '@astryxdesign/core/VStack';
import { accountClient } from '@kd-learn/api';
import { getLocale, locales, m, setLocale } from '@kd-learn/i18n';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  type SVGProps,
} from 'react';
import { createPortal } from 'react-dom';
import { clientOptions, run, usePublicConfig } from '../account/api';
import { chooseLocalMode, signOut, useWho } from '../account/auth';
import {
  AccountIcon,
  AdminIcon,
  GraphIcon,
  HomeIcon,
  LanguageIcon,
  LoginIcon,
  LogoMark,
  LogoutIcon,
  SettingsIcon,
  SourcesIcon,
  SwitchIcon,
} from './icons';
import { guestOnly, localModeOf } from './modes';

type Target = '/' | '/settings' | '/admin' | '/login' | '/graph' | '/sources';

interface RailSlotState {
  readonly target: HTMLElement | null;
  readonly setTarget: (element: HTMLElement | null) => void;
}

/** Where a screen puts its own part of the rail (the lesson's plan), under the places. */
const RailSlotContext = createContext<RailSlotState>({ target: null, setTarget: () => undefined });

/** Shows `children` in the left rail, under the places, while the calling screen is shown. */
export function RailSlot({ children }: { children: ReactNode }) {
  const { target } = useContext(RailSlotContext);
  return target === null ? null : createPortal(children, target);
}

/** Holds the rail's slot, so a screen inside AppShell can fill a part of the rail beside it. */
export function RailSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return <RailSlotContext value={{ target, setTarget }}>{children}</RailSlotContext>;
}

/**
 * The left rail of every screen (replaces the top header): the logo, the main places with the
 * current one marked, a slot for the screen's own part (the lesson's plan), and the account menu at
 * the bottom (who is using it, language, admin, mode, sign in or out). On a phone AppShell turns it
 * into a top bar with the logo and a menu button that opens the rail as a drawer.
 */
export function AppRail() {
  const { setTarget } = useContext(RailSlotContext);
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const current = useWho();
  const config = usePublicConfig().data ?? guestOnly;
  const go = (to: Target) => void navigate({ to });

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

  type Place = {
    to: Target;
    label: string;
    testId: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
  };
  const places: Array<Place> = [
    { to: '/', label: m.nav_home(), testId: 'nav-home', icon: HomeIcon },
    ...(signedIn || mode !== undefined
      ? [
          { to: '/graph' as const, label: m.nav_graph(), testId: 'nav-graph', icon: GraphIcon },
          {
            to: '/sources' as const,
            label: m.nav_sources(),
            testId: 'nav-sources',
            icon: SourcesIcon,
          },
        ]
      : []),
  ];
  // A lesson (/s/…, /a/…) belongs to "Sessions".
  const isCurrent = (to: Target) =>
    to === '/'
      ? path === '/' || path.startsWith('/s/') || path.startsWith('/a/')
      : path.startsWith(to);
  const follow = (to: Target) => (event: MouseEvent) => {
    event.preventDefault();
    go(to);
  };

  const who =
    current.status === 'signed-in'
      ? current.user.email
      : mode === 'demo'
        ? m.mode_demo()
        : mode === 'guest'
          ? m.mode_guest()
          : m.account_menu();

  // Settings lives in the account menu (not shown in demo mode, which has nothing to set).
  const items: Array<DropdownMenuOption> = [
    ...(mode === 'demo'
      ? []
      : [{ label: m.nav_settings(), icon: SettingsIcon, onClick: () => go('/settings') }]),
    {
      label: m.locale_label(),
      icon: LanguageIcon,
      items: locales.map((locale) => ({
        label: locale === 'vi' ? 'Tiếng Việt' : 'English',
        onClick: () => setLocale(locale),
        endContent: locale === getLocale() ? '✓' : undefined,
      })),
    },
    { type: 'divider' },
    ...(current.status === 'signed-in' && current.user.role === 'admin'
      ? [{ label: m.nav_admin(), icon: AdminIcon, onClick: () => go('/admin') }]
      : []),
    ...(canSwitch
      ? [
          {
            label: m.mode_switch(),
            icon: SwitchIcon,
            onClick: () => {
              chooseLocalMode(undefined);
              go('/');
            },
          },
        ]
      : []),
    ...(current.status === 'local' && config.accounts && !canSwitch
      ? [{ label: m.auth_login(), icon: LoginIcon, onClick: () => go('/login') }]
      : []),
    ...(signedIn
      ? [
          {
            label: m.auth_logout(),
            icon: LogoutIcon,
            onClick: () => void logout(),
            variant: 'destructive' as const,
          },
        ]
      : []),
  ];

  return (
    <SideNav
      aria-label={m.rail_label()}
      header={
        <SideNavHeading
          heading={m.app_name()}
          headingHref="/"
          icon={<Icon icon={LogoMark} color="accent" size="lg" />}
          data-testid="nav-brand"
        />
      }
      footer={
        <VStack gap={2}>
          <Divider isFullBleed />
          <HStack hAlign="start">
            <DropdownMenu
              alignment="start"
              presentation="adaptive"
              renderTrigger={(trigger) => (
                <SideNavItem
                  {...trigger}
                  // SideNavItem types its click with Element; the trigger only reads the event.
                  onClick={(event) => trigger.onClick(event as MouseEvent<HTMLElement>)}
                  label={who}
                  icon={AccountIcon}
                  data-testid="who"
                />
              )}
              items={items}
            />
          </HStack>
        </VStack>
      }
    >
      <SideNavSection title={m.rail_places()} isHeaderHidden>
        {places.map((place) => (
          <SideNavItem
            key={place.to}
            label={place.label}
            icon={place.icon}
            href={place.to}
            onClick={follow(place.to)}
            isSelected={isCurrent(place.to)}
            data-testid={place.testId}
          />
        ))}
      </SideNavSection>
      <VStack ref={setTarget} />
    </SideNav>
  );
}
