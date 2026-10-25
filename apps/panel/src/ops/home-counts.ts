import type { IconName, StatTone } from '@mondapac-drive/ui';

// The Home figures: what an operator should look at now. Each one reads the first page of an
// existing list route, only for a session that holds the route's key; a full page with more
// behind it shows as "100+", never as a wrong exact number.

/** Documents expiring within this many days count as expiring soon. */
export const EXPIRY_WINDOW_DAYS = 30;

/** The largest page every counted list route accepts. */
export const COUNT_PAGE = 100;

export interface CountRead {
  readonly id: string;
  readonly icon: IconName;
  /** The key the list route needs; the card is left out for a session without it. */
  readonly key: string;
  /** The API path of the read (first page only), at the request's time. */
  readonly path: (now: Date) => string;
  /** The panel page that lists what is counted, or null while the panel has none. */
  readonly href: string | null;
  /** A figure above zero is shown in this tone. */
  readonly tone: StatTone;
  /** The count of one page and whether more pages exist. */
  readonly count: (body: unknown) => { readonly count: number; readonly hasMore: boolean };
}

interface Paged {
  readonly items?: readonly unknown[];
  readonly next?: string | null;
}

const pageCount = (body: unknown) => {
  const page = body as Paged;
  return { count: page.items?.length ?? 0, hasMore: typeof page.next === 'string' };
};

export const COUNT_READS: readonly CountRead[] = [
  {
    id: 'deliveries-attention',
    icon: 'alert-triangle',
    key: 'delivery.delivery.view',
    path: () => `delivery/admin/deliveries?attention=true&limit=${COUNT_PAGE}`,
    href: '/deliveries?show=attention',
    tone: 'critical',
    count: pageCount,
  },
  {
    id: 'deliveries-waiting',
    icon: 'package',
    key: 'delivery.delivery.view',
    path: () => `delivery/admin/deliveries?status=DISPATCHING&limit=${COUNT_PAGE}`,
    href: '/deliveries?show=waiting',
    tone: 'attention',
    count: pageCount,
  },
  {
    id: 'fleet-applicants',
    icon: 'users',
    key: 'fleet.courier.view',
    path: () => `fleet/admin/couriers?status=applicant&limit=${COUNT_PAGE}`,
    href: '/fleet',
    tone: 'attention',
    count: pageCount,
  },
  {
    id: 'fleet-documents',
    icon: 'file-text',
    key: 'fleet.courier.view',
    path: () => `fleet/admin/couriers?limit=${COUNT_PAGE}`,
    href: '/fleet?show=all',
    tone: 'attention',
    count: (body) => {
      const page = body as { items?: readonly { documentsToReview?: number }[]; next?: unknown };
      const count = (page.items ?? []).reduce((sum, c) => sum + (c.documentsToReview ?? 0), 0);
      return { count, hasMore: typeof page.next === 'string' };
    },
  },
  {
    id: 'fleet-expiring',
    icon: 'clock',
    key: 'fleet.courier.view',
    path: (now) => {
      const before = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 86_400_000).toISOString();
      return `fleet/admin/documents/expiring?before=${encodeURIComponent(before)}&limit=${COUNT_PAGE}`;
    },
    href: '/fleet?show=expiring',
    tone: 'attention',
    count: pageCount,
  },
  {
    id: 'payout-lines',
    icon: 'wallet',
    key: 'payouts.ledger.view',
    path: () => `payouts/admin/lines?status=held,unresolved&limit=${COUNT_PAGE}`,
    href: '/payouts',
    tone: 'attention',
    count: (body) => {
      const page = body as { lines?: readonly unknown[]; next?: unknown };
      return { count: page.lines?.length ?? 0, hasMore: typeof page.next === 'string' };
    },
  },
  {
    id: 'dead-webhooks',
    icon: 'alert-triangle',
    key: 'notifications.webhook-call.resend',
    path: () => 'notifications/admin/webhook-calls/dead',
    href: '/webhooks',
    tone: 'critical',
    count: (body) => ({
      count: (body as { calls?: readonly unknown[] }).calls?.length ?? 0,
      hasMore: false,
    }),
  },
];

/** The reads a session may make, in the order the cards show. */
export function countReadsFor(keys: ReadonlySet<string>): readonly CountRead[] {
  return COUNT_READS.filter((read) => keys.has(read.key));
}

/**
 * The link of a card: its list page when the session's nav has that section, so a card never
 * links to a page the panel does not have (yet) or the session may not open.
 */
export function cardHref(read: CountRead, navHrefs: ReadonlySet<string>): string | null {
  if (read.href === null) return null;
  const path = read.href.split('?')[0] ?? read.href;
  return navHrefs.has(path) ? read.href : null;
}
