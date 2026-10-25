// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../server/server-fetch.ts', () => ({ serverGet: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never })),
  getLocale: () => Promise.resolve('en-AU'),
}));

import { callApi } from '../api/client.ts';
import { NoticeProvider } from '../ops/notice.tsx';
import { serverGet } from '../server/server-fetch.ts';
import { DeadCallsTable, merchantOfCall } from './dead-calls-table.tsx';
import { SubscriptionsTable } from './subscriptions-table.tsx';
import { readSubscriptions } from './subscriptions.ts';
import type { DeadWebhookCall, WebhookSubscription } from './types.ts';

const call = vi.mocked(callApi);
const get = vi.mocked(serverGet);
const MERCHANT = '0190a000-0000-7000-8000-0000000000e1';
const SUB = '0190a000-0000-7000-8000-0000000000f1';
const CALL = '0190a000-0000-7000-8000-0000000000d1';

const dead = (over: Partial<DeadWebhookCall> = {}): DeadWebhookCall => ({
  id: CALL,
  subscriptionId: SUB,
  eventId: '0190a000-0000-7000-8000-00000000abcd',
  eventType: 'delivery.status-changed',
  status: 'dead',
  attempts: 8,
  lastStatusCode: 503,
  lastErrorCode: null,
  createdAt: '2026-10-25T01:00:00Z',
  deadAt: '2026-10-25T05:00:00Z',
  nextAttemptAt: null,
  ...over,
});

const subscription = (over: Partial<WebhookSubscription> = {}): WebhookSubscription => ({
  id: SUB,
  merchantId: MERCHANT,
  url: 'https://market.example/hooks/drive',
  eventTypes: ['delivery.booked', 'delivery.status-changed'],
  status: 'active',
  secretVersion: 2,
  previousSecretValidUntil: null,
  createdAt: '2026-10-20T00:00:00Z',
  ...over,
});

function show(node: ReactElement) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>{node}</NoticeProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('dead webhook calls', () => {
  it('finds the merchant on the call first, then through its subscription', () => {
    const bySubscription = new Map([[SUB, MERCHANT]]);
    expect(merchantOfCall(dead(), bySubscription)).toBe(MERCHANT);
    expect(merchantOfCall(dead({ merchantId: 'own' }), bySubscription)).toBe('own');
    expect(merchantOfCall(dead(), new Map())).toBeUndefined();
  });

  it('lists the event, the merchant, the last answer in words and re-sends a call', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(
      await DeadCallsTable({
        calls: [
          dead(),
          dead({
            id: '0190a000-0000-7000-8000-0000000000d2',
            subscriptionId: '0190a000-0000-7000-8000-0000000000f9',
            lastStatusCode: null,
            lastErrorCode: 'webhook.timeout',
          }),
        ],
        merchantBySubscription: new Map([[SUB, MERCHANT]]),
        merchantNames: new Map([[MERCHANT, 'Halal Market']]),
        showMerchant: true,
        canResend: true,
        csrfToken: 'csrf-1',
      }),
    );
    const [first, second] = screen.getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(within(first).getByRole('link', { name: 'Halal Market' }).getAttribute('href')).toBe(
      `/merchants/${MERCHANT}`,
    );
    expect(within(first).getByText('HTTP 503')).toBeTruthy();
    // A call whose merchant the session cannot tell shows its subscription's short id.
    expect(within(second).getByText('Subscription 000000F9')).toBeTruthy();
    expect(within(second).getByText('Timed out')).toBeTruthy();

    fireEvent.click(within(first).getByRole('button', { name: 'Send again' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `notifications/admin/webhook-calls/${CALL}/resend`,
        {},
        'csrf-1',
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText('The delivery.status-changed call is queued to be sent again.'),
      ).toBeTruthy(),
    );
  });

  it('says so when nothing is dead, and shows an unknown error code as it came', async () => {
    show(
      await DeadCallsTable({
        calls: [],
        merchantBySubscription: new Map(),
        merchantNames: new Map(),
        showMerchant: true,
        canResend: true,
        csrfToken: 'csrf',
      }),
    );
    expect(screen.getByText('No failed webhook calls')).toBeTruthy();
    cleanup();
    show(
      await DeadCallsTable({
        calls: [dead({ lastStatusCode: null, lastErrorCode: 'webhook.brand-new' })],
        merchantBySubscription: new Map(),
        merchantNames: new Map(),
        showMerchant: false,
        canResend: false,
        csrfToken: 'csrf',
      }),
    );
    expect(screen.getByText('webhook.brand-new')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Merchant')).toBeNull();
  });
});

describe('webhook subscriptions of a merchant', () => {
  it('shows the endpoint as text, the events and the secret version, never a secret', async () => {
    show(
      await SubscriptionsTable({
        subscriptions: [
          subscription({ previousSecretValidUntil: '2026-10-26T00:00:00Z' }),
          subscription({ id: 'other', status: 'disabled', secretVersion: 1 }),
        ],
      }),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getAllByText('https://market.example/hooks/drive')).toHaveLength(2);
    expect(screen.getByText(/Version 2; the previous one works until/)).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getAllByText('delivery.booked, delivery.status-changed')).toHaveLength(2);
  });

  it('pages through every subscription of the merchant', async () => {
    get
      .mockResolvedValueOnce({ kind: 'ok', body: { items: [subscription()], next: SUB } })
      .mockResolvedValueOnce({
        kind: 'ok',
        body: { items: [subscription({ id: 'b' })], next: null },
      });
    const rows = await readSubscriptions(MERCHANT);
    expect(rows?.map((row) => row.id)).toEqual([SUB, 'b']);
    expect(get).toHaveBeenNthCalledWith(
      1,
      `notifications/admin/webhook-subscriptions?limit=100&merchantId=${MERCHANT}`,
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      `notifications/admin/webhook-subscriptions?limit=100&merchantId=${MERCHANT}&after=${SUB}`,
    );
  });

  it('answers null when the first read fails (the route is not there yet)', async () => {
    get.mockResolvedValueOnce({ kind: 'not-found' });
    expect(await readSubscriptions()).toBeNull();
  });
});
