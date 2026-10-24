import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import { reversalOf, type LedgerEntry, type ReversalReason } from '../domain/ledger';
import type { PayoutLine } from '../domain/payout-run';
import type { LedgerRepository } from './ports';

/**
 * The reversal that credits back the debit of a line that will not be paid (failed, held at
 * sending, or settled as never transferred), or `undefined` when the line was never debited.
 * Its reference makes it once per debit. Runs inside the caller's read-write unit.
 */
export async function reverseDebitOf(
  ledger: LedgerRepository,
  market: MarketContext,
  line: PayoutLine,
  reversal: {
    readonly id: Id<'LedgerEntry'>;
    readonly reason: ReversalReason;
    readonly at: Temporal.Instant;
  },
): Promise<LedgerEntry | undefined> {
  const debit = await ledger.findByReference(market, `payout:${line.id}`);
  if (debit === undefined) return undefined;
  return reversalOf(debit, {
    id: reversal.id,
    reference: `reversal:${debit.id}`,
    reason: reversal.reason,
    occurredAt: reversal.at,
    recordedAt: reversal.at,
  });
}
