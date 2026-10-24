// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { NoticeProvider } from '../ops/notice.tsx';
import { AdjustmentButton } from './adjustment-button.tsx';

const call = vi.mocked(callApi);
const COURIER = '0190a000-0000-7000-8000-0000000000c1';

function show(currency: string) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>
        <AdjustmentButton courierId={COURIER} currency={currency} csrfToken="csrf-1" />
      </NoticeProvider>
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
}

function fill(direction: 'credit' | 'debit', amount: string, reason: string) {
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: direction } });
  fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: reason } });
}

const submit = () =>
  fireEvent.submit(document.querySelector(`#adjust-${COURIER}`) as HTMLFormElement);

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

describe('balance adjustment', () => {
  it('sends a debit in AUD cents with a reason and an idempotency key', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { recorded: true } });
    show('AUD');
    fill('debit', '12.50', 'damage-claim');
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const [method, path, body, csrf] = call.mock.calls[0] ?? [];
    expect([method, path, csrf]).toEqual([
      'POST',
      `payouts/admin/couriers/${COURIER}/adjustments`,
      'csrf-1',
    ]);
    expect(body).toMatchObject({
      amount: { amount: '-1250', currency: 'AUD' },
      reason: 'damage-claim',
    });
    expect((body as { key: string }).key).toMatch(/^adj:[0-9a-f-]{36}$/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('sends whole yen for ZZ and refuses yen with decimals', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { recorded: true } });
    show('JPY');
    fill('credit', '12.5', 'bonus');
    submit();
    expect(await screen.findByText(/Enter an amount above zero/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fill('credit', '1200', 'bonus');
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toMatchObject({ amount: { amount: '1200', currency: 'JPY' } });
  });

  it('keeps one key for retries in one dialog and takes a new one for a new dialog', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: 'network' } });
    show('AUD');
    fill('credit', '5', 'bonus');
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { recorded: false } });
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    const keyOf = (index: number) => (call.mock.calls[index]?.[2] as { key: string }).key;
    expect(keyOf(1)).toBe(keyOf(0));
    expect(await screen.findByText(/already recorded/)).toBeTruthy();

    call.mockResolvedValueOnce({ ok: true, status: 200, body: { recorded: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    fill('credit', '5', 'bonus');
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it("shows the API's refusal in the dialog", async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'payouts.key-reused' } });
    show('AUD');
    fill('credit', '5', 'other');
    submit();
    expect(await screen.findByText(/already used for a different adjustment/)).toBeTruthy();
  });
});
