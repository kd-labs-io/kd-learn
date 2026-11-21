/// <reference types="vite/client" />
import { AppShell } from '@astryxdesign/core/AppShell';
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { getLocale } from '@kd-learn/i18n';
import '../styles/app.css';
import { I18nRoot } from '../i18n/I18nRoot';
import { ThemeRoot } from '../theme/ThemeRoot';

export const Route = createRootRoute({
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
  component: () => (
    <I18nRoot>
      <ThemeRoot>
        {/* Fills the viewport; each screen is a Layout inside it, so the lesson scrolls in its own region. */}
        <AppShell>
          <Outlet />
        </AppShell>
      </ThemeRoot>
    </I18nRoot>
  ),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  // Light only until dark mode lands: set it on <html> so SSR has no mode flash.
  // The SPA shell is prerendered in the base locale, so `lang` may change on hydration.
  return (
    <html lang={getLocale()} data-theme="light" data-astryx-theme="kd" suppressHydrationWarning>
      <head>
        {/*
          Fix the cascade layer order before any stylesheet loads (in dev the StyleX
          sheet may come first). React hoists stylesheets by precedence group, in the
          order groups are first seen, so this group must render before <HeadContent>.
        */}
        <style href="kd-layer-order" precedence="kd-layer-order">
          {'@layer reset, astryx-base, astryx-theme, product;'}
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
