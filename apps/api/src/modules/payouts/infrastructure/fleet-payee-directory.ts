import type { CallContext } from '@mondapac-drive/shared-kernel';
import { MAX_PAYEE_PROFILES, type FleetDirectory } from '../../fleet';
import type { PayeeDirectory } from '../application/ports';
import type { Payee } from '../domain/payee';

/**
 * {@link PayeeDirectory} over fleet's public directory (handoff 23): the employment and tax facts
 * of the couriers to pay, read in batches of fleet's maximum. An id fleet does not know is left
 * out; a failed read throws (fleet never answers "no such payee" for an outage).
 */
export class FleetPayeeDirectory implements PayeeDirectory {
  constructor(private readonly fleet: Pick<FleetDirectory, 'payeeProfiles'>) {}

  async payees(
    context: CallContext,
    courierIds: readonly string[],
  ): Promise<ReadonlyMap<string, Payee>> {
    const ids = [...new Set(courierIds)];
    const found = new Map<string, Payee>();
    for (let start = 0; start < ids.length; start += MAX_PAYEE_PROFILES) {
      const batch = ids.slice(start, start + MAX_PAYEE_PROFILES);
      for (const profile of await this.fleet.payeeProfiles(context, batch)) {
        found.set(
          profile.courierId,
          Object.freeze({
            courierId: profile.courierId,
            engagement: profile.employmentType,
            taxRegistered: profile.taxRegistered,
            businessIdVerified: profile.businessIdVerified,
          }),
        );
      }
    }
    return found;
  }
}
