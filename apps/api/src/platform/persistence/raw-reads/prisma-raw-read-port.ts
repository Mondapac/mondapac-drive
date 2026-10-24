import { Logger } from '@nestjs/common';
import { isMinted } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { MarketMismatchError, NoUnitOfWorkError } from '../../unit-of-work/errors';
import { reduceDatabaseError } from '../database-error';
import type { PrismaRoot } from '../prisma-root';
import { unitStorage } from '../unit-store';
import { RawReadFailedError, RawReadRefusedError } from './errors';
import type { RawReadPort } from './raw-read-port';
import {
  RAW_READ_STATEMENTS,
  type RawReadEntry,
  type RawReadName,
  type RawReadParam,
  type RawReadParams,
  type RawReadRow,
} from './statements';

/**
 * Nest token of the unbound port. A private `Symbol` in a file module code may not import
 * (dependency-cruiser `persistence-root-is-private`), exported by `PersistenceModule` only so
 * that `rawReadFor` can inject it with Nest's own boot ordering (Hassan R-1, H1). Nothing
 * else may name it.
 */
export const RAW_READ_BASE = Symbol('RAW_READ_BASE');

/**
 * What `RAW_READ_BASE` holds: the binder, keyed by a private symbol so that nothing hands out a
 * port by module name under a string key (the contracts test of exports looks for that). A
 * module cannot name the symbol either.
 */
export const BIND_RAW_READ = Symbol('BIND_RAW_READ');
export interface RawReadBinder {
  readonly [BIND_RAW_READ]: (module: string) => RawReadPort;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Scalar = 'uuid' | 'text';

function scalarOk(type: Scalar, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return type === 'uuid' ? UUID.test(value) : value.length <= 1000 && !value.includes('\u0000');
}

/**
 * Binds the caller's parameters to the declaration (decision 5): exactly the declared keys,
 * the declared types, arrays within their cap, zipped arrays of equal length. The Market is
 * never a parameter. Reasons only; a refusal never repeats a value.
 */
export function bindRawReadParams(entry: RawReadEntry, params: unknown): unknown[] {
  const refuse = (reason: ConstructorParameters<typeof RawReadRefusedError>[1]): never => {
    throw new RawReadRefusedError(entry.id, reason);
  };
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return refuse('params-malformed');
  }
  const given = params as Record<string, unknown>;
  const declared = new Set(entry.params.map((p) => p.name));
  if (Object.keys(given).some((key) => !declared.has(key))) return refuse('params-malformed');
  const groups = new Map<string, number>();
  const values = entry.params.map((param: RawReadParam) => {
    if (!Object.hasOwn(given, param.name)) return refuse('params-malformed');
    const value = given[param.name];
    if (!param.type.endsWith('[]')) {
      if (!scalarOk(param.type as Scalar, value)) return refuse('params-malformed');
      return value;
    }
    const item = param.type.slice(0, -2) as Scalar;
    if (!Array.isArray(value)) return refuse('params-malformed');
    if (param.maxLength === undefined || value.length > param.maxLength) {
      return refuse('array-too-long');
    }
    const list: unknown[] = Array.from(value as unknown[]);
    if (!list.every((element) => scalarOk(item, element))) return refuse('params-malformed');
    if (param.group !== undefined) {
      const seen = groups.get(param.group);
      if (seen !== undefined && seen !== list.length) return refuse('group-length-mismatch');
      groups.set(param.group, list.length);
    }
    return list;
  });
  return values;
}

/**
 * {@link RawReadPort} on the base client. Runs only inside an open read-only unit of the
 * asked Market (decision 7): the statement goes out on the pool, unnamed, with no transaction,
 * like a model read of that unit (ADR-0025). Fails closed with no open unit, a closed unit or
 * a read-write unit. Logs the id, module, Market, row count, duration and, on error, the
 * SQLSTATE; never a parameter, the SQL with values or a row (decision 8).
 */
export class PrismaRawReadPort implements RawReadPort {
  private readonly entries: ReadonlyMap<string, RawReadEntry>;
  private readonly logger = new Logger('RawRead');

  constructor(
    private readonly root: PrismaRoot,
    list: readonly RawReadEntry[] = RAW_READ_STATEMENTS,
  ) {
    this.entries = new Map(list.map((entry) => [entry.id, entry]));
  }

  /**
   * The port of one module (Hassan R-1): a statement owned by another module is refused with
   * `wrong-module` before any unit, parameter or database is touched. An unknown id is left to
   * {@link rawRead}, which refuses it as `unknown-statement`.
   */
  forModule(module: string): RawReadPort {
    return {
      rawRead: (market, id, params) => {
        const entry = this.entries.get(String(id));
        if (entry !== undefined && entry.owner !== module) {
          return Promise.reject(new RawReadRefusedError(entry.id, 'wrong-module'));
        }
        return this.rawRead(market, id, params);
      },
    };
  }

  async rawRead<K extends RawReadName>(
    market: MarketContext,
    id: K,
    params: RawReadParams<K>,
  ): Promise<RawReadRow<K>[]> {
    const unit = unitStorage.getStore();
    if (unit === undefined || unit.closed) throw new NoUnitOfWorkError();
    if (
      !isMinted(market) ||
      market.marketId !== unit.market.marketId ||
      market.tenantId !== unit.market.tenantId
    ) {
      throw new MarketMismatchError();
    }
    const entry = this.entries.get(id);
    if (entry === undefined) throw new RawReadRefusedError(String(id), 'unknown-statement');
    if (!unit.readOnly) throw new RawReadRefusedError(entry.id, 'read-write-unit');
    const values = bindRawReadParams(entry, params);

    const started = performance.now();
    let rows: unknown;
    try {
      rows = await this.root.$queryRawUnsafe(entry.sql, unit.market.marketId, ...values);
    } catch (error) {
      const sqlState = reduceDatabaseError(error)?.sqlState ?? null;
      this.logger.error({
        msg: 'raw-read.failed',
        statement: entry.id,
        module: entry.owner,
        marketId: unit.market.marketId,
        sqlState,
        durationMs: Math.round(performance.now() - started),
      });
      throw new RawReadFailedError(entry.id, sqlState);
    }
    if (!Array.isArray(rows)) throw new RawReadRefusedError(entry.id, 'not-an-array');
    let parsed: unknown[];
    try {
      parsed = rows.map((row: unknown) => entry.parseRow(row));
    } catch {
      // The statement id only: validation details may quote a row.
      this.logger.error({
        msg: 'raw-read.row-invalid',
        statement: entry.id,
        module: entry.owner,
        marketId: unit.market.marketId,
      });
      throw new RawReadRefusedError(entry.id, 'row-invalid');
    }
    this.logger.log({
      msg: 'raw-read.done',
      statement: entry.id,
      module: entry.owner,
      marketId: unit.market.marketId,
      rows: parsed.length,
      durationMs: Math.round(performance.now() - started),
    });
    return parsed as RawReadRow<K>[];
  }
}
