import { err, type Result } from '@mondapac-drive/shared-kernel';
import { DeliveryDomainError } from '../domain/errors';

/** A refused delivery request: a stable code API clients match on, and a message for people. */
export interface DeliveryFailure {
  readonly code: string;
  readonly message: string;
}

/** Runs domain code and turns a broken domain rule into an `err`; anything else is rethrown. */
export async function refusingBrokenRules<T>(
  work: () => Promise<Result<T, DeliveryFailure>>,
): Promise<Result<T, DeliveryFailure>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DeliveryDomainError) {
      return err({ code: error.code, message: error.message });
    }
    throw error;
  }
}
