import { parseId, type CallContext } from '@mondapac-drive/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { CourierAccounts } from '../application/ports';

/** Dispatch's {@link CourierAccounts} over identity's public facade, asked as the caller. */
export class IdentityCourierAccounts implements CourierAccounts {
  constructor(private readonly identity: IdentityFacade) {}

  async isActive(context: CallContext, accountId: string): Promise<boolean | undefined> {
    const id = parseId<'Account'>(accountId);
    if (!id.ok) return false;
    const answer = await this.identity.isActiveCourier(context, id.value);
    return answer.ok ? answer.value : undefined;
  }
}
