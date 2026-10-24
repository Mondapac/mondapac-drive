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
import { ForgotPasswordForm } from './forgot-password-form.tsx';
import { ResetPasswordForm } from './reset-password-form.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('admin forgot password', () => {
  it('asks the admin route for a link and says where it went, for any address', async () => {
    call.mockResolvedValue({ ok: true, status: 202, body: {} });
    render(wrap(<ForgotPasswordForm />));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' a@example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(
      await screen.findByText(/If an admin account uses a@example.com, we've sent a link/),
    ).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', 'identity/admin/password-reset-email', {
      email: 'a@example.com',
    });
  });

  it('shows an invalid email as a field error', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'email', code: 'format' }] },
      },
    });
    render(wrap(<ForgotPasswordForm />));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Enter an email address like name@example.com.')).toBeTruthy();
  });
});

describe('admin reset password', () => {
  const open = (hash: string) => {
    window.history.replaceState(null, '', `/reset-password${hash}`);
    render(wrap(<ResetPasswordForm passwordMin={12} passwordMax={128} />));
  };

  it('sends the token from the link fragment with the new password, then goes to sign-in', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    open('#tok123');
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a long enough phrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('POST', 'identity/admin/reset-password', {
        token: 'tok123',
        password: 'a long enough phrase',
      }),
    );
    expect(router.replace).toHaveBeenCalledWith('/sign-in?notice=password-changed');
    expect(window.location.hash).toBe('');
  });

  it('says the link cannot be used when there is none, or the API rejects it', async () => {
    open('');
    expect(await screen.findByText("This link can't be used")).toBeTruthy();
    cleanup();
    call.mockResolvedValue({ ok: false, failure: { status: 400, code: 'link.rejected' } });
    open('#old');
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'x'.repeat(14) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText("This link can't be used")).toBeTruthy();
  });

  it('shows the rule a rejected password broke', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 400, code: 'password.rejected', details: { rule: 'common' } },
    });
    open('#tok');
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'password1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(
      await screen.findByText('That password is too easy to guess. Choose a different one.'),
    ).toBeTruthy();
  });

  it.each([
    ['length', 'Use 12 to 128 characters.'],
    ['contains-identity', "Don't use your email or name in your password."],
  ])('shows the %s rule', async (rule, text) => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 400, code: 'password.rejected', details: { rule } },
    });
    open('#tok');
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says how long to wait when the reset is throttled, and when offline', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 600 } },
    });
    open('#tok');
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'x'.repeat(14) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('Too many attempts. Try again in 10 minutes.')).toBeTruthy();
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: 'network' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(
      await screen.findByText("You're offline or the connection dropped. Check it and try again."),
    ).toBeTruthy();
  });
});
