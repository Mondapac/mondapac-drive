import { isMinted } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { MarketMismatchError, NoUnitOfWorkError } from '../../unit-of-work/errors';
import type { AuditTransaction } from '../guarded-client';
import { unitStorage } from '../unit-store';

/**
 * The audit models of the open unit (docs/design/domain/platform-audit.md 2; Hassan M1 on
 * slice 6a), with the same checks as `PrismaService.tx`: it throws `NoUnitOfWorkError` with no
 * open unit and `MarketMismatchError` for another Market or tenant, and every query still
 * passes the market guard. Only `platform/persistence/audit/` uses it: `PrismaService.tx`
 * hands module code a view without these models, and `pnpm boundaries` reserves them to this
 * folder.
 */
export function auditTx(market: MarketContext): AuditTransaction {
  const unit = unitStorage.getStore();
  if (unit === undefined || unit.closed) throw new NoUnitOfWorkError();
  if (
    !isMinted(market) ||
    market.marketId !== unit.market.marketId ||
    market.tenantId !== unit.market.tenantId
  ) {
    throw new MarketMismatchError();
  }
  return unit.auditView as AuditTransaction;
}
