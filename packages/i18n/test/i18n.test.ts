import { describe, expect, it } from 'vitest';
import en from '../messages/en.json' with { type: 'json' };
import vi from '../messages/vi.json' with { type: 'json' };
import { baseLocale, isSupportedLocale, locales, m, type Locale } from '../src/index.ts';

const catalogs: Record<Locale, Record<string, string>> = { vi, en };
const catalog = (locale: Locale) => catalogs[locale];

describe('i18n', () => {
  it('vi is the base locale', () => {
    expect(baseLocale).toBe('vi');
    expect(locales).toEqual(['vi', 'en']);
  });

  it('every locale has the same keys', () => {
    const keys = Object.keys(catalog('vi')).sort();
    for (const locale of locales) expect(Object.keys(catalog(locale)).sort()).toEqual(keys);
  });

  it('compiled every message (a missing plugin compiles to nothing)', () => {
    const keys = Object.keys(catalog('vi')).filter((key) => key !== '$schema');
    for (const key of keys) expect(m).toHaveProperty(key);
  });

  it('fills parameters per locale', () => {
    expect(m.theme_invalid({ reason: 'x' }, { locale: 'vi' })).toBe('Theme không hợp lệ: x');
    expect(m.theme_invalid({ reason: 'x' }, { locale: 'en' })).toBe('This theme is not valid: x');
  });

  it('checks locales', () => {
    expect(isSupportedLocale('vi')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
  });
});
