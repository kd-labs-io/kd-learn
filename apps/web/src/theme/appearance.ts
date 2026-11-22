// The appearance of this device (plan theme-va-dien-thoai.md A3): color mode and built-in theme, in
// the `kd_appearance` cookie (`<mode>.<theme>`, e.g. `system.kd`) so the server render and the
// SPA's pre-paint script read the same value as the client and nothing flashes. A display
// preference only, never sensitive.
import { Appearance, defaultAppearance } from '@kd-learn/api';
import { builtInThemeIds } from '@kd-learn/tokens';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';
import { Schema } from 'effect';

export const APPEARANCE_COOKIE = 'kd_appearance';
const ONE_YEAR = 60 * 60 * 24 * 365;

const isAppearance = Schema.is(Appearance);

/** A cookie value to an appearance; anything damaged or unknown is the default. */
export const parseAppearance = (value: string | undefined | null): Appearance => {
  const match = /^([a-z]+)\.([a-z][a-z0-9-]{0,47})$/.exec(value ?? '');
  if (match === null) return defaultAppearance;
  const candidate = { mode: match[1], theme: match[2] };
  if (!isAppearance(candidate)) return defaultAppearance;
  return builtInThemeIds.includes(candidate.theme)
    ? candidate
    : { mode: candidate.mode, theme: defaultAppearance.theme };
};

export const formatAppearance = (appearance: Appearance) =>
  `${appearance.mode}.${appearance.theme}`;

const documentCookie = (): string | undefined => {
  try {
    const match = new RegExp(`(?:^|; )${APPEARANCE_COOKIE}=([^;]*)`).exec(document.cookie);
    return match?.[1];
  } catch {
    return undefined;
  }
};

/** The appearance of this request (server render) or of this document (client). */
export const readAppearance = createIsomorphicFn()
  .server(() => parseAppearance(getCookie(APPEARANCE_COOKIE)))
  .client(() => parseAppearance(documentCookie()));

export const writeAppearanceCookie = (appearance: Appearance) => {
  try {
    document.cookie = `${APPEARANCE_COOKIE}=${formatAppearance(appearance)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax`;
  } catch {
    // Cookies blocked: the choice lasts for this page only.
  }
};

/** `data-theme` on `<html>`: absent for `system`, so CSS follows the OS (Astryx does the same). */
export const htmlThemeAttribute = (appearance: Appearance) =>
  appearance.mode === 'system' ? undefined : appearance.mode;

/**
 * Runs before the first paint (an inline script in `<head>`): the SPA shell is prerendered with the
 * default appearance, so this sets the device's mode and theme before anything shows. Same rules
 * as `parseAppearance`, kept tiny; a theme id the build does not know shows the default colors.
 */
export const prePaintScript = `(function(){try{var m=/(?:^|; )${APPEARANCE_COOKIE}=(system|light|dark)\\.([a-z][a-z0-9-]{0,47})(?:;|$)/.exec(document.cookie);if(!m)return;var h=document.documentElement;if(m[1]==='system')h.removeAttribute('data-theme');else h.setAttribute('data-theme',m[1]);h.setAttribute('data-kd-theme',m[2]);}catch(e){}})();`;
