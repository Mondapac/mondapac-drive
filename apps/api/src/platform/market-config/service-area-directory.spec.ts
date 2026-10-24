import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
  testMarketId,
} from '../../../test/support/test-config';
import { InvalidServiceAreaConfigError, loadServiceAreas } from './service-area-config';

const AU = testMarketId('AU');
const ZZ = testMarketId('ZZ');
const QQ = testMarketId('QQ');

function directoryWith(files: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'areas-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      path.join(directory, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return directory;
}

const area = (code: string, postcodes: string[], open = true) => ({
  code,
  postcodes,
  deliveryEnabled: open,
});

describe('ServiceAreaDirectory', () => {
  const directory = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);

  it('finds the launch area of the launch market, closed until the owner opens it', () => {
    // Only the code is pinned: the flags are the owner's to change in the file.
    expect(directory.areaFor(AU, '4000')?.code).toBe('greater-brisbane');
    expect(directory.areaFor(AU, ' 4179 ')?.code).toBe('greater-brisbane');
  });

  it('matches every AU range inclusively and nothing in the gaps', () => {
    for (const hit of ['4000', '4179', '4205', '4207', '4300', '4306', '4500', '4521']) {
      expect(directory.areaFor(AU, hit)?.code).toBe('greater-brisbane');
    }
    for (const miss of ['3999', '4180', '4204', '4208', '4299', '4307', '4499', '4522']) {
      expect(directory.areaFor(AU, miss)).toBeUndefined();
    }
  });

  it('matches the ZZ range edges and keeps leading zeros significant', () => {
    expect(directory.areaFor(ZZ, '1000001')?.code).toBe('zz-central');
    expect(directory.areaFor(ZZ, '1000002')?.code).toBe('zz-central');
    expect(directory.areaFor(ZZ, '1000000')).toBeUndefined();
    expect(directory.areaFor(ZZ, '1000003')).toBeUndefined();
    expect(directory.areaFor(ZZ, '2000000')?.code).toBe('zz-coast');
    expect(directory.areaFor(ZZ, '2000999')?.code).toBe('zz-coast');
    expect(directory.areaFor(ZZ, '2001000')).toBeUndefined();
  });

  it('answers none for input that only folds to a match, or is not text', () => {
    expect(directory.areaFor(ZZ, 'zz1 9aa')?.code).toBe('zz-central');
    expect(directory.areaFor(ZZ, 'ZZ1 9ÄA')).toBeUndefined();
    expect(directory.areaFor(ZZ, '٤٠٠٠')).toBeUndefined();
    expect(directory.areaFor(AU, undefined as unknown as string)).toBeUndefined();
  });

  it('hands out copies, so a caller cannot change a later answer', () => {
    const first = directory.areaFor(ZZ, '1000001') as { code: string };
    first.code = 'changed';
    (directory.areasOf(ZZ) as unknown as { code: string }[]).pop();
    expect(directory.areaFor(ZZ, '1000001')?.code).toBe('zz-central');
    expect(directory.areasOf(ZZ)).toHaveLength(2);
  });

  it('answers none for a postcode no area lists', () => {
    expect(directory.areaFor(AU, '2000')).toBeUndefined();
    expect(directory.areaFor(AU, '')).toBeUndefined();
    expect(directory.areaFor(AU, '4180')).toBeUndefined();
  });

  it('works for the synthetic market: long digits, letters, closed areas', () => {
    expect(directory.areaFor(ZZ, '1000001')).toEqual({ code: 'zz-central', deliveryEnabled: true });
    expect(directory.areaFor(ZZ, 'zz1 9aa')?.code).toBe('zz-central');
    expect(directory.areaFor(ZZ, '2000500')).toEqual({ code: 'zz-coast', deliveryEnabled: false });
  });

  it('never matches across markets or lengths', () => {
    expect(directory.areaFor(ZZ, '4000')).toBeUndefined();
    expect(directory.areaFor(AU, '1000001')).toBeUndefined();
    expect(directory.areaFor(AU, '04000')).toBeUndefined();
    expect(directory.areaFor(QQ, '4000')).toBeUndefined();
  });

  it('lists the areas of a market', () => {
    expect(directory.areasOf(ZZ).map((a) => a.code)).toEqual(['zz-central', 'zz-coast']);
    expect(directory.areasOf(QQ)).toEqual([]);
  });
});

describe('loadServiceAreas', () => {
  it('requires a file for every hosted market', () => {
    const dir = directoryWith({});
    expect(() => loadServiceAreas([dir], [AU])).toThrow(/no service-area file/);
  });

  it('rejects invalid JSON, unknown keys, a wrong market and a bad code', () => {
    expect(() => loadServiceAreas([directoryWith({ 'AU.json': '{' })], [AU])).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      loadServiceAreas([directoryWith({ 'AU.json': { market: 'AU', areas: [], extra: 1 } })], [AU]),
    ).toThrow(InvalidServiceAreaConfigError);
    expect(() =>
      loadServiceAreas([directoryWith({ 'AU.json': { market: 'ZZ', areas: [] } })], [AU]),
    ).toThrow(/must match the file name/);
    expect(() =>
      loadServiceAreas(
        [directoryWith({ 'AU.json': { market: 'AU', areas: [area('Bad Code', ['4000'])] } })],
        [AU],
      ),
    ).toThrow(/code/);
  });

  it('rejects a range with ends of different length or in the wrong order, and junk', () => {
    for (const bad of ['400-4179', '4179-4000', '40 00!', '12345678901234']) {
      expect(() =>
        loadServiceAreas(
          [directoryWith({ 'AU.json': { market: 'AU', areas: [area('a', [bad])] } })],
          [AU],
        ),
      ).toThrow(InvalidServiceAreaConfigError);
    }
  });

  it('explains that a hyphenated postcode is not an exact entry', () => {
    expect(() =>
      loadServiceAreas(
        [directoryWith({ 'AU.json': { market: 'AU', areas: [area('a', ['100-0001'])] } })],
        [AU],
      ),
    ).toThrow(/hyphenated postcode cannot be listed/);
  });

  it('reports an unreadable directory or file as a configuration error', () => {
    expect(() => loadServiceAreas(['/nonexistent/areas'], [AU])).toThrow(
      InvalidServiceAreaConfigError,
    );
    const dir = directoryWith({});
    mkdirSync(path.join(dir, 'AU.json'));
    expect(() => loadServiceAreas([dir], [AU])).toThrow(/cannot be read/);
  });

  it('rejects overlaps between areas in every shape', () => {
    const clash = (a: string[], b: string[]) =>
      loadServiceAreas(
        [directoryWith({ 'AU.json': { market: 'AU', areas: [area('a', a), area('b', b)] } })],
        [AU],
      );
    expect(() => clash(['4000-4100'], ['4050-4200'])).toThrow(/shares a postcode/);
    expect(() => clash(['4000-4100'], ['4050'])).toThrow(/shares a postcode/);
    expect(() => clash(['4000-4100'], ['4100-4200'])).toThrow(/shares a postcode/);
    expect(() => clash(['4000-4099'], ['4100-4200'])).not.toThrow();
    expect(() => clash(['0400-0499'], ['400-499'])).not.toThrow();
  });

  it('rejects a duplicate code and a postcode two areas claim', () => {
    expect(() =>
      loadServiceAreas(
        [
          directoryWith({
            'AU.json': { market: 'AU', areas: [area('a', ['4000']), area('a', ['4001'])] },
          }),
        ],
        [AU],
      ),
    ).toThrow(/twice/);
    expect(() =>
      loadServiceAreas(
        [
          directoryWith({
            'AU.json': { market: 'AU', areas: [area('a', ['4000-4100']), area('b', ['4100'])] },
          }),
        ],
        [AU],
      ),
    ).toThrow(/shares a postcode/);
    expect(() =>
      loadServiceAreas(
        [
          directoryWith({
            'AU.json': { market: 'AU', areas: [area('a', ['AB1']), area('b', ['ab 1'])] },
          }),
        ],
        [AU],
      ),
    ).toThrow(/shares a postcode/);
  });

  it('refuses one market configured in two directories', () => {
    const a = directoryWith({ 'AU.json': { market: 'AU', areas: [] } });
    const b = directoryWith({ 'AU.json': { market: 'AU', areas: [] } });
    expect(() => loadServiceAreas([a, b], [AU])).toThrow(/twice/);
  });

  it('ignores files of markets that are not hosted', () => {
    const dir = directoryWith({ 'AU.json': { market: 'AU', areas: [] }, 'ZZ.json': '{' });
    expect(() => loadServiceAreas([dir], [AU])).not.toThrow();
  });
});
