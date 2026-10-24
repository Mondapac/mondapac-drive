// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { InviteCourierButton } from '../couriers/invite-courier-button.tsx';
import { DispatchPanel, type DispatchPanelProps } from '../deliveries/dispatch-panel.tsx';
import { IssueKeyButton } from '../merchants/issue-key-button.tsx';
import { NoticeProvider } from './notice.tsx';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const COURIER = '0190a000-0000-7000-8000-0000000000c1';
const KEY = 'ms1_secret-shown-once';

function show(node: ReactNode) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>{node}</NoticeProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no modal <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('issue API key (copy once)', () => {
  it('shows the issued key once, outside the notice, and drops it when the dialog closes', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 201,
      body: { code: 'api-key.issued', keyId: ID, key: KEY, expiresAt: '2027-10-24T00:00:00Z' },
    });
    show(<IssueKeyButton merchantId={ID} csrfToken="csrf-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Issue API key' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'marketplace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));

    await waitFor(() => expect(screen.getByTestId('issued-key').textContent).toBe(KEY));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `identity/admin/merchants/${ID}/api-keys`,
      { label: 'marketplace' },
      'csrf-1',
    );
    expect(screen.getByText(/This is the only time the key is shown/)).toBeTruthy();
    // The live notice never carries the key.
    for (const region of screen.getAllByRole('status').filter((e) => e.tagName !== 'OUTPUT')) {
      expect(region.textContent).not.toContain(KEY);
    }

    fireEvent.click(screen.getByRole('button', { name: "I've stored it" }));
    expect(screen.queryByTestId('issued-key')).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('shows the refusal and no key when the API refuses', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'merchant.suspended' } });
    show(<IssueKeyButton merchantId={ID} csrfToken="csrf-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Issue API key' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'marketplace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));

    await waitFor(() => expect(screen.getByText('This merchant is suspended.')).toBeTruthy());
    expect(screen.queryByTestId('issued-key')).toBeNull();
  });
});

describe('invite courier', () => {
  it('posts the address with the CSRF token and tells where the invitation went', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: { code: 'invitation.issued' } });
    show(<InviteCourierButton csrfToken="csrf-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Invite courier' }));
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: ' sam@example.test ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() =>
      expect(screen.getByText('An invitation is on its way to sam@example.test.')).toBeTruthy(),
    );
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/admin/couriers/invitations',
      { email: 'sam@example.test' },
      'csrf-1',
    );
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe('dispatch panel', () => {
  const props = (over: Partial<DispatchPanelProps> = {}): DispatchPanelProps => ({
    deliveryId: ID,
    status: 'DISPATCHING',
    couriers: [{ accountId: COURIER, name: 'Sam Courier' }],
    quotedVehicle: 'car',
    canDispatch: true,
    canCancel: true,
    csrfToken: 'csrf-1',
    ...over,
  });

  it('assigns the chosen courier with the quoted vehicle by default', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(<DispatchPanel {...props()} />);

    fireEvent.change(screen.getByLabelText('Courier'), { target: { value: COURIER } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign courier' }));

    await waitFor(() => expect(screen.getByText('Sam Courier was assigned.')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `delivery/admin/deliveries/${ID}/dispatch`,
      { type: 'courier_assigned', courierId: COURIER, vehicle: 'car' },
      'csrf-1',
    );
  });

  it('asks for a courier before posting', () => {
    show(<DispatchPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Assign courier' }));
    expect(screen.getByText('Choose a courier and a vehicle.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the API refusal in words', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 422, code: 'delivery.invalid-transition' },
    });
    show(<DispatchPanel {...props()} />);
    fireEvent.change(screen.getByLabelText('Courier'), { target: { value: COURIER } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign courier' }));
    await waitFor(() =>
      expect(
        screen.getByText(/That step is not possible in the delivery's current status/),
      ).toBeTruthy(),
    );
  });

  it('cancels only with a reason', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(<DispatchPanel {...props({ status: 'ASSIGNED' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel delivery…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel delivery' }));
    expect(screen.getByText('Give a reason.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Shop closed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel delivery' }));
    await waitFor(() => expect(screen.getByText('The delivery was cancelled.')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `delivery/admin/deliveries/${ID}/cancel`,
      { reason: 'Shop closed' },
      'csrf-1',
    );
  });

  it('offers by status and key: open for scheduled, unassign when assigned, nothing when final', () => {
    show(<DispatchPanel {...props({ status: 'SCHEDULED' })} />);
    expect(screen.getByRole('button', { name: 'Open dispatch now' })).toBeTruthy();
    cleanup();

    show(<DispatchPanel {...props({ status: 'AT_PICKUP' })} />);
    expect(screen.getByRole('button', { name: 'Unassign courier' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assign courier' })).toBeNull();
    cleanup();

    show(<DispatchPanel {...props({ status: 'PICKED_UP' })} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();

    // An operator: cancel only, no dispatch.
    show(<DispatchPanel {...props({ canDispatch: false })} />);
    expect(screen.queryByRole('button', { name: 'Assign courier' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel delivery…' })).toBeTruthy();
  });

  it('says so when no courier is active', () => {
    show(<DispatchPanel {...props({ couriers: [] })} />);
    expect(
      screen.getByText('There is no active courier to assign. Invite one first.'),
    ).toBeTruthy();
  });
});
