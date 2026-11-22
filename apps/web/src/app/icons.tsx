import {
  type Icon as TablerIcon,
  type IconProps as TablerIconProps,
  IconAdjustmentsHorizontal,
  IconAffiliate,
  IconArrowsExchange,
  IconFlask,
  IconFolder,
  IconHome,
  IconLogin2,
  IconLogout2,
  IconShieldCheck,
  IconUser,
  IconWorld,
} from '@tabler/icons-react';
import type { SVGProps } from 'react';

// App icons come from Tabler (https://tabler.io/icons): outline, `currentColor`, so they follow the
// theme. Use them where the Astryx semantic set has no glyph (home, graph, library…). Import icons
// through this file, so the whole app shares one stroke width.

type IconProps = SVGProps<SVGSVGElement>;

const STROKE = 1.5;

function outline(Glyph: TablerIcon) {
  // Astryx `Icon` takes plain SVG props; Tabler's only differ by its optional `size`/`stroke`.
  const Outline = (props: IconProps) => (
    <Glyph stroke={STROKE} aria-hidden="true" {...(props as TablerIconProps)} />
  );
  Outline.displayName = Glyph.displayName;
  return Outline;
}

export const HomeIcon = outline(IconHome);
export const GraphIcon = outline(IconAffiliate);
export const SourcesIcon = outline(IconFolder);
export const SettingsIcon = outline(IconAdjustmentsHorizontal);
export const PracticeIcon = outline(IconFlask);
export const AccountIcon = outline(IconUser);
export const LanguageIcon = outline(IconWorld);
export const LoginIcon = outline(IconLogin2);
export const LogoutIcon = outline(IconLogout2);
export const AdminIcon = outline(IconShieldCheck);
export const SwitchIcon = outline(IconArrowsExchange);

/**
 * The kd-learn mark: an open book whose pages rise into a spark (learning that lights up). Drawn in
 * `currentColor` so the rail paints it with the accent of the active theme.
 */
export const LogoMark = (props: IconProps) => (
  <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
    <path
      d="M16 9.5C13 7.5 8.5 7 5 7.8v15.4c3.5-.8 8-.3 11 1.8 3-2.1 7.5-2.6 11-1.8V7.8C23.5 7 19 7.5 16 9.5Z"
      fill="currentColor"
      fillOpacity={0.16}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
    <path d="M16 9.5V25" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    <path d="M23 2.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" />
  </svg>
);
