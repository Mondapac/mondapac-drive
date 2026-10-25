import 'server-only';
import type { ServerGet } from '../server/server-fetch.ts';
import { UUID, type DeliveryPage, type DeliverySummary } from '../ops/types.ts';
import { apiQuery, type ListFilter } from './filters.ts';

/** Rows of one list page. */
export const PAGE_ROWS = 50;

export type ListPage =
  | {
      readonly kind: 'ok';
      readonly items: readonly DeliverySummary[];
      readonly next: string | null;
    }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'failed' };

/**
 * One page of the delivery list for a filter: one API read, which filters by tab ("needs
 * attention" included), status and merchant. The list is newest first and the cursor is the
 * API's `next`, kept only when it is a UUID. `read` is the page server's GET, injected for tests.
 */
export async function readListPage(
  filter: ListFilter,
  read: (path: string) => Promise<ServerGet<DeliveryPage>>,
): Promise<ListPage> {
  const answer = await read(`delivery/admin/deliveries${apiQuery(filter, filter.before)}`);
  if (answer.kind === 'signed-out') return answer;
  if (answer.kind !== 'ok') return { kind: 'failed' };
  const next = answer.body.next;
  return {
    kind: 'ok',
    items: answer.body.items,
    next: next !== null && UUID.test(next) ? next : null,
  };
}
