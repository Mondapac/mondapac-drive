import { err, type Result } from '@mondapac-drive/shared-kernel';
import { NotificationsDomainError } from '../domain/errors';

/** A refused notifications request: a stable code, and a message without personal data. */
export interface NotificationsFailure {
  readonly code: string;
  readonly message: string;
}

/** Runs domain code and turns a broken domain rule into an `err`; anything else is rethrown. */
export async function refusingBrokenRules<T>(
  work: () => Promise<Result<T, NotificationsFailure>>,
): Promise<Result<T, NotificationsFailure>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NotificationsDomainError) {
      return err({ code: error.code, message: error.message });
    }
    throw error;
  }
}

export function notFound(what: string): NotificationsFailure {
  return { code: `${what}.not-found`, message: `No such ${what}` };
}
