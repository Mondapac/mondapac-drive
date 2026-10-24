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
import { DecisionButton, decisionBody, endOfDay, type DecisionField } from './decision-button.tsx';

const call = vi.mocked(callApi);
const COURIER = '0190a000-0000-7000-8000-0000000000c1';
const PATH = `fleet/admin/couriers/${COURIER}/suspend`;

const reason: DecisionField = {
  kind: 'select',
  name: 'reason',
  label: 'Reason',
  placeholder: 'Choose a reason',
  options: [
    { value: 'documents', label: 'Documents' },
    { value: 'safety', label: 'Safety' },
  ],
};

function show(fields: readonly DecisionField[], method: 'POST' | 'PUT' = 'POST') {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>
        <DecisionButton
          method={method}
          path={PATH}
          fields={fields}
          csrfToken="csrf-1"
          copy={{ button: 'Decide…', title: 'Decide?', body: 'Body', action: 'Go', done: 'Done.' }}
        />
      </NoticeProvider>
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Decide…' }));
}

const submit = () =>
  fireEvent.submit(
    document.querySelector(`#fleet-POST-${PATH.replaceAll('/', '-')}`) as HTMLFormElement,
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

describe('fleet decision body', () => {
  it('takes a listed choice, a yes or no, and whole numbers within their range', () => {
    const fields: DecisionField[] = [
      reason,
      { kind: 'checkbox', name: 'coldChainCapable', label: 'Cold', initial: false },
      { kind: 'integer', name: 'maxWeightGrams', label: 'g', min: 1, max: 5_000_000, initial: 1 },
    ];
    expect(
      decisionBody(fields, { reason: 'safety', coldChainCapable: true, maxWeightGrams: ' 25000 ' }),
    ).toEqual({ body: { reason: 'safety', coldChainCapable: true, maxWeightGrams: 25000 } });
    expect(
      decisionBody(fields, { reason: 'fraud', coldChainCapable: false, maxWeightGrams: '2.5' }),
    ).toEqual({ wrong: ['reason', 'maxWeightGrams'] });
    expect(decisionBody(fields, { reason: '', maxWeightGrams: '5000001' })).toEqual({
      wrong: ['reason', 'maxWeightGrams'],
    });
  });

  it('sends a day as the end of that day, and leaves out an empty optional day', () => {
    const expiry: DecisionField = { kind: 'date', name: 'expiresAt', label: 'E', required: false };
    expect(decisionBody([expiry], { expiresAt: '' })).toEqual({ body: {} });
    expect(decisionBody([{ ...expiry, required: true }], { expiresAt: '' })).toEqual({
      wrong: ['expiresAt'],
    });
    expect(decisionBody([expiry], { expiresAt: '2027-03-31' })).toEqual({
      body: { expiresAt: new Date(2027, 2, 31, 23, 59, 59).toISOString() },
    });
    expect(endOfDay('2027-02-30')).toBeNull();
    expect(endOfDay('31/03/2027')).toBeNull();
  });
});

describe('fleet decision button', () => {
  it('never presets a reason, and sends the chosen one with the CSRF token', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show([reason]);
    submit();
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Check this value.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'safety' } });
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]).toEqual(['POST', PATH, { reason: 'safety' }, 'csrf-1']);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(await screen.findByText('Done.')).toBeTruthy();
  });

  it('starts from the courier values on each opening', () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show([{ kind: 'checkbox', name: 'taxRegistered', label: 'Registered', initial: true }]);
    const box = () => screen.getByLabelText<HTMLInputElement>('Registered');
    expect(box().checked).toBe(true);
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decide…' }));
    expect(box().checked).toBe(true);
  });

  it("shows the fleet's own sentence for a refusal and keeps the dialog open", async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 422, code: 'fleet.courier.not-eligible' },
    });
    show([]);
    submit();
    expect(
      await screen.findByText(
        "The courier isn't eligible yet: check their documents and vehicles.",
      ),
    ).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
