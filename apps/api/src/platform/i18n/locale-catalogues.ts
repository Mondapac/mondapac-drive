import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** One module's translations in one locale: message key to text. */
export type Messages = Readonly<Record<string, string>>;

/** A catalogue directory or file that cannot be used: the boot stops (as for Market config). */
export class InvalidLocaleCatalogueError extends Error {
  override readonly name = 'InvalidLocaleCatalogueError';
}

const MODULE_FILE = /^([a-z][a-z0-9-]*)\.json$/;
const MESSAGE_KEY = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
/** Text a catalogue never holds: control and format characters other than the line feed. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;

/**
 * The translation catalogues of the application (INTL-11; identity design 9): text is data in
 * configuration, keyed by locale, never a literal in core code. The layout of each directory is
 * `<locale>/<module>.json`, a flat JSON object of message keys, each starting with the module's
 * name, to non-empty text. A locale directory is named by its canonical BCP 47 tag. A locale and
 * module found in two directories is refused, as a Market configured twice is. Which locale a
 * text is shown in is the caller's decision (the Market's default locale, for mail).
 */
export class LocaleCatalogues {
  readonly #byLocale: ReadonlyMap<string, ReadonlyMap<string, Messages>>;

  constructor(byLocale: ReadonlyMap<string, ReadonlyMap<string, Messages>>) {
    this.#byLocale = byLocale;
  }

  /** The module's messages in the locale, or null when that catalogue does not exist. */
  messages(module: string, locale: string): Messages | null {
    return this.#byLocale.get(locale)?.get(module) ?? null;
  }

  /** Every locale that has at least one catalogue, sorted. */
  locales(): string[] {
    return [...this.#byLocale.keys()].sort();
  }
}

/** Loads and checks every catalogue under the directories; throws on the first problem. */
export function loadLocaleCatalogues(directories: readonly string[]): LocaleCatalogues {
  const byLocale = new Map<string, Map<string, Messages>>();
  for (const directory of directories) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new InvalidLocaleCatalogueError(`${directory} is not a readable directory`);
    }
    // Files next to the locale directories (a README) are not catalogues.
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const locale = canonicalLocale(entry.name);
      if (locale !== entry.name) {
        throw new InvalidLocaleCatalogueError(
          `${path.join(directory, entry.name)}: a locale directory is named by its canonical BCP 47 tag`,
        );
      }
      const modules = byLocale.get(locale) ?? new Map<string, Messages>();
      byLocale.set(locale, modules);
      for (const name of readdirSync(path.join(directory, locale))) {
        const file = path.join(directory, locale, name);
        const module = MODULE_FILE.exec(name)?.[1];
        if (module === undefined) {
          throw new InvalidLocaleCatalogueError(`${file}: a catalogue is named <module>.json`);
        }
        if (modules.has(module)) {
          throw new InvalidLocaleCatalogueError(
            `The ${module} catalogue of ${locale} is configured more than once`,
          );
        }
        modules.set(module, parseCatalogue(file, module));
      }
    }
  }
  return new LocaleCatalogues(byLocale);
}

function canonicalLocale(name: string): string | null {
  try {
    return Intl.getCanonicalLocales(name)[0] ?? null;
  } catch {
    return null;
  }
}

function parseCatalogue(file: string, module: string): Messages {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new InvalidLocaleCatalogueError(`${file} is not valid JSON`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidLocaleCatalogueError(`${file} must be a JSON object of message keys`);
  }
  const messages: Record<string, string> = {};
  for (const [key, text] of Object.entries(raw)) {
    if (!MESSAGE_KEY.test(key) || !key.startsWith(`${module}.`)) {
      throw new InvalidLocaleCatalogueError(`${file}: "${key}" is not a ${module} message key`);
    }
    if (typeof text !== 'string' || text.trim() === '' || UNSAFE_TEXT.test(text)) {
      throw new InvalidLocaleCatalogueError(
        `${file}: "${key}" must be non-empty text without control or format characters`,
      );
    }
    messages[key] = text;
  }
  return Object.freeze(messages);
}
