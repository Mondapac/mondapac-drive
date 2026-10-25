// The delivery list's filters, kept in the URL so a filtered list can be saved and shared:
// `show` (a tab), `status` (one status of that tab) and `merchant` (one merchant's deliveries).
// Every value comes from a closed set or is a UUID; anything else reads as no filter.

import { DELIVERY_STATUSES, type DeliveryStatus, UUID } from '../ops/types.ts';

/**
 * The tabs and the statuses each one asks the API for; an empty list asks for every status.
 * "Needs attention" asks the API for `attention=true`: a delivery whose dispatch rounds all
 * lapsed, whose cold chain was breached (the flag stays after drop-off), or that failed.
 */
export const LIST_TABS = {
  all: [],
  attention: [],
  waiting: ['DISPATCHING'],
  scheduled: ['SCHEDULED'],
  active: ['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'AT_DROPOFF', 'RETURNING'],
  done: ['DELIVERED', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED'],
} as const satisfies Record<string, readonly DeliveryStatus[]>;
export type ListTab = keyof typeof LIST_TABS;
export const LIST_TAB_IDS = Object.keys(LIST_TABS) as ListTab[];

export interface ListFilter {
  readonly show: ListTab;
  readonly status: DeliveryStatus | null;
  readonly merchantId: string | null;
  readonly before: string | null;
}

/** The statuses a tab's status picker offers: the tab's own, or every status. */
export function statusesOf(show: ListTab): readonly DeliveryStatus[] {
  const own: readonly DeliveryStatus[] = LIST_TABS[show];
  return own.length === 0 ? DELIVERY_STATUSES : own;
}

const one = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

/** The filter of a list URL's query; an unknown or malformed value is dropped. */
export function parseListFilter(query: Record<string, string | string[] | undefined>): ListFilter {
  const rawShow = one(query['show']);
  const show = rawShow !== null && Object.hasOwn(LIST_TABS, rawShow) ? (rawShow as ListTab) : 'all';
  const rawStatus = one(query['status']);
  const status =
    rawStatus !== null && (statusesOf(show) as readonly string[]).includes(rawStatus)
      ? (rawStatus as DeliveryStatus)
      : null;
  const rawMerchant = one(query['merchant']);
  const merchantId =
    rawMerchant !== null && UUID.test(rawMerchant) ? rawMerchant.toLowerCase() : null;
  const rawBefore = one(query['before']);
  const before = rawBefore !== null && UUID.test(rawBefore) ? rawBefore.toLowerCase() : null;
  return { show, status, merchantId, before };
}

/** The list URL of a filter; the defaults are left out, so the plain list is `/deliveries`. */
export function listHref(filter: Partial<ListFilter>): string {
  const query = new URLSearchParams();
  if (filter.show !== undefined && filter.show !== 'all') query.set('show', filter.show);
  if (filter.status != null) query.set('status', filter.status);
  if (filter.merchantId != null) query.set('merchant', filter.merchantId);
  if (filter.before != null) query.set('before', filter.before);
  const text = query.toString();
  return text === '' ? '/deliveries' : `/deliveries?${text}`;
}

/** The API query of one page of a filter (the `delivery/admin/deliveries` list). */
export function apiQuery(filter: ListFilter, before: string | null, limit?: number): string {
  const query = new URLSearchParams();
  const statuses: readonly DeliveryStatus[] =
    filter.status !== null ? [filter.status] : LIST_TABS[filter.show];
  if (statuses.length > 0) query.set('status', statuses.join(','));
  if (filter.merchantId !== null) query.set('merchantId', filter.merchantId);
  if (filter.show === 'attention') query.set('attention', 'true');
  if (before !== null) query.set('before', before);
  if (limit !== undefined) query.set('limit', String(limit));
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
