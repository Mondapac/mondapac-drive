import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEST_LOCALE_CONFIG_DIRS } from '../../../test/support/test-config';
import { InvalidLocaleCatalogueError, loadLocaleCatalogues } from './locale-catalogues';

describe('loadLocaleCatalogues (INTL-11; identity design 9)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'locales-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Writes `<root>/<dir>/<locale>/<file>` and answers `<root>/<dir>`. */
  function catalogue(dir: string, locale: string, file: string, content: unknown): string {
    mkdirSync(path.join(root, dir, locale), { recursive: true });
    writeFileSync(
      path.join(root, dir, locale, file),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
    return path.join(root, dir);
  }

  it('loads the checked-in catalogues: the real en-AU and the synthetic ja-JP', () => {
    const catalogues = loadLocaleCatalogues(TEST_LOCALE_CONFIG_DIRS);

    expect(catalogues.locales()).toEqual(['en-AU', 'ja-JP']);
    expect(catalogues.messages('identity', 'en-AU')).toMatchObject({
      'identity.mail.common.ignore': expect.any(String) as unknown,
    });
    expect(catalogues.messages('identity', 'fr-FR')).toBeNull();
    expect(catalogues.messages('catalog', 'en-AU')).toBeNull();
  });

  it('reads `<locale>/<module>.json` from every directory, skipping files beside the locales', () => {
    const first = catalogue('a', 'de-DE', 'shop.json', { 'shop.hello': 'Hallo' });
    const second = catalogue('b', 'de-DE', 'cart.json', { 'cart.empty': 'Leer' });
    writeFileSync(path.join(first, 'README.md'), '# not a catalogue');

    const catalogues = loadLocaleCatalogues([first, second]);

    expect(catalogues.messages('shop', 'de-DE')).toEqual({ 'shop.hello': 'Hallo' });
    expect(catalogues.messages('cart', 'de-DE')).toEqual({ 'cart.empty': 'Leer' });
    expect(Object.isFrozen(catalogues.messages('shop', 'de-DE'))).toBe(true);
  });

  it.each([
    ['a locale directory that is not a canonical tag', 'de-de', 'shop.json', {}, /canonical/],
    ['a file not named <module>.json', 'de-DE', 'Shop.txt', {}, /<module>\.json/],
    ['invalid JSON', 'de-DE', 'shop.json', '{', /not valid JSON/],
    ['an array', 'de-DE', 'shop.json', ['x'], /JSON object/],
    ['a key of another module', 'de-DE', 'shop.json', { 'cart.x': 'y' }, /not a shop message key/],
    ['empty text', 'de-DE', 'shop.json', { 'shop.x': '  ' }, /non-empty text/],
    ['a non-string value', 'de-DE', 'shop.json', { 'shop.x': 3 }, /non-empty text/],
    ['a bidi control character', 'de-DE', 'shop.json', { 'shop.x': 'a\u202Eb' }, /format/],
  ])('refuses %s', (_label, locale, file, content, message) => {
    const dir = catalogue('a', locale, file, content);

    expect(() => loadLocaleCatalogues([dir])).toThrow(InvalidLocaleCatalogueError);
    expect(() => loadLocaleCatalogues([dir])).toThrow(message);
  });

  it('refuses a module catalogue of one locale found in two directories', () => {
    const first = catalogue('a', 'de-DE', 'shop.json', { 'shop.x': 'eins' });
    const second = catalogue('b', 'de-DE', 'shop.json', { 'shop.x': 'zwei' });

    expect(() => loadLocaleCatalogues([first, second])).toThrow(/more than once/);
  });

  it('refuses a directory that does not exist', () => {
    expect(() => loadLocaleCatalogues([path.join(root, 'missing')])).toThrow(
      InvalidLocaleCatalogueError,
    );
  });
});
