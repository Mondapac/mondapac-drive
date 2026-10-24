import { err, type Result } from '@mondapac-drive/shared-kernel';
import { DispatchDomainError } from '../domain/errors';

/** A refused dispatch request: a stable code callers match on, and a message for people. */
export interface DispatchFailure {
  readonly code: string;
  readonly message: string;
}

/** Runs domain code and turns a broken domain rule into an `err`; anything else is rethrown. */
export async function refusingBrokenRules<T>(
  work: () => Promise<Result<T, DispatchFailure>>,
): Promise<Result<T, DispatchFailure>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DispatchDomainError) {
      return err({ code: error.code, message: error.message });
    }
    throw error;
  }
}

export function jobNotFound(): DispatchFailure {
  return { code: 'dispatch.not-found', message: 'No dispatch job for this delivery' };
}
