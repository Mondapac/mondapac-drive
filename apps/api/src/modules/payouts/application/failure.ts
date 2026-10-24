import { err, type Result } from '@mondapac-drive/shared-kernel';
import { PayoutsDomainError } from '../domain/errors';
import type { LedgerEntry } from '../domain/ledger';

/** A refused payouts request: a stable code callers match on, and a message for people. */
export interface PayoutsFailure {
  readonly code: string;
  readonly message: string;
}

/** Runs domain code and turns a broken domain rule into an `err`; anything else is rethrown. */
export async function refusingBrokenRules<T>(
  work: () => Promise<Result<T, PayoutsFailure>>,
): Promise<Result<T, PayoutsFailure>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PayoutsDomainError) {
      return err({ code: error.code, message: error.message });
    }
    throw error;
  }
}

export const unknownCourier = (courierId: string): PayoutsFailure => ({
  code: 'payouts.unknown-courier',
  message: `Fleet knows no courier ${courierId} in this Market`,
});

/** A ledger entry a use case appended, or found already appended under the same reference. */
export interface RecordedEntry {
  /** False when the reference was taken: the stored entry is answered and nothing changed. */
  readonly recorded: boolean;
  readonly entry: LedgerEntry;
}
