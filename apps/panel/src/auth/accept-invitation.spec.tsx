// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AcceptInvitationFlow } from './accept-invitation-flow.tsx';

const call = vi.mocked(callApi);
const enrolment = {
  ok: true as const,
  status: 200,
  body: {
    code: 'invitation.enrolment-ready',
    secret: 'ABCDEFGHIJKLMNOP',
    otpauthUri: 'otpauth://totp/Mondapac Drive?secret=ABCDEFGHIJKLMNOP',
    tag: 'tag-1',
    expiresAt: '2026-10-09T14:00:00Z',
  },
};
const codes = ['AAAAA-BBBBB', 'CCCCC-DDDDD'];

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AcceptInvitationFlow passwordMin={12} passwordMax={128} />
    </NextIntlClientProvider>,
  );
}

function fail(code: string, details?: object) {
  return { ok: false as const, failure: { status: 400, code, ...(details ? { details } : {}) } };
}

async function fillDetails() {
  fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: ' Jo Admin ' } });
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: 'a long password!' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/accept-invitation#the-token');
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('admin accept invitation', () => {
  it('takes the token from the fragment, removes it from the address bar and shows the key', async () => {
    call.mockResolvedValueOnce(enrolment);
    mount();
    await fillDetails();
    expect(await screen.findByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', 'identity/admin/invitation/enrolment', {
      token: 'the-token',
    });
    expect(window.location.hash).toBe('');
  });

  it('shows "not usable" for a missing token and calls nothing', async () => {
    window.history.replaceState(null, '', '/accept-invitation');
    mount();
    expect(await screen.findByText("This invitation can't be used")).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows "not usable" when the invitation is rejected', async () => {
    call.mockResolvedValueOnce(fail('invitation.rejected'));
    mount();
    await fillDetails();
    expect(await screen.findByText("This invitation can't be used")).toBeTruthy();
  });

  it('asks for a name and a password before any request', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter your name.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts with the secret parts and the code, then shows the codes behind a checkbox', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'invitation.accepted', recoveryCodes: codes },
    });
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), {
      target: { value: '123 456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('AAAAA-BBBBB')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('POST', 'identity/admin/invitation/accept', {
      token: 'the-token',
      displayName: 'Jo Admin',
      password: 'a long password!',
      secret: 'ABCDEFGHIJKLMNOP',
      tag: 'tag-1',
      expiresAt: '2026-10-09T14:00:00Z',
      code: '123456',
    });
    const next = screen.getByRole('button', { name: 'Continue to sign in' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(next);
    expect(router.replace).toHaveBeenCalledWith('/sign-in?notice=account-ready');
  });

  it('shows a wrong code on the code field and keeps the key', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('second-factor.invalid'));
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    expect(screen.getByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
  });

  it('fetches a new key when the old one expired and says so', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('invitation.enrolment-expired'));
    call.mockResolvedValueOnce({
      ...enrolment,
      body: { ...enrolment.body, secret: 'ZZZZYYYYXXXXWWWW', tag: 'tag-2' },
    });
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('ZZZZ YYYY XXXX WWWW')).toBeTruthy();
    expect(screen.getByText(/That setup key expired/)).toBeTruthy();
  });

  it('goes back to the details with the password rule when the password is refused', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('password.rejected', { rule: 'common' }));
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That password is too easy to guess/)).toBeTruthy();
    expect(screen.getByLabelText('Your name')).toBeTruthy();
  });

  it('goes back to step 1 with a new-key notice when too many wrong codes were entered', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('second-factor.locked'));
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/Too many wrong codes. Start again/)).toBeTruthy();
    expect(screen.getByLabelText('Your name')).toBeTruthy();
    expect(screen.queryByText('ABCD EFGH IJKL MNOP')).toBeNull();
    // The heading takes focus in an effect, which can run after the text above is found.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Your details'));
  });

  it.each(['request.busy', 'access.unavailable'])('says to try again for %s', async (code) => {
    call.mockResolvedValueOnce(fail(code));
    mount();
    await fillDetails();
    expect(await screen.findByText(/Try again in a moment/)).toBeTruthy();
    expect(screen.getByLabelText('Your name')).toBeTruthy();
  });

  it('returns to step 1 when the new key cannot be fetched after an expiry', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('invitation.enrolment-expired'));
    call.mockResolvedValueOnce(fail('request.busy'));
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/Try again in a moment/)).toBeTruthy();
    expect(screen.queryByText('ABCD EFGH IJKL MNOP')).toBeNull();
  });

  it('shows a QR code above the key, drawn from the otpauth URI, and keeps the key as text', async () => {
    call.mockResolvedValueOnce(enrolment);
    mount();
    await fillDetails();
    const qr = await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100);
    expect(screen.getByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(qr.outerHTML).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('draws a bigger symbol for a longer address and keeps the quiet zone and plate', async () => {
    call.mockResolvedValueOnce(enrolment);
    mount();
    await fillDetails();
    const short = await screen.findByRole('img', { name: /QR code/ });
    const [, , shortSide] = (short.getAttribute('viewBox') ?? '').split(' ').map(Number);
    // A QR side is 17 + 4 * version modules, plus a 4-module quiet zone on each side.
    expect(((shortSide ?? 0) - 8 - 17) % 4).toBe(0);
    expect(short.parentElement?.getAttribute('style')).toContain('var(--mp-color-bg-qr)');
    expect(short.querySelector('path')?.getAttribute('style')).toContain(
      'var(--mp-color-bg-auth-showcase-admin)',
    );
    cleanup();
    window.history.replaceState(null, '', '/accept-invitation#the-token');
    call.mockResolvedValueOnce({
      ...enrolment,
      body: {
        ...enrolment.body,
        otpauthUri: `otpauth://totp/${'Ä'.repeat(40)}%20Shop:a@b.test?secret=ABCDEFGHIJKLMNOP&issuer=${'é'.repeat(40)}`,
      },
    });
    mount();
    await fillDetails();
    const long = await screen.findByRole('img', { name: /QR code/ });
    const [, , longSide] = (long.getAttribute('viewBox') ?? '').split(' ').map(Number);
    expect(longSide).toBeGreaterThan(shortSide ?? 0);
  });

  it('shows only the key when the address is too long to fit in a QR code', async () => {
    call.mockResolvedValueOnce({
      ...enrolment,
      body: { ...enrolment.body, otpauthUri: `otpauth://totp/x?secret=${'A'.repeat(5000)}` },
    });
    mount();
    await fillDetails();
    expect(await screen.findByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/Scan this code/)).toBeNull();
  });

  it('shows the key without a QR code when the address is not an otpauth one', async () => {
    call.mockResolvedValueOnce({
      ...enrolment,
      body: { ...enrolment.body, otpauthUri: 'https://example.test/x' },
    });
    mount();
    await fillDetails();
    expect(await screen.findByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('copies the setup key', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    call.mockResolvedValueOnce(enrolment);
    mount();
    await fillDetails();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCDEFGHIJKLMNOP'));
  });

  it('sends one accept request for a double click', async () => {
    call.mockResolvedValueOnce(enrolment);
    // Resolved up front: the accept call may start after the click handler returns, so a resolver
    // captured inside the mock could still be unset when the test releases it.
    let resolve: (value: ReturnType<typeof fail>) => void = () => undefined;
    const pending = new Promise<ReturnType<typeof fail>>((r) => (resolve = r));
    call.mockImplementationOnce(() => pending);
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    const verify = screen.getByRole('button', { name: 'Verify' });
    fireEvent.click(verify);
    fireEvent.click(verify);
    resolve(fail('second-factor.invalid'));
    await screen.findByText(/That code didn't work/);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps the token, the secret and the codes out of storage and the address bar', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'invitation.accepted', recoveryCodes: codes },
    });
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByText('AAAAA-BBBBB');
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    for (const secret of ['the-token', 'ABCDEFGHIJKLMNOP', 'AAAAA-BBBBB', 'a long password!'])
      expect(stored).not.toContain(secret);
    expect(window.location.href).not.toContain('the-token');
  });
});
