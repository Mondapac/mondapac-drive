import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { IssueTrackingLink } from '../../tracking';
import type { TrackingLinks } from '../application/ports';

/**
 * Tracking links through tracking's `IssueTrackingLink` (rule `system`), with the Market's
 * system context the SMS job runs with. Each call issues a new link and answers its token once;
 * a refusal (the delivery is not tracked yet, or has ended) answers undefined, so the SMS is
 * retried and dies with `sms.tracking-link-missing` when tracking never issues one.
 */
export class IssuedTrackingLinks implements TrackingLinks {
  constructor(private readonly issueLink: IssueTrackingLink) {}

  async issue(context: CallContext, deliveryId: string): Promise<string | undefined> {
    const issued = await this.issueLink.execute(context, { deliveryId: deliveryId as never });
    return issued.ok ? issued.value.token : undefined;
  }
}
