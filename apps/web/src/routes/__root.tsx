/// <reference types="vite/client" />
import { AppShell } from '@astryxdesign/core/AppShell';
import type { QueryClient } from '@tanstack/react-query';
import {
  ClientOnly,
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { getLocale } from '@kd-learn/i18n';
import '../styles/app.css';
import { I18nRoot } from '../i18n/I18nRoot';
import { builtInThemeCss } from '@kd-learn/tokens';
import { htmlThemeAttribute, prePaintScript, readAppearance } from '../theme/appearance';
import { ThemeRoot } from '../theme/ThemeRoot';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'kd-learn' },
    ],
    // Dev only: Start renders its own HTML, so the StyleX Vite plugin cannot add
    // its dev stylesheet. Production builds put StyleX CSS in the main bundle.
    links: import.meta.env.DEV ? [{ rel: 'stylesheet', href: '/virtual:stylex.css' }] : [],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});

function RootComponent() {
  // Fills the viewport; each screen is a Layout inside it, so the lesson scrolls in its own region.
  const app = (
    <I18nRoot>
      <ThemeRoot>
        <AppShell>
          <Outlet />
        </AppShell>
      </ThemeRoot>
    </I18nRoot>
  );
  // The SPA shell is prerendered in the base locale (Astryx strings such as the skip link
  // included), but the client may prefer another one, so its first render would not match the HTML
  // (React error #418, seen on WebKit in steps 1 and 6). The screens only show local data anyway:
  // in the SPA build they render after mount. The SSR build renders on the server in the request's
  // locale.
  return import.meta.env['VITE_KD_SPA'] ? <ClientOnly fallback={null}>{app}</ClientOnly> : app;
}

function RootDocument({ children }: { children: ReactNode }) {
  // Mode and theme come from the `kd_appearance` cookie (plan theme-va-dien-thoai.md A3), so the
  // server render has no flash. The SPA shell is prerendered with the default appearance and the
  // base locale, so `data-theme`, `data-kd-theme` and `lang` may change on hydration; the pre-paint
  // script sets the first two before anything shows.
  const appearance = readAppearance();
  return (
    <html
      lang={getLocale()}
      data-theme={htmlThemeAttribute(appearance)}
      data-kd-theme={appearance.theme}
      data-astryx-theme="kd"
      suppressHydrationWarning
    >
      <head>
        {/*
          Fix the cascade layer order before any stylesheet loads (in dev the StyleX
          sheet may come first). React hoists stylesheets by precedence group, in the
          order groups are first seen, so this group must render before <HeadContent>.
        */}
        {/*
          Demo frames (srcdoc, plan hinh-va-demo.md A2) may not navigate themselves anywhere: this
          policy is inherited by srcdoc frames and blocks it in every browser (spike C1, risk 43).
          Only frame-src, so nothing else of the app changes.
        */}
        <meta httpEquiv="Content-Security-Policy" content="frame-src 'self' about:" />
        <style href="kd-layer-order" precedence="kd-layer-order">
          {'@layer reset, astryx-base, astryx-theme, product;'}
        </style>
        <script dangerouslySetInnerHTML={{ __html: prePaintScript }} />
        <style href="kd-themes" precedence="kd-themes">
          {builtInThemeCss}
        </style>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
