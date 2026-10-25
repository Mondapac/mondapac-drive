import { describe, expect, it, vi } from 'vitest';
import type { DeliveryPage, DeliverySummary } from '../ops/types.ts';
import type { ServerGet } from '../server/server-fetch.ts';
import { apiQuery, listHref, parseListFilter } from './filters.ts';
import { readListPage } from './list-page.ts';

const MERCHANT = '0190a000-0000-7000-8000-0000000000e1';
const CURSOR = '0190a000-0000-7000-8000-0000000000f1';

/** A summary with a numbered UUID id, newest first by number. */
const row = (n: number, extra: Partial<DeliverySummary> = {}): DeliverySummary => ({
  id: `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  merchantId: MERCHANT,
  externalReference: `order-${n}`,
  serviceAreaCode: 'BNE',
  mode: 'on_demand',
  status: 'DELIVERED',
  vehicle: 'car',
  temperature: 'chilled',
  pickupPostcode: '4000',
  dropoffPostcode: '4101',
  exception: null,
  total: { amount: '1250', currency: 'AUD' },
  createdAt: '2026-10-25T00:00:00Z',
  ...extra,
});

describe('delivery list filter in the URL', () => {
  it('reads a saved filter back, and drops what is not in its closed set', () => {
    expect(
      parseListFilter({ show: 'active', status: 'PICKED_UP', merchant: MERCHANT.toUpperCase() }),
    ).toEqual({ show: 'active', status: 'PICKED_UP', merchantId: MERCHANT, before: null });
    // A status outside the tab, an unknown tab, a prototype key and a bad id read as no filter.
    expect(parseListFilter({ show: 'active', status: 'DELIVERED' }).status).toBeNull();
    expect(parseListFilter({ show: 'toString' }).show).toBe('all');
    expect(parseListFilter({ show: ['active', 'done'], merchant: 'x', before: '1' })).toEqual({
      show: 'all',
      status: null,
      merchantId: null,
      before: null,
    });
  });

  it('writes the shortest URL for a filter and round-trips it', () => {
    expect(listHref({})).toBe('/deliveries');
    const filter = {
      show: 'attention',
      status: null,
      merchantId: MERCHANT,
      before: CURSOR,
    } as const;
    const href = listHref(filter);
    expect(href).toBe(`/deliveries?show=attention&merchant=${MERCHANT}&before=${CURSOR}`);
    const query = Object.fromEntries(new URL(href, 'http://panel.test').searchParams);
    expect(parseListFilter(query)).toEqual(filter);
  });

  it('asks the API for the tab or the one status, and the merchant', () => {
    expect(apiQuery(parseListFilter({ show: 'waiting' }), null)).toBe('?status=DISPATCHING');
    expect(
      apiQuery(parseListFilter({ show: 'done', status: 'RETURNED', merchant: MERCHANT }), CURSOR),
    ).toBe(`?status=RETURNED&merchantId=${MERCHANT}&before=${CURSOR}`);
    expect(apiQuery(parseListFilter({ show: 'attention' }), null, 100)).toBe(
      '?attention=true&limit=100',
    );
    expect(
      apiQuery(
        parseListFilter({ show: 'attention', status: 'DELIVERED', merchant: MERCHANT }),
        null,
      ),
    ).toBe(`?status=DELIVERED&merchantId=${MERCHANT}&attention=true`);
  });
});

describe('one page of the delivery list', () => {
  const ok = (items: DeliverySummary[], next: string | null): ServerGet<DeliveryPage> => ({
    kind: 'ok',
    body: { items, next },
  });

  it('reads one API page for a status tab and keeps a UUID cursor only', async () => {
    const read = vi.fn(() => Promise.resolve(ok([row(2), row(1)], 'not-a-uuid')));
    const page = await readListPage(parseListFilter({ show: 'done' }), read);
    expect(read).toHaveBeenCalledWith(
      'delivery/admin/deliveries?status=DELIVERED%2CDELIVERY_FAILED%2CRETURNED%2CCANCELLED',
    );
    expect(page).toEqual({ kind: 'ok', items: [row(2), row(1)], next: null });
  });

  it('reads one API page for "needs attention" with the attention filter and the cursor', async () => {
    const failed = row(5, { status: 'DELIVERY_FAILED' });
    const read = vi.fn(() => Promise.resolve(ok([failed], CURSOR)));
    const page = await readListPage(parseListFilter({ show: 'attention', before: CURSOR }), read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(`delivery/admin/deliveries?attention=true&before=${CURSOR}`);
    expect(page).toEqual({ kind: 'ok', items: [failed], next: CURSOR });
  });

  it('signs out on 401 and fails on an error', async () => {
    expect(
      await readListPage(parseListFilter({}), () => Promise.resolve({ kind: 'signed-out' })),
    ).toEqual({
      kind: 'signed-out',
    });
    expect(
      await readListPage(parseListFilter({ show: 'attention' }), () =>
        Promise.resolve({ kind: 'unavailable' }),
      ),
    ).toEqual({
      kind: 'failed',
    });
  });
});
