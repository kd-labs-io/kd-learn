import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import viVN from '@astryxdesign/core/locales/vi-VN.generated.js';
import { getLocale, getLocaleTag } from '@kd-learn/i18n';
import { useEffect, type ReactNode } from 'react';

/**
 * Astryx translates its own component strings; Paraglide (`m.*`) translates
 * ours. Both read the same locale. Changing it with `setLocale()` reloads the
 * document, so the locale is fixed for the lifetime of a render tree.
 */
export function I18nRoot({ children }: { children: ReactNode }) {
  // The SPA shell is prerendered in the base locale and React keeps the server
  // value of <html lang> on hydration, so set it on the client.
  useEffect(() => {
    document.documentElement.lang = getLocale();
  }, []);

  return (
    <InternationalizationProvider locale={getLocaleTag()} messages={{ 'vi-VN': viVN }}>
      {children}
    </InternationalizationProvider>
  );
}
