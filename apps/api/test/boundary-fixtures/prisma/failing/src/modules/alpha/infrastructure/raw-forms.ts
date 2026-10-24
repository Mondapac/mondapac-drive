// Violations: the other forms of raw SQL, the driver and rawRead that C3 must see.
declare const db: Record<string, (...args: unknown[]) => unknown>;
declare const port: { rawRead: (market: unknown, id: string, params: unknown) => unknown };
declare const Prisma: Record<string, (...args: unknown[]) => unknown>;
declare const require: (specifier: string) => unknown;

const { $queryRaw: renamed } = db;
const { $executeRawUnsafe } = db;
const extended = db.$extends();
const built = Prisma.sql('SELECT 1');
const loadedDriver = require('pg');
const dynamicDriver = import('pg-pool');
const { rawRead } = port;
const viaElement = port['rawRead'];

export {
  renamed,
  $executeRawUnsafe,
  extended,
  built,
  loadedDriver,
  dynamicDriver,
  rawRead,
  viaElement,
};
export * from 'postgres';

declare const moduleName: string;
const { ['$executeRawUnsafe']: computed } = db;
const computedLoad = require(moduleName);
export { computed, computedLoad };
export * from 'postgres/cjs/src/index.js';
