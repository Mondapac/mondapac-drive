import { parseId, type CallContext } from '@mondapac-drive/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { CourierSessions } from '../application/ports';

/** Notifications' {@link CourierSessions} over identity's public facade, asked as the system. */
export class IdentityCourierSessions implements CourierSessions {
  constructor(private readonly identity: IdentityFacade) {}

  async liveOf(
    context: CallContext,
    accountId: string,
    sessionIds: readonly string[],
  ): Promise<ReadonlySet<string> | undefined> {
    const id = parseId<'Account'>(accountId);
    if (!id.ok) return new Set();
    try {
      const answer = await this.identity.liveSessionsOf(context, id.value, sessionIds);
      return answer.ok ? answer.value : undefined;
    } catch {
      // A failed read is "unknown", never "none live": the push is retried, no device dropped.
      return undefined;
    }
  }
}
