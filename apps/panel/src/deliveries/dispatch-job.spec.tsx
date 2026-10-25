// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never })),
  getLocale: () => Promise.resolve('en-AU'),
}));

import { callApi } from '../api/client.ts';
import { NoticeProvider } from '../ops/notice.tsx';
import { offersByRound, type DispatchJob, type SentOffer } from './dispatch-job.ts';
import { DispatchJobCard } from './dispatch-job-card.tsx';
import { JobActions, type JobActionsProps } from './job-actions.tsx';

const call = vi.mocked(callApi);
const DELIVERY = '0190a000-0000-7000-8000-000000000001';
const ANA = '0190a000-0000-7000-8000-0000000000c1';
const BEN = '0190a000-0000-7000-8000-0000000000c2';
const couriers = [
  { accountId: ANA, name: 'Ana Courier' },
  { accountId: BEN, name: 'Ben Courier' },
];

const offer = (over: Partial<SentOffer>): SentOffer => ({
  id: '0190a000-0000-7000-8000-0000000000d1',
  courierId: ANA,
  vehicle: 'car',
  round: 1,
  status: 'EXPIRED',
  sentAt: '2026-10-25T01:00:00Z',
  expiresAt: '2026-10-25T01:00:30Z',
  answeredAt: null,
  ...over,
});

const job = (over: Partial<DispatchJob>): DispatchJob => ({
  id: '0190a000-0000-7000-8000-0000000000a1',
  deliveryId: DELIVERY,
  status: 'OFFERING',
  round: 2,
  opensAt: '2026-10-25T00:59:00Z',
  nextActionAt: '2026-10-25T01:02:00Z',
  assignment: null,
  offers: [],
  ...over,
});

function show(node: ReactNode) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>{node}</NoticeProvider>
    </NextIntlClientProvider>,
  );
}

const actions = (over: Partial<JobActionsProps> = {}) => (
  <JobActions
    deliveryId={DELIVERY}
    jobStatus="OFFERING"
    assigned={null}
    quotedVehicle="car"
    couriers={couriers}
    csrfToken="csrf-1"
    {...over}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('offers by round', () => {
  it('puts the newest round first and each round in the order it was sent', () => {
    const a = offer({ id: 'a', round: 1, sentAt: '2026-10-25T01:00:00Z' });
    const b = offer({ id: 'b', round: 2, sentAt: '2026-10-25T01:01:05Z' });
    const c = offer({ id: 'c', round: 2, sentAt: '2026-10-25T01:01:00Z' });
    expect(offersByRound([a, b, c])).toEqual([
      { round: 2, offers: [c, b] },
      { round: 1, offers: [a] },
    ]);
  });
});

describe('dispatch job card', () => {
  it('shows the status, the round, the assignment and every offer with its answer', async () => {
    render(
      await DispatchJobCard({
        job: job({
          status: 'ASSIGNED',
          nextActionAt: null,
          assignment: {
            courierId: BEN,
            vehicle: 'van',
            method: 'offer',
            at: '2026-10-25T01:01:20Z',
          },
          offers: [
            offer({ courierId: ANA, round: 1, status: 'EXPIRED' }),
            offer({
              id: 'o2',
              courierId: BEN,
              round: 2,
              vehicle: 'van',
              status: 'ACCEPTED',
              sentAt: '2026-10-25T01:01:00Z',
              answeredAt: '2026-10-25T01:01:20Z',
            }),
            offer({ id: 'o3', courierId: 'unknown-courier-id', round: 2, status: 'WITHDRAWN' }),
          ],
        }),
        couriers: new Map(couriers.map((row) => [row.accountId, row.name])),
        activeCouriers: couriers,
        quotedVehicle: 'car',
        canAssign: false,
        csrfToken: 'csrf',
      }),
    );
    expect(screen.getByText('Assigned')).toBeTruthy();
    expect(screen.getByText(/Ben Courier · Van · accepted an offer/)).toBeTruthy();
    const round2 = screen.getByText('Round 2').parentElement as HTMLElement;
    expect(within(round2).getByText(/Accepted/)).toBeTruthy();
    // A courier whose name the session may not read shows a short id, never a blank.
    expect(within(round2).getByText(/unknown- · Car/)).toBeTruthy();
    expect(within(round2).getByText(/Withdrawn$/)).toBeTruthy();
    const round1 = screen.getByText('Round 1').parentElement as HTMLElement;
    expect(within(round1).getByText(/Expired/)).toBeTruthy();
    // Without dispatch.job.assign there is no command.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says so when no offer went out yet', async () => {
    render(
      await DispatchJobCard({
        job: job({ status: 'WAITING', round: 0 }),
        couriers: new Map(),
        activeCouriers: [],
        quotedVehicle: 'car',
        canAssign: false,
        csrfToken: 'csrf',
      }),
    );
    expect(screen.getByText('Waiting to open')).toBeTruthy();
    expect(screen.getByText('No offer was sent yet.')).toBeTruthy();
  });
});

describe('dispatch job commands', () => {
  it('assigns through the dispatch route with the quoted vehicle by default', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(actions());
    fireEvent.change(screen.getByLabelText('Courier'), { target: { value: BEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign courier' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `dispatch/admin/deliveries/${DELIVERY}/assign`,
        { courierId: BEN, vehicle: 'car' },
        'csrf-1',
      ),
    );
    await waitFor(() => expect(screen.getByText('Ben Courier was assigned.')).toBeTruthy());
    expect(router.refresh).toHaveBeenCalled();
  });

  it('reassigns: the assigned courier is not offered and their vehicle is the default', () => {
    show(actions({ jobStatus: 'ASSIGNED', assigned: { courierId: ANA, vehicle: 'van' } }));
    const picker = screen.getByLabelText('Courier');
    expect(within(picker).queryByText('Ana Courier')).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>('Vehicle').value).toBe('van');
    expect(screen.getByRole('button', { name: 'Reassign courier' })).toBeTruthy();
  });

  it.each([
    [
      'dispatch.collected',
      409,
      'The courier already collected the parcel, so it can no longer be reassigned.',
    ],
    [
      'dispatch.courier-not-active',
      422,
      'This courier is not active in this Market. Choose another courier.',
    ],
  ])('shows %s in words', async (code, status, text) => {
    call.mockResolvedValue({ ok: false, failure: { status, code } });
    show(actions());
    fireEvent.change(screen.getByLabelText('Courier'), { target: { value: ANA } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign courier' }));
    await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
    // A 409 means the job moved on: the page is read again to show it.
    expect(router.refresh).toHaveBeenCalledTimes(status === 409 ? 1 : 0);
  });

  it('asks for a courier before posting', () => {
    show(actions());
    fireEvent.click(screen.getByRole('button', { name: 'Assign courier' }));
    expect(screen.getByText('Choose a courier and a vehicle.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('offers redispatch for an exhausted job only', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(actions({ jobStatus: 'EXHAUSTED' }));
    fireEvent.click(screen.getByRole('button', { name: 'Offer to couriers again' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `dispatch/admin/deliveries/${DELIVERY}/redispatch`,
        {},
        'csrf-1',
      ),
    );
    cleanup();
    show(actions({ jobStatus: 'OFFERING' }));
    expect(screen.queryByRole('button', { name: 'Offer to couriers again' })).toBeNull();
  });

  it('offers nothing once the parcel is collected or the delivery cancelled', () => {
    show(actions({ jobStatus: 'COLLECTED' }));
    show(actions({ jobStatus: 'CANCELLED' }));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
