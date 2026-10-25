import 'server-only';
import type { ServerGet } from '../server/server-fetch.ts';
import { UUID, type DeliveryPage, type DeliverySummary } from '../ops/types.ts';
import { apiQuery, needsAttention, type ListFilter } from './filters.ts';

/** Rows of one list page. */
export const PAGE_ROWS = 50;
/** API pages (of 100) the "needs attention" tab reads at most for one page of the panel. */
export const ATTENTION_SCAN_PAGES = 5;

export type ListPage =
  | {
      readonly kind: 'ok';
      readonly items: readonly DeliverySummary[];
      readonly next: string | null;
    }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'failed' };

/**
 * One page of the delivery list for a filter. The API filters by status and merchant; "needs
 * attention" is the summaries' `exception` flag or a failed delivery, which the API does not
 * filter by, so that tab reads up to ATTENTION_SCAN_PAGES pages and keeps the matching rows.
 * The list is newest first and the cursor is the id of the last row examined (`id < before`),
 * so the next page goes on from there. `read` is the page server's GET, injected for tests.
 */
export async function readListPage(
  filter: ListFilter,
  read: (path: string) => Promise<ServerGet<DeliveryPage>>,
): Promise<ListPage> {
  if (filter.show !== 'attention') {
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
  const items: DeliverySummary[] = [];
  let before = filter.before;
  for (let page = 0; page < ATTENTION_SCAN_PAGES; page += 1) {
    const answer = await read(`delivery/admin/deliveries${apiQuery(filter, before, 100)}`);
    if (answer.kind === 'signed-out') return answer;
    if (answer.kind !== 'ok')
      return page === 0 ? { kind: 'failed' } : { kind: 'ok', items, next: before };
    for (const row of answer.body.items) {
      if (!needsAttention(row)) continue;
      items.push(row);
      if (items.length === PAGE_ROWS) return { kind: 'ok', items, next: row.id };
    }
    const next = answer.body.next;
    if (next === null || !UUID.test(next)) return { kind: 'ok', items, next: null };
    before = next;
  }
  return { kind: 'ok', items, next: before };
}
