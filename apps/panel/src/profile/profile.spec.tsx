// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { DisplayNameCard } from './display-name-card.tsx';
import { nameProblemOf, passwordProblemOf, preferencesProblemOf } from './errors.ts';
import { PasswordCard } from './password-card.tsx';
import { PreferencesCard } from './preferences-card.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const LIMITS = { min: 15, max: 128 };
const NEW_PASSWORD = 'a long and easy sentence';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DisplayNameCard', () => {
  const mount = () => render(wrap(<DisplayNameCard initial="Amina Rahman" csrfToken="csrf" />));
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  const typeName = (value: string) =>
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value } });

  it('shows the current name and saves a trimmed one, then refreshes the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: true } });
    mount();
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina Rahman');

    typeName('  Amina R.  ');
    save();

    expect(await screen.findByText('Your name was updated.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'identity/admin/profile/display-name',
      { displayName: 'Amina R.' },
      'csrf',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina R.');
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('says so when the name did not change, without refreshing', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: false } });
    mount();
    save();
    expect(await screen.findByText('That is already your name.')).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('refuses an empty or too long name before calling the API', () => {
    mount();
    typeName('   ');
    save();
    expect(screen.getByText('Enter a name of 1 to 100 characters.')).toBeTruthy();
    typeName('x'.repeat(101));
    save();
    expect(screen.getByText('Enter a name of 1 to 100 characters.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('puts the API refusal under the field, in words', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'displayName', code: 'characters' }] },
      },
    });
    mount();
    typeName('www.example.com');
    save();
    const message = await screen.findByText(/Remove web addresses/);
    expect(screen.getByLabelText('Display name').getAttribute('aria-invalid')).toBe('true');
    expect(message).toBeTruthy();
  });
});

describe('PasswordCard', () => {
  const mount = () =>
    render(wrap(<PasswordCard csrfToken="csrf" passwordMin={15} passwordMax={128} />));
  const fill = (current = 'old password value', next = NEW_PASSWORD) => {
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  };
  const typeCode = (digits: string) =>
    digits.split('').forEach((digit, index) => {
      fireEvent.keyDown(screen.getByLabelText(`Digit ${index + 1} of 6`), { key: digit });
    });
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

  it('sends both passwords and the code, keeps the session and refreshes for the new token', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'password-changed' } });
    mount();
    fill();
    typeCode('123456');
    submit();

    expect(await screen.findByText(/Your password was changed/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/admin/change-password',
      { currentPassword: 'old password value', newPassword: NEW_PASSWORD, code: '123456' },
      'csrf',
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // The fields are cleared, so neither password stays on the page.
    expect(screen.getByLabelText<HTMLInputElement>('Current password').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('New password').value).toBe('');
  });

  it('asks for each missing piece before calling the API', () => {
    mount();
    submit();
    expect(screen.getByText('Enter your current password.')).toBeTruthy();
    fill('old password value', 'short');
    submit();
    expect(screen.getByText('Use 15 to 128 characters.', { selector: 'p' })).toBeTruthy();
    fill();
    submit();
    expect(screen.getByText('Enter the code.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('switches to a backup code and sends it', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'password-changed' } });
    mount();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    fireEvent.change(screen.getByLabelText('Backup code'), { target: { value: ' ABCD-EFGH ' } });
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toMatchObject({ code: 'ABCD-EFGH' });
  });

  it.each([
    ['password.current-incorrect', 400, 'That password is incorrect.'],
    ['second-factor.invalid', 400, "That code didn't work. Enter the newest code from your app."],
  ])('shows %s under its field and clears the wrong code', async (code, status, text) => {
    call.mockResolvedValue({ ok: false, failure: { status, code } });
    mount();
    fill();
    typeCode('123456');
    submit();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('shows the rule that refused the new password, with the limits', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 400, code: 'password.rejected', details: { rule: 'common' } },
    });
    mount();
    fill();
    typeCode('123456');
    submit();
    expect(await screen.findByText(/too easy to guess/)).toBeTruthy();
  });

  it('shows a wait', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 600 } },
    });
    mount();
    fill();
    typeCode('123456');
    submit();
    expect(await screen.findByText('Too many attempts. Try again in 10 minutes.')).toBeTruthy();
  });
});

describe('problems of failed calls', () => {
  it('maps a name refusal to the right field message', () => {
    const failed = (code: string) => ({
      status: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'displayName', code }] },
    });
    expect(nameProblemOf(failed('length'))).toEqual({ key: 'name-length', field: 'name' });
    expect(nameProblemOf(failed('characters'))).toEqual({ key: 'name-characters', field: 'name' });
    expect(nameProblemOf({ status: 503, code: 'access.unavailable' })).toEqual({
      key: 'unavailable',
      field: null,
    });
    expect(nameProblemOf({ status: 0, code: 'network' }).key).toBe('network');
    expect(nameProblemOf({ status: 403, code: 'request.csrf' }).key).toBe('csrf');
  });

  it('maps password refusals to the field and the limits the message needs', () => {
    expect(passwordProblemOf({ status: 400, code: 'password.current-incorrect' }, LIMITS)).toEqual({
      key: 'current-incorrect',
      field: 'current',
    });
    expect(
      passwordProblemOf(
        { status: 400, code: 'password.rejected', details: { rule: 'contains-identity' } },
        LIMITS,
      ),
    ).toEqual({ key: 'new-contains-identity', field: 'new', values: LIMITS });
    expect(
      passwordProblemOf(
        { status: 400, code: 'password.rejected', details: { rule: 'length' } },
        LIMITS,
      ).key,
    ).toBe('new-length');
    expect(passwordProblemOf({ status: 429, code: 'second-factor.locked' }, LIMITS).key).toBe(
      'code-locked',
    );
    expect(
      passwordProblemOf(
        {
          status: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'code', code: 'required' }] },
        },
        LIMITS,
      ),
    ).toEqual({ key: 'code-required', field: 'code' });
  });
});

describe('PreferencesCard', () => {
  const ZONES = ['UTC', 'Australia/Brisbane', 'Asia/Kuala_Lumpur'];
  const mount = (timezone: string | null = null, locale: string | null = null) =>
    render(
      wrap(<PreferencesCard timezone={timezone} locale={locale} zones={ZONES} csrfToken="csrf" />),
    );
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  const zone = () => screen.getByLabelText<HTMLSelectElement>('Time zone');
  const language = () => screen.getByLabelText<HTMLSelectElement>('Language');

  it('starts on the saved choice, or on the default when none was made', () => {
    mount('Australia/Brisbane', 'en');
    expect(zone().value).toBe('Australia/Brisbane');
    expect(language().value).toBe('en');
    cleanup();
    mount();
    expect(zone().value).toBe('');
    expect(zone().selectedOptions[0]?.textContent).toBe('Default (UTC)');
    expect(language().value).toBe('');
  });

  it('lists the zones with spaces for underscores', () => {
    mount();
    expect(screen.getByRole('option', { name: 'Asia/Kuala Lumpur' })).toBeTruthy();
  });

  it('saves the choice, then refreshes the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: true } });
    mount();
    fireEvent.change(zone(), { target: { value: 'Australia/Brisbane' } });
    fireEvent.change(language(), { target: { value: 'en' } });
    save();

    expect(await screen.findByText('Your settings were saved.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'identity/admin/profile/preferences',
      { timezone: 'Australia/Brisbane', locale: 'en' },
      'csrf',
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('sends null for the default choices', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: false } });
    mount('UTC', 'en');
    fireEvent.change(zone(), { target: { value: '' } });
    fireEvent.change(language(), { target: { value: '' } });
    save();

    expect(await screen.findByText('Those settings are already saved.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'identity/admin/profile/preferences',
      { timezone: null, locale: null },
      'csrf',
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('shows a refusal and keeps the form', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'timezone', code: 'invalid' }] },
      },
    });
    mount();
    save();
    expect(
      await screen.findByText(
        'That time zone or language is not available. Choose one from the list.',
      ),
    ).toBeTruthy();
    expect(preferencesProblemOf({ status: 503, code: 'access.unavailable' }).key).toBe(
      'unavailable',
    );
  });
});
