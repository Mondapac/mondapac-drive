// A sound list: one SELECT over the owner's own table, Market bound as $1 (ADR-0030).
import type { RawReadEntry } from './types';

export const RAW_READ_STATEMENTS: readonly RawReadEntry[] = [
  {
    id: 'alpha.parents-of-kind',
    owner: 'alpha',
    reason: 'fixture',
    design: 'fixture 1',
    sql: 'SELECT p.id, p.code FROM alpha.parent p WHERE p.market_id = $1 AND p.kind = $2',
    params: [{ name: 'kind', type: 'text' }],
    parseRow: (row) => row,
  },
];
