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
import { SignInFlow } from './sign-in-flow.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function signIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

function typeCode(digits: string) {
  digits.split('').forEach((digit, index) => {
    fireEvent.keyDown(screen.getByLabelText(`Digit ${index + 1} of 6`), { key: digit });
  });
}

describe('admin sign-in', () => {
  it('keeps the email, clears the password and says so after wrong credentials', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'credentials.invalid' } });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Email or password is incorrect. Check both and try again.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('a@example.com');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
  });

  it('offers no "keep me signed in" and no sign-up link', () => {
    render(wrap(<SignInFlow notice={null} />));
    expect(screen.queryByText(/keep me signed in/i)).toBeNull();
    expect(screen.queryByText(/create/i)).toBeNull();
  });

  it('asks for the code after the password and signs in with it', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    expect(await screen.findByText('Enter your 6-digit code')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'signed-in' } });
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(call).toHaveBeenLastCalledWith('POST', 'identity/admin/second-factor', {
      challengeToken: 'tok',
      code: '123456',
    });
  });

  it('shows a rejected code and switches to a backup code', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'second-factor.invalid' },
    });
    typeCode('000000');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    expect(screen.getByText('Enter a backup code')).toBeTruthy();
    expect(screen.getByLabelText('Backup code')).toBeTruthy();
  });

  it('goes back to the password step when the challenge ended', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'challenge.rejected' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.getByText(/Too many wrong codes. Sign in again/)).toBeTruthy();
  });

  it('shows the pause and disables Sign in when the second factor is locked', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 429, code: 'second-factor.locked', details: { retryAfterSeconds: 86400 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/paused for 24 hours/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(
        true,
      ),
    );
  });

  it('says a set-up link was mailed after a two-step reset', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-enrolment-required' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    expect(await screen.findByText(/We've sent a link to a@example.com/)).toBeTruthy();
  });

  it('disables Sign in while throttled and does not point at a reset link that is not there', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 120 } },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('2 minutes');
    expect(alert.textContent).not.toContain('reset your password');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(true);
  });

  it('removes spaces and hyphens from a backup code before sending it', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'signed-in' } });
    fireEvent.change(screen.getByLabelText('Backup code'), { target: { value: 'ab12-cd 34' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(call).toHaveBeenLastCalledWith('POST', 'identity/admin/second-factor', {
      challengeToken: 'tok',
      code: 'ab12cd34',
    });
  });

  describe('six-box code', () => {
    async function toCodeStep() {
      call.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { code: 'second-factor-required', challengeToken: 'tok' },
      });
      render(wrap(<SignInFlow notice={null} />));
      signIn();
      const heading = await screen.findByText('Enter your 6-digit code');
      // The new step's heading takes focus in an effect; wait for it so a later focus move is
      // not overtaken by that effect.
      await waitFor(() => expect(document.activeElement).toBe(heading));
    }
    const box = (position: number) =>
      screen.getByLabelText<HTMLInputElement>(`Digit ${position} of 6`);
    const secondFactorCalls = () =>
      call.mock.calls.filter(([, path]) => path === 'identity/admin/second-factor');

    it('labels the group and every box', async () => {
      await toCodeStep();
      expect(screen.getByRole('group', { name: '6-digit code' })).toBeTruthy();
      expect(screen.getAllByLabelText(/^Digit \d of 6$/)).toHaveLength(6);
    });

    it('moves focus on typing, Backspace and the arrow keys', async () => {
      await toCodeStep();
      fireEvent.keyDown(box(1), { key: '4' });
      expect(box(1).value).toBe('4');
      expect(document.activeElement).toBe(box(2));
      fireEvent.keyDown(box(2), { key: 'ArrowRight' });
      expect(document.activeElement).toBe(box(3));
      fireEvent.keyDown(box(3), { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(box(2));
      fireEvent.keyDown(box(2), { key: 'Backspace' });
      expect(document.activeElement).toBe(box(1));
      expect(box(1).value).toBe('');
      expect(secondFactorCalls()).toHaveLength(0);
    });

    it('fills every box from a pasted code and submits once', async () => {
      await toCodeStep();
      call.mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'signed-in' } });
      fireEvent.paste(box(3), { clipboardData: { getData: () => '123 456' } });
      await waitFor(() => expect(router.replace).toHaveBeenCalled());
      expect([1, 2, 3, 4, 5, 6].map((n) => box(n).value).join('')).toBe('123456');
      expect(secondFactorCalls()).toEqual([
        ['POST', 'identity/admin/second-factor', { challengeToken: 'tok', code: '123456' }],
      ]);
    });

    it('does not submit before the last digit', async () => {
      await toCodeStep();
      typeCode('12345');
      expect(secondFactorCalls()).toHaveLength(0);
    });

    it('clears the boxes and refocuses the first after a wrong code', async () => {
      await toCodeStep();
      call.mockResolvedValueOnce({
        ok: false,
        failure: { status: 400, code: 'second-factor.invalid' },
      });
      typeCode('000000');
      expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
      await waitFor(() => expect(box(1).value).toBe(''));
      expect([2, 3, 4, 5, 6].every((n) => box(n).value === '')).toBe(true);
      expect(document.activeElement).toBe(box(1));
    });
  });

  it('shows the notice banners and changes the title on the code step', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    const view = render(wrap(<SignInFlow notice="account-ready" />));
    expect(screen.getByText('Your account is ready. Sign in.')).toBeTruthy();
    signIn();
    await screen.findByText('Enter your 6-digit code');
    // The title is set in an effect, after the step renders.
    await waitFor(() =>
      expect(document.title).toBe('Two-step verification – Admin account – Mondapac Drive'),
    );
    view.unmount();
  });

  it('links to the forgot password page', () => {
    render(wrap(<SignInFlow notice={null} />));
    expect(screen.getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toBe(
      '/forgot-password',
    );
  });
});
