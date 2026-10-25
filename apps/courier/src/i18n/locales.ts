import en from './en.json';
import { pseudoMessages } from './pseudo';

/** The shape every language file follows: the English file's keys. */
export type Messages = typeof en;

export interface LocaleDefinition {
  /** BCP 47 language code the device reports, such as `en` or `ar`. */
  readonly code: string;
  readonly direction: 'ltr' | 'rtl';
  /** May leave keys out while a translation is in progress: English fills them. */
  readonly messages: DeepPartial<Messages>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

export const FALLBACK_LOCALE = 'en';

/**
 * The app's languages. A new one is a JSON file next to en.json and one entry here; the
 * locales test checks it has no key English lacks and keeps every `{{placeholder}}`.
 */
export const LOCALES: readonly LocaleDefinition[] = [
  { code: FALLBACK_LOCALE, direction: 'ltr', messages: en },
];

/**
 * Pseudo-English, for finding copy that does not come from the translation files: every
 * message is accented and bracketed (`⟦Ĝö öñļîñé⟧`), so anything plain on screen is
 * hard-coded. Android offers it as the "English (XA)" developer locale; development builds
 * pick it up from there.
 */
export const PSEUDO_LOCALE: LocaleDefinition = {
  code: 'en-XA',
  direction: 'ltr',
  messages: pseudoMessages(en),
};

/** The device's preferred language tags, best first. */
export interface DeviceLocale {
  readonly languageTag: string;
  readonly languageCode: string | null;
}

/**
 * The first of the device's languages the app has, by language code (`ar-AU` takes `ar`);
 * English when it has none of them. The pseudo-locale only when allowed (development).
 */
export function pickLocale(
  device: readonly DeviceLocale[],
  options: { allowPseudo: boolean } = { allowPseudo: false },
): LocaleDefinition {
  for (const preferred of device) {
    if (options.allowPseudo && preferred.languageTag === PSEUDO_LOCALE.code) return PSEUDO_LOCALE;
    const code = (
      preferred.languageCode ??
      preferred.languageTag.split('-')[0] ??
      ''
    ).toLowerCase();
    const match = LOCALES.find((locale) => locale.code === code);
    if (match) return match;
  }
  return fallbackLocale();
}

export function fallbackLocale(): LocaleDefinition {
  return LOCALES.find((locale) => locale.code === FALLBACK_LOCALE)!;
}
