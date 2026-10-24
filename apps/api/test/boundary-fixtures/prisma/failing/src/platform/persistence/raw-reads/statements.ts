// Deliberate violations of the raw read list (ADR-0030); boundaries.spec.ts expects each one.
import type { RawReadEntry } from './types';

const row = (value: unknown): unknown => value;

export const RAW_READ_STATEMENTS: readonly RawReadEntry[] = [
  {
    id: 'alpha.deletes',
    owner: 'alpha',
    reason: 'fixture',
    design: 'fixture 1',
    sql: 'DELETE FROM alpha."AlphaParent" WHERE market_id = $1',
    params: [],
    parseRow: row,
  },
  {
    id: 'alpha.reads-beta',
    owner: 'alpha',
    reason: 'fixture',
    design: 'fixture 2',
    sql: 'SELECT t.id FROM beta.thing t WHERE t.market_id = $1',
    params: [],
    parseRow: row,
  },
  {
    id: 'alpha.no-market-term',
    owner: 'alpha',
    reason: 'fixture',
    design: 'fixture 3',
    sql: 'SELECT p.id FROM alpha."AlphaParent" p WHERE p.kind = $1',
    params: [{ name: 'kind', type: 'text' }],
    parseRow: row,
  },
  {
    id: 'alpha.sound',
    owner: 'alpha',
    reason: 'fixture',
    design: 'fixture 4',
    sql: 'SELECT p.id FROM alpha."AlphaParent" p WHERE p.market_id = $1',
    params: [],
    parseRow: row,
  },
];
