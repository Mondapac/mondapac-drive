import { err, type Result } from '@mondapac-drive/shared-kernel';
import { FleetDomainError } from '../domain/errors';

/** A refused fleet request: a stable code API clients match on, and a message for people. */
export interface FleetFailure {
  readonly code: string;
  readonly message: string;
}

/** Runs domain code and turns a broken domain rule into an `err`; anything else is rethrown. */
export async function refusingBrokenRules<T>(
  work: () => Promise<Result<T, FleetFailure>>,
): Promise<Result<T, FleetFailure>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FleetDomainError) {
      return err({ code: error.code, message: error.message });
    }
    throw error;
  }
}

export const courierNotFound = (): FleetFailure => ({
  code: 'fleet.courier.not-found',
  message: 'No such courier',
});

/** A caller of the wrong population, after the gate admitted its keys. */
export const forbidden = (): FleetFailure => ({ code: 'access.denied', message: 'Not allowed' });

export const documentNotFound = (): FleetFailure => ({
  code: 'fleet.document.not-found',
  message: 'No such document',
});
