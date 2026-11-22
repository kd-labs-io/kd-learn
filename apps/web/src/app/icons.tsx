import type { SVGProps } from 'react';

// Outline icons for the rail (24 px grid, 1.5 stroke, `currentColor`), so they follow the theme.
// The Astryx semantic set has no home, graph or library glyphs.

type IconProps = SVGProps<SVGSVGElement>;

function Outline({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (props: IconProps) => (
  <Outline {...props}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9v11h5v-6h4v6h5V9" />
  </Outline>
);

export const GraphIcon = (props: IconProps) => (
  <Outline {...props}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <circle cx="9" cy="18" r="2.5" />
    <path d="m8.3 7.1 7.4.8M7 8.4l1.3 7.2M16.4 10l-5.6 6.2" />
  </Outline>
);

export const SourcesIcon = (props: IconProps) => (
  <Outline {...props}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M8 12h8M8 15.5h5" />
  </Outline>
);

export const SettingsIcon = (props: IconProps) => (
  <Outline {...props}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Outline>
);

export const PracticeIcon = (props: IconProps) => (
  <Outline {...props}>
    <path d="M9 4h6M10 4v5l-5 9.5A1 1 0 0 0 5.9 20h12.2a1 1 0 0 0 .9-1.5L14 9V4" />
    <path d="M7.5 14h9" />
  </Outline>
);

export const AccountIcon = (props: IconProps) => (
  <Outline {...props}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Outline>
);

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
