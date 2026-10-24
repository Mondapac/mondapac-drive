import { err, type Result } from '@mondapac-drive/shared-kernel';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import { DispatchDomainError } from '../domain/errors';

/** A refused dispatch request: a stable code callers match on, and a message for people. */
export interface DispatchFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * Runs domain code and turns a broken domain rule into an `err`, and a job changed meanwhile by
 * another unit (the sweep, another answer) into `dispatch.conflict`; anything else is rethrown.
 */
export async function refusingBrokenRules<T>(
  work: () => Promise<Result<T, DispatchFailure>>,
): Promise<Result<T, DispatchFailure>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DispatchDomainError) {
      return err({ code: error.code, message: error.message });
    }
    if (error instanceof StaleAggregateError) {
      return err({ code: 'dispatch.conflict', message: 'The job changed meanwhile; try again' });
    }
    throw error;
  }
}

export function jobNotFound(): DispatchFailure {
  return { code: 'dispatch.not-found', message: 'No dispatch job for this delivery' };
}

/** The refusal of an actor of the wrong population, after the gate admitted its keys. */
export function accessDenied(): DispatchFailure {
  return { code: 'access.denied', message: 'Not allowed' };
}

/** No offer of this id was made to the calling courier: another courier's offer is unknown. */
export function offerNotFound(): DispatchFailure {
  return { code: 'offer.not-found', message: 'No such offer' };
}

export function deliveryNotFound(): DispatchFailure {
  return { code: 'dispatch.delivery-not-found', message: 'The delivery is not known' };
}
