import en from '../src/i18n/en.json';
import { setLocaleForTesting, t } from '../src/i18n';
import {
  fallbackLocale,
  LOCALES,
  pickLocale,
  PSEUDO_LOCALE,
  type LocaleDefinition,
} from '../src/i18n/locales';

afterEach(() => setLocaleForTesting(fallbackLocale()));

const device = (...tags: string[]) =>
  tags.map((languageTag) => ({ languageTag, languageCode: languageTag.split('-')[0] ?? null }));

/** A second language, as a translation in progress would look. */
const partial: LocaleDefinition = {
  code: 'zz',
  direction: 'rtl',
  messages: { common: { retry: 'ZZ retry {{n}}' } },
};

function leaves(node: unknown, prefix = ''): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string') found.set(`${prefix}${key}`, value);
    else leaves(value, `${prefix}${key}.`).forEach((text, path) => found.set(path, text));
  }
  return found;
}
const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();

describe('choosing the language', () => {
  it('takes the first device language the app has, by language code', () => {
    expect(pickLocale(device('de-DE', 'en-AU')).code).toBe('en');
  });

  it('falls back to English when the app has none of them', () => {
    expect(pickLocale(device('de-DE', 'ja-JP')).code).toBe('en');
    expect(pickLocale([]).code).toBe('en');
  });

  it('offers pseudo-English only to development builds', () => {
    expect(pickLocale(device('en-XA'), { allowPseudo: true })).toBe(PSEUDO_LOCALE);
    expect(pickLocale(device('en-XA'), { allowPseudo: false }).code).toBe('en');
  });
});

describe('translating', () => {
  it('fills placeholders and falls back to English for a missing key', () => {
    setLocaleForTesting(partial);
    expect(t('common.retry')).toBe('ZZ retry {{n}}');
    expect(t('common.cancel')).toBe(en.common.cancel);
    expect(t('common.error', { message: 'Timeout.' })).toBe('Something went wrong. Timeout.');
  });
});

describe.each(LOCALES.map((locale) => [locale.code, locale] as const))(
  'the %s language file',
  (_code, locale) => {
    const english = leaves(en);
    const translated = leaves(locale.messages);

    it('has no key that English lacks', () => {
      expect([...translated.keys()].filter((key) => !english.has(key))).toEqual([]);
    });

    it('keeps every placeholder of the English copy', () => {
      const broken = [...translated].filter(
        ([key, text]) => placeholders(text).join() !== placeholders(english.get(key) ?? '').join(),
      );
      expect(broken).toEqual([]);
    });

    it('has no empty copy', () => {
      expect([...translated].filter(([, text]) => !text.trim())).toEqual([]);
    });
  },
);
