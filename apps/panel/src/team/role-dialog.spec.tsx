// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { InviteAdminButton } from './invite-admin-button.tsx';
import { NoticeProvider } from './notice.tsx';
import { RowActions } from './row-actions.tsx';
import type { PlatformRole } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const ok = { allowed: true, code: null };
const roles: PlatformRole[] = [
  {
    roleId: 'r-current',
    kind: 'default',
    seedCode: 'operator',
    permissionCount: 4,
    grantable: true,
  },
  {
    roleId: 'r-finance',
    kind: 'default',
    seedCode: 'dispatcher',
    permissionCount: 12,
    grantable: true,
  },
  {
    roleId: 'r-admin',
    kind: 'system',
    seedCode: 'platform-administrator',
    permissionCount: 40,
    grantable: false,
  },
];

function wrap(node: React.ReactNode) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>{node}</NoticeProvider>
    </NextIntlClientProvider>,
  );
}

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

const row = (roleList: readonly PlatformRole[] | null = roles) =>
  wrap(
    <RowActions
      target={{
        kind: 'account',
        id: ID,
        name: 'Ada Admin',
        status: 'active',
        roleId: 'r-current',
        hints: { changeRole: ok, disable: ok, enable: ok, resetSecondFactor: ok },
      }}
      csrfToken="csrf-1"
      roles={roleList ?? undefined}
    />,
  );
const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Ada Admin' }));

describe('change role (D2)', () => {
  it('lists the roles without the current one, disables ungrantable roles with the reason', () => {
    row();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual([
      'Choose a role',
      'Dispatcher · 12 permissions',
      "Platform Administrator · 40 permissions · you can't give this role",
    ]);
    expect(
      screen.getByRole<HTMLOptionElement>('option', { name: /Platform Administrator/ }).disabled,
    ).toBe(true);
  });

  it('sends the chosen role with the csrf token and says it applies from their next action', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    row();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/accounts/${ID}/role`,
        { roleId: 'r-finance' },
        'csrf-1',
      ),
    );
    expect(
      await screen.findByText(/role is changed\. It applies from their next action/),
    ).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('asks for a role first and sends nothing', () => {
    row();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(screen.getByText('Choose a role.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a refusal in the dialog and keeps it open', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'role.not-grantable' } });
    row();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(await screen.findByText("You can't give that role.")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('shows the current role', () => {
    row();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    expect(screen.getByText('Current role: Operator')).toBeTruthy();
  });

  const submitFinance = () => {
    row();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
  };

  it('starts clean after a cancel', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'role.not-grantable' } });
    submitFinance();
    await screen.findByText("You can't give that role.");
    fireEvent.click(screen.getByRole('button', { name: 'Keep as it is' }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    expect(screen.queryByText("You can't give that role.")).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>('Role').value).toBe('');
  });

  it('closes, tells them and reloads when the role vanished meanwhile', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'role.unknown' } });
    submitFinance();
    expect(await screen.findByText(/That role no longer exists/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('goes to the signed-out page on a 401', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.required' } });
    submitFinance();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('sends once when the button is pressed twice', () => {
    call.mockReturnValue(new Promise(() => undefined));
    submitFinance();
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('is left out when the actor has no role list', () => {
    row(null);
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Change role' })).toBeNull();
  });
});

describe('invite admin (D1)', () => {
  const open = () => {
    wrap(<InviteAdminButton roles={roles} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Invite admin' }));
  };

  it('sends the address and role and shows the same toast', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: { code: 'invitation.issued' } });
    open();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' new@example.test ' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
    expect(screen.getByText(/The link works for 72 hours/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'identity/admin/invitations',
        { email: 'new@example.test', roleId: 'r-finance' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Invitation sent to new@example.test.')).toBeTruthy();
  });

  it('checks the fields before sending', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByText('Enter your email.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByText('Choose a role.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows an email format error from the API and an already-pending invitation', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'email', code: 'format' }] },
      },
    });
    open();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Enter an email address like name@example.com.')).toBeTruthy();
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'invitation.already-pending' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(
      await screen.findByText('This person already has an invitation. Resend it from the list.'),
    ).toBeTruthy();
  });

  it('starts clean after a cancel and reloads when the role is not grantable', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'role.not-grantable' } });
    open();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'x@y.test' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByText("You can't give that role.");
    expect(router.refresh).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite admin' }));
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('');
    expect(screen.queryByText("You can't give that role.")).toBeNull();
  });

  it('shows its own message when the address cannot be invited', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'account.exists' } });
    open();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'x@y.test' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/That address can't be invited/)).toBeTruthy();
  });
});
