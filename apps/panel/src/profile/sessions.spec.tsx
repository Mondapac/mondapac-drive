// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { createTranslator } from 'next-intl';
import { callApi } from '../api/client.ts';
import { deviceLabel } from './device-label.ts';
import { SessionsCard, type SessionRow } from './sessions-card.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const row = (device: string, current: boolean): SessionRow => ({
  device,
  signedInAt: '2026-10-16T09:00:00Z',
  signedInLabel: '16 Oct 2026, 7:00 pm',
  lastActiveAt: '2026-10-16T10:00:00Z',
  lastActiveLabel: '16 Oct 2026, 8:00 pm',
  current,
});

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

describe('deviceLabel', () => {
  const t = createTranslator({ locale: 'en-AU', messages }) as unknown as Parameters<
    typeof deviceLabel
  >[0];

  it('names the browser and the system, never the raw code', () => {
    expect(deviceLabel(t, 'chrome.windows')).toBe('Chrome on Windows');
    expect(deviceLabel(t, 'safari.ios')).toBe('Safari on iPhone or iPad');
    expect(deviceLabel(t, 'other.android')).toBe('A browser on Android');
  });

  it('reads anything else as an unknown device', () => {
    for (const code of [null, 'other.other', 'netscape.windows', 'chrome', '<b>x</b>.windows']) {
      expect(deviceLabel(t, code)).toBe('Unknown device');
    }
  });
});

describe('SessionsCard', () => {
  it('lists the devices, marks this one, and offers to sign out of the others', () => {
    render(
      wrap(
        <SessionsCard
          rows={[row('Chrome on Windows', true), row('Safari on macOS', false)]}
          csrfToken="csrf"
        />,
      ),
    );
    expect(screen.getByText('Chrome on Windows')).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getByText('Active now')).toBeTruthy();
    expect(screen.getByText('16 Oct 2026, 8:00 pm').getAttribute('dateTime')).toBe(
      '2026-10-16T10:00:00Z',
    );
    expect(screen.getByRole('button', { name: 'Sign out of all other devices' })).toBeTruthy();
  });

  it('offers nothing to sign out when this is the only device', () => {
    render(wrap(<SessionsCard rows={[row('Chrome on Windows', true)]} csrfToken="csrf" />));
    expect(screen.getByText("You're signed in on this device only.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out of all other devices' })).toBeNull();
  });

  it('asks first, then signs out of the others and reads the list again', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { revokedSessions: 1 } });
    render(
      wrap(
        <SessionsCard
          rows={[row('Chrome on Windows', true), row('Safari on macOS', false)]}
          csrfToken="csrf"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of all other devices' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/The other device will have to sign in again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out others' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/admin/profile/sessions/sign-out-others',
      {},
      'csrf',
    );
    expect(screen.getByText('Signed out of 1 other device.')).toBeTruthy();
  });

  it('keeps the dialog open with the reason when it fails', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 503, code: 'access.unavailable' },
    } as never);
    render(
      wrap(
        <SessionsCard
          rows={[row('Chrome on Windows', true), row('Safari on macOS', false)]}
          csrfToken="csrf"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of all other devices' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out others' }));
    await waitFor(() =>
      expect(screen.getByText("We can't do that right now. Try again in a moment.")).toBeTruthy(),
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('says how long to wait when sign-out of the others is used too often', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 429,
        code: 'request.throttled',
        details: { retryAfterSeconds: 1500 },
      },
    } as never);
    render(
      wrap(
        <SessionsCard
          rows={[row('Chrome on Windows', true), row('Safari on macOS', false)]}
          csrfToken="csrf"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of all other devices' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out others' }));
    await waitFor(() =>
      expect(screen.getByText('Too many attempts. Try again in 25 minutes.')).toBeTruthy(),
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
