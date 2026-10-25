import 'server-only';
import { UUID } from '../ops/types.ts';
import { serverGet } from '../server/server-fetch.ts';
import type { SubscriptionPage, WebhookSubscription } from './types.ts';

/** Pages of subscriptions read at most for one screen (100 rows each). */
const MAX_PAGES = 10;

/**
 * Webhook subscriptions, every page (of one merchant when `merchantId` is given). Null when the
 * first read fails, or the route is not there yet; a later failure keeps the rows read so far.
 */
export async function readSubscriptions(
  merchantId?: string,
): Promise<readonly WebhookSubscription[] | null> {
  const rows: WebhookSubscription[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (merchantId !== undefined) query.set('merchantId', merchantId);
    if (after !== null) query.set('after', after);
    const answer = await serverGet<SubscriptionPage>(
      `notifications/admin/webhook-subscriptions?${query.toString()}`,
    );
    if (answer.kind !== 'ok') return page === 0 ? null : rows;
    rows.push(...answer.body.items);
    after = answer.body.next;
    if (after === null || !UUID.test(after)) break;
  }
  return rows;
}
