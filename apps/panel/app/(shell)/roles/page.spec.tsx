// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import RolesPageRoute from './page.tsx';
import RolePageRoute from './[roleId]/page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  counts: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/roles/member-counts.ts', () => ({ memberCounts: mocks.counts }));
vi.mock('../../../src/roles/roles-table.tsx', () => ({
  RolesTable: ({
    roles,
    members,
  }: {
    readonly roles: readonly { readonly roleId: string }[];
    readonly members?: ReadonlyMap<string, number> | null;
  }) => (
    <ul data-members={members === null ? 'none' : 'counts'}>
      {roles.map((role) => (
        <li key={role.roleId}>role {role.roleId}</li>
      ))}
    </ul>
  ),
}));
vi.mock('../../../src/roles/role-view.tsx', () => ({
  RoleView: ({ role }: { readonly role: { readonly roleId: string } }) => (
    <h1>view {role.roleId}</h1>
  ),
}));
vi.mock('../../../src/roles/roles-page-gate.tsx', () => ({
  RolesNoAccess: () => <p>No access</p>,
}));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const VIEW = 'identity.platform-role.view';
const ID = '0190a000-0000-7000-8000-0000000000a1';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const catalogue = {
  items: [
    {
      roleId: ID,
      kind: 'default',
      seedCode: 'operator',
      name: null,
      permissionCount: 1,
      permissionKeys: ['identity.admin-account.view'],
      grantable: true,
      version: 1,
      actions: {
        edit: { allowed: false, code: 'role.read-only' },
        delete: { allowed: false, code: 'role.read-only' },
      },
    },
  ],
  keys: [{ key: 'identity.admin-account.view', protected: false, grantable: true }],
};

describe('admin roles pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
    mocks.get.mockResolvedValue({ kind: 'ok', body: catalogue });
    mocks.counts.mockResolvedValue(new Map());
  });
  afterEach(cleanup);

  it('shows no-access without calling the API when the view permission is missing', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await RolesPageRoute());
    expect(screen.getByText('No access')).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('lists the roles from the catalogue', async () => {
    render(await RolesPageRoute());
    expect(mocks.get).toHaveBeenCalledWith('identity/admin/roles');
    expect(screen.getByText(`role ${ID}`)).toBeTruthy();
  });

  it('reads member counts only with the team view permission', async () => {
    const { container } = render(await RolesPageRoute());
    expect(mocks.counts).not.toHaveBeenCalled();
    expect(container.querySelector('ul')?.getAttribute('data-members')).toBe('none');
    cleanup();
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([VIEW, 'identity.admin-account.view']),
    });
    const withTeam = render(await RolesPageRoute());
    expect(mocks.counts).toHaveBeenCalledTimes(1);
    expect(withTeam.container.querySelector('ul')?.getAttribute('data-members')).toBe('counts');
  });

  it('offers a retry when the roles cannot be loaded', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await RolesPageRoute());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('sends a rejected session to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(RolesPageRoute()).rejects.toThrow('redirect:/session-ended');
  });

  it('shows a role, and not-found for an id that is not in the catalogue', async () => {
    render(await RolePageRoute({ params: Promise.resolve({ roleId: ID }) }));
    expect(screen.getByRole('heading', { name: `view ${ID}` })).toBeTruthy();
    cleanup();
    await expect(
      RolePageRoute({ params: Promise.resolve({ roleId: 'someone-elses' }) }),
    ).rejects.toThrow('not-found');
  });

  it('says something went wrong when the API is unavailable', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await RolesPageRoute());
    expect(screen.getByText(messages.identity.error.unknown)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('keeps a custom role name out of the document title', async () => {
    const { generateMetadata } = await import('./[roleId]/page.tsx');
    expect(await generateMetadata()).toEqual({ title: 'Roles & permissions' });
  });
});
