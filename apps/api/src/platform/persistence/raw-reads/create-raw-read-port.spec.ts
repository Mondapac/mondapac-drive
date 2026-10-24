import { MODEL_MAP } from '../../../generated/model-map';
import type { PrismaRoot } from '../prisma-root';
import { createRawReadPort } from './create-raw-read-port';
import { parseSql } from './pg-parser';
import type { RawReadEntry } from './statements';

// Sajad F1: the start-up refusal, proven through the function the module's factory calls.
const root = {} as PrismaRoot;
const entry = (sql: string): RawReadEntry => ({
  id: 'delivery.test',
  owner: 'delivery',
  reason: 'test',
  design: 'test',
  sql,
  params: [],
  parseRow: (row) => row,
});
const GOOD = entry('SELECT t.id FROM "delivery"."deliveries" t WHERE t.market_id = $1');

describe('createRawReadPort (ADR-0030 decision 4)', () => {
  it('returns the port for a sound list', async () => {
    await expect(
      createRawReadPort(root, { parse: parseSql, list: [GOOD], map: MODEL_MAP }),
    ).resolves.toBeDefined();
  });

  it('rejects a list with a statement that breaks the rules', async () => {
    await expect(
      createRawReadPort(root, {
        parse: parseSql,
        list: [entry('DELETE FROM "delivery"."delivery_events" WHERE market_id = $1')],
        map: MODEL_MAP,
      }),
    ).rejects.toThrow(/violates ADR-0030.*not-a-select/);
  });

  it('rejects an unparsable entry while the canary parse works', async () => {
    await expect(
      createRawReadPort(root, { parse: parseSql, list: [entry('SELEC 1')], map: MODEL_MAP }),
    ).rejects.toThrow(/parse-failed/);
  });

  it('rejects when the parser throws on an entry but passes the canary', async () => {
    let calls = 0;
    const parse = (sql: string): ReturnType<typeof parseSql> =>
      ++calls === 1 ? parseSql(sql) : Promise.reject(new Error('wasm trap'));
    await expect(createRawReadPort(root, { parse, list: [GOOD], map: MODEL_MAP })).rejects.toThrow(
      /parse-failed/,
    );
  });

  it('rejects when the parser cannot load, even for an empty list', async () => {
    await expect(
      createRawReadPort(root, {
        parse: () => Promise.reject(new Error('not loaded')),
        list: [],
        map: MODEL_MAP,
      }),
    ).rejects.toThrow('not loaded');
  });

  it('rejects an array cap above the ceiling', async () => {
    const big: RawReadEntry = {
      ...GOOD,
      sql: 'SELECT t.id FROM "delivery"."deliveries" t WHERE t.market_id = $1 AND t.code = ANY($2::text[])',
      params: [{ name: 'codes', type: 'text[]', maxLength: 1001 }],
    };
    await expect(
      createRawReadPort(root, { parse: parseSql, list: [big], map: MODEL_MAP }),
    ).rejects.toThrow(/array-cap-too-large/);
  });
});
