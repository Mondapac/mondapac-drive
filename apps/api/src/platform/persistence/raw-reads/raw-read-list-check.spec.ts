import { MODEL_MAP } from '../../../generated/model-map';
import type { ModelMap } from '../model-map';
import { parseSql } from './pg-parser';
import { assertRawReadList, checkRawReadList, ownerOf } from './raw-read-list-check';
import { RAW_READ_STATEMENTS, type RawReadEntry } from './statements';

// The boot re-check of ADR-0030 decision 4 against the real generated model map.

const map: ModelMap = MODEL_MAP;

const entry = (over: Partial<RawReadEntry> = {}): RawReadEntry => ({
  id: 'delivery.issuer-states',
  owner: 'delivery',
  reason: 'one snapshot',
  design: 'delivery design',
  sql: `SELECT i.id FROM "delivery"."delivery_events" i WHERE i.market_id = $1 AND i.type_id = ANY($2::uuid[])`,
  params: [{ name: 'typeIds', type: 'uuid[]', maxLength: 100 }],
  parseRow: (row) => row,
  ...over,
});

describe('raw read list check', () => {
  it('reads the owner schema and the tables of its models from the model map', () => {
    const owner = ownerOf(map, 'delivery');
    if (owner === null) throw new Error('delivery owner missing');
    expect(owner.schema).toBe('delivery');
    expect(owner.tables.has('delivery_events')).toBe(true);
    expect(owner.tables.has('outbox')).toBe(true);
    expect(owner.tables.has('seller_files')).toBe(false);
    expect(ownerOf(map, 'no-such-module')).toBeNull();
  });

  it('passes the checked-in list (empty until a module adds an entry)', async () => {
    await expect(assertRawReadList(parseSql, RAW_READ_STATEMENTS, map)).resolves.toBeUndefined();
  });

  it('passes a sound entry', async () => {
    expect(await checkRawReadList(parseSql, [entry()], map)).toEqual([]);
  });

  it.each([
    [
      'a statement that writes',
      { sql: `INSERT INTO "delivery"."delivery_events" (id) VALUES ($1)` },
      'not-a-select',
    ],
    [
      'a locking clause',
      {
        sql: `SELECT i.id FROM "delivery"."delivery_events" i WHERE i.market_id = $1 FOR UPDATE`,
        params: [],
      },
      'locking-clause',
    ],
    [
      'another module schema',
      { sql: `SELECT s.id FROM "sellers"."seller_files" s WHERE s.market_id = $1`, params: [] },
      'relation-schema:sellers.seller_files',
    ],
    [
      'a function off the allow-list',
      {
        sql: `SELECT nextval('x') FROM "delivery"."delivery_events" i WHERE i.market_id = $1`,
        params: [],
      },
      'function-not-allowed:nextval',
    ],
    [
      'a missing Market predicate',
      { sql: `SELECT i.id FROM "delivery"."delivery_events" i WHERE i.type_id = ANY($2::uuid[])` },
      'market-parameter-missing',
    ],
    ['an id that is not owner.name', { id: 'issuer-states' }, 'id-not-owner-name'],
    ['an id of another owner', { id: 'sellers.issuer-states' }, 'id-not-owner-name'],
    [
      'an array without a cap',
      { params: [{ name: 'typeIds', type: 'uuid[]' as const }] },
      'array-cap-missing',
    ],
    [
      'a scalar with a cap',
      { params: [{ name: 'typeIds', type: 'uuid' as const, maxLength: 3 }] },
      'scalar-with-array-options',
    ],
    ['an unknown owner', { id: 'nobody.thing', owner: 'nobody' }, 'unknown-owner'],
    ['a missing reason', { reason: ' ' }, 'reason-or-design-missing'],
  ])('refuses %s', async (_name, over, code) => {
    const problems = await checkRawReadList(parseSql, [entry(over)], map);
    expect(problems.map((p) => p.split(': ')[1])).toContain(code);
  });

  it('refuses a duplicate id', async () => {
    const problems = await checkRawReadList(parseSql, [entry(), entry()], map);
    expect(problems).toContain('delivery.issuer-states: duplicate-id');
  });

  it('stops the start when the list is bad or the parser cannot load', async () => {
    await expect(
      assertRawReadList(parseSql, [entry({ sql: 'DELETE FROM x' })], map),
    ).rejects.toThrow(/violates ADR-0030/);
    await expect(
      assertRawReadList(() => Promise.reject(new Error('WASM module not initialized')), [], map),
    ).rejects.toThrow(/WASM/);
  });
});
