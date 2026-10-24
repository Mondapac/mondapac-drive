import { findRoleProblems, type RoleProblem } from './database-role-check';
import type { PrismaRoot } from './prisma-root';

/**
 * The only database access offered to code outside the persistence layer: a connectivity
 * check and the start-up checks. Everything else goes through a module's own
 * infrastructure/ repositories. It runs on the base client, outside any unit of work
 * (platform persistence design 3.3: raw SQL is refused on the guarded client).
 */
export class DatabaseProbe {
  constructor(private readonly root: PrismaRoot) {}

  /** Resolves when the database answers a trivial query; rejects otherwise. */
  async ping(): Promise<void> {
    await this.root.$queryRaw`SELECT 1`;
  }

  /**
   * What is wrong with the role the application is connected as (docs/design/data/platform.md
   * 10.8); empty when nothing is. `main.ts` runs it once before the server listens.
   */
  async roleProblems(): Promise<RoleProblem[]> {
    return findRoleProblems((sql) => this.root.$queryRawUnsafe(sql));
  }

  /**
   * The login role's `default_transaction_isolation`, as a new session of the pool sees it.
   * Units pass no isolation level for READ COMMITTED (ADR-0025 decision 2), so `main.ts`
   * refuses to start unless this is `read committed`.
   */
  async defaultTransactionIsolation(): Promise<string> {
    const rows = await this.root.$queryRaw<
      { default_transaction_isolation: string }[]
    >`SHOW default_transaction_isolation`;
    return rows[0]?.default_transaction_isolation ?? '';
  }
}
