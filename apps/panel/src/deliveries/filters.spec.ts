import { describe, expect, it, vi } from 'vitest';
import type { DeliveryPage, DeliverySummary } from '../ops/types.ts';
import type { ServerGet } from '../server/server-fetch.ts';
import { apiQuery, listHref, needsAttention, parseListFilter } from './filters.ts';
import { ATTENTION_SCAN_PAGES, PAGE_ROWS, readListPage } from './list-page.ts';

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
    expect(apiQuery(parseListFilter({ show: 'attention' }), null, 100)).toBe('?limit=100');
  });

  it('needs attention: lapsed dispatch, cold-chain breach (also once delivered) or a failure', () => {
    expect(needsAttention(row(1))).toBe(false);
    expect(needsAttention(row(1, { exception: 'cold-chain-breach' }))).toBe(true);
    expect(needsAttention(row(1, { status: 'DISPATCHING', exception: 'dispatch-exhausted' }))).toBe(
      true,
    );
    expect(needsAttention(row(1, { status: 'DELIVERY_FAILED' }))).toBe(true);
    const noFlag: DeliverySummary = { ...row(1) };
    delete (noFlag as { exception?: unknown }).exception;
    expect(needsAttention(noFlag)).toBe(false);
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

  it('scans pages for "needs attention" and goes on from the last row it examined', async () => {
    const flagged = (n: number) => row(n, { exception: 'cold-chain-breach' });
    // Page 1: 100 rows, 30 flagged. Page 2: 100 rows, 30 flagged; the 50th match is row 160.
    const first = Array.from({ length: 100 }, (_, i) =>
      i % 10 < 3 ? flagged(300 - i) : row(300 - i),
    );
    const second = Array.from({ length: 100 }, (_, i) =>
      i % 10 < 3 ? flagged(200 - i) : row(200 - i),
    );
    const read = vi
      .fn<(path: string) => Promise<ServerGet<DeliveryPage>>>()
      .mockResolvedValueOnce(ok(first, row(201).id))
      .mockResolvedValueOnce(ok(second, row(101).id));
    const page = await readListPage(parseListFilter({ show: 'attention' }), read);
    expect(read).toHaveBeenNthCalledWith(1, 'delivery/admin/deliveries?limit=100');
    expect(read).toHaveBeenNthCalledWith(
      2,
      `delivery/admin/deliveries?before=${row(201).id}&limit=100`,
    );
    if (page.kind !== 'ok') throw new Error('expected a page');
    expect(page.items).toHaveLength(PAGE_ROWS);
    expect(page.items.every(needsAttention)).toBe(true);
    expect(page.next).toBe(page.items.at(-1)?.id);
  });

  it('stops after the scan cap with the cursor where it stopped, and at the end with none', async () => {
    const read = vi.fn((path: string) =>
      Promise.resolve(ok([row(1)], path.includes('before') ? CURSOR : CURSOR)),
    );
    const capped = await readListPage(parseListFilter({ show: 'attention' }), read);
    expect(read).toHaveBeenCalledTimes(ATTENTION_SCAN_PAGES);
    expect(capped).toEqual({ kind: 'ok', items: [], next: CURSOR });

    const end = await readListPage(parseListFilter({ show: 'attention' }), () =>
      Promise.resolve(ok([row(1, { status: 'DELIVERY_FAILED' })], null)),
    );
    expect(end).toEqual({ kind: 'ok', items: [row(1, { status: 'DELIVERY_FAILED' })], next: null });
  });

  it('signs out on 401, fails on a first-page error and keeps what it read on a later one', async () => {
    expect(
      await readListPage(parseListFilter({}), () => Promise.resolve({ kind: 'signed-out' })),
    ).toEqual({
      kind: 'signed-out',
    });
    expect(
      await readListPage(parseListFilter({}), () => Promise.resolve({ kind: 'unavailable' })),
    ).toEqual({
      kind: 'failed',
    });
    const failed = row(5, { status: 'DELIVERY_FAILED' });
    const read = vi
      .fn<(path: string) => Promise<ServerGet<DeliveryPage>>>()
      .mockResolvedValueOnce(ok([failed], CURSOR))
      .mockResolvedValueOnce({ kind: 'unavailable' });
    expect(await readListPage(parseListFilter({ show: 'attention' }), read)).toEqual({
      kind: 'ok',
      items: [failed],
      next: CURSOR,
    });
  });
});
