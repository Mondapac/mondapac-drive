import { getLocales } from 'expo-localization';
import en from './en.json';
import { pickLocale, type LocaleDefinition } from './locales';

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** A key of the translation file, such as `job.pickedUp`. */
export type TranslationKey = Leaves<typeof en>;

type Params = Readonly<Record<string, string | number>>;

/**
 * The language is the device's, read once at start (changing the phone's language restarts
 * the app on both platforms). English when the app does not have the device's language.
 */
let active: LocaleDefinition = pickLocale(deviceLocales(), { allowPseudo: __DEV__ });

function deviceLocales() {
  try {
    return getLocales();
  } catch {
    return [];
  }
}

/** The language the app shows. */
export function currentLocale(): LocaleDefinition {
  return active;
}

/** Switches the language: tests, and the pseudo-locale check. */
export function setLocaleForTesting(locale: LocaleDefinition): void {
  active = locale;
}

/**
 * The copy for a key, with `{{name}}` placeholders filled in. A key the active language does
 * not have yet falls back to English.
 */
export function t(key: TranslationKey, params: Params = {}): string {
  const text = lookup(active.messages, key) ?? lookup(en, key);
  if (text === undefined) return key;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

function lookup(messages: unknown, key: string): string | undefined {
  let node = messages;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}
