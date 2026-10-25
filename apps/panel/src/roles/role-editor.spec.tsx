// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { RoleEditor } from './role-editor.tsx';
import type { RoleCatalogue, RoleRecord } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000a3';
const allowed = { allowed: true, code: null };
const catalogue: RoleCatalogue = {
  items: [],
  keys: [
    { key: 'identity.admin-account.view', protected: false, grantable: true },
    { key: 'identity.admin-account.invite', protected: false, grantable: true },
    { key: 'identity.platform-role.manage', protected: true, grantable: false },
  ],
};
const custom: RoleRecord = {
  roleId: ID,
  kind: 'custom',
  seedCode: null,
  name: 'Night shift',
  permissionCount: 1,
  permissionKeys: ['identity.admin-account.view'],
  grantable: true,
  version: 2,
  actions: { edit: allowed, delete: allowed },
};

function mount(props: Partial<React.ComponentProps<typeof RoleEditor>> = {}) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RoleEditor
        catalogue={catalogue}
        csrfToken="csrf-1"
        initialName=""
        initialKeys={[]}
        {...props}
      />
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

describe('role editor', () => {
  it('creates a role with the chosen keys and opens it', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 201,
      body: { code: 'role.created', roleId: ID },
    });
    mount();
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: '  Night shift ' } });
    fireEvent.click(screen.getByLabelText('Invite admins'));
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/roles/${ID}`));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/admin/roles',
      { name: 'Night shift', permissionKeys: ['identity.admin-account.invite'] },
      'csrf-1',
    );
  });

  it('warns when dispatch is chosen without the courier view key', () => {
    mount({
      catalogue: {
        items: [],
        keys: [
          { key: 'delivery.delivery.dispatch', protected: false, grantable: true },
          { key: 'identity.courier-account.view', protected: false, grantable: true },
        ],
      },
      initialKeys: ['delivery.delivery.dispatch'],
    });
    const warning = /needs “View courier accounts” too/;
    expect(screen.getByText(warning)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('View courier accounts'));
    expect(screen.queryByText(warning)).toBeNull();
  });

  it('asks for a name before calling the API', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByText('Enter a name for the role.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a key the admin may not give as locked, and a protected one with its note', () => {
    mount();
    const locked = screen.getByLabelText<HTMLInputElement>('Manage');
    expect(locked.disabled).toBe(true);
    expect(
      screen.getByText('Protected. Only a Platform Administrator can give this.'),
    ).toBeTruthy();
  });

  it('saves an edit with PUT and shows the saved status', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'role.updated', roleId: ID },
    });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    expect(screen.getByLabelText<HTMLInputElement>('View the team').checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Invite admins'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved\./)).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `identity/admin/roles/${ID}`,
      {
        name: 'Night shift',
        permissionKeys: ['identity.admin-account.invite', 'identity.admin-account.view'],
      },
      'csrf-1',
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it('puts a taken name on the name field', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'role.name-taken' } });
    mount({ initialName: 'Ops' });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByText('Another custom role already has this name.')).toBeTruthy();
  });

  it('explains a role that is still held, and deletes after confirmation', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'role.in-use' } });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete role' }).at(-1)!);
    expect(
      await screen.findByText(
        'Someone still has this role. Give them another role, then delete it.',
      ),
    ).toBeTruthy();
    expect(call).toHaveBeenCalledWith('DELETE', `identity/admin/roles/${ID}`, undefined, 'csrf-1');
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'role.deleted', roleId: ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete role' }).at(-1)!);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/roles'));
  });

  it('hides delete when the API says it is not allowed, and ends the session on 401', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount({
      role: {
        ...custom,
        actions: { edit: allowed, delete: { allowed: false, code: 'role.in-use' } },
      },
      initialName: 'Night shift',
      initialKeys: [],
    });
    expect(screen.queryByRole('button', { name: 'Delete role' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });
});
