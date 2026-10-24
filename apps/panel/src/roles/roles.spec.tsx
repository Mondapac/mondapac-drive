// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { TeamTabs } from '../team/team-tabs.tsx';
import { RolesTable } from './roles-table.tsx';
import { RoleView } from './role-view.tsx';
import { groupByResource, humanise } from './role-name.ts';
import type { RoleCatalogue, RoleRecord } from './types.ts';

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));

const allowed = { allowed: true, code: null };
const role = (over: Partial<RoleRecord>): RoleRecord => ({
  roleId: '0190a000-0000-7000-8000-0000000000a1',
  kind: 'system',
  seedCode: 'platform-administrator',
  name: null,
  permissionCount: 3,
  permissionKeys: [],
  grantable: true,
  version: 1,
  actions: { edit: allowed, delete: allowed },
  ...over,
});
const catalogue: RoleCatalogue = {
  items: [],
  keys: [
    { key: 'identity.admin-account.view', protected: false, grantable: true },
    { key: 'identity.admin-account.invite', protected: false, grantable: true },
    { key: 'identity.platform-role.manage', protected: true, grantable: false },
  ],
};

describe('admin roles', () => {
  afterEach(cleanup);

  it('groups the roles by type, with counts and a way to view each', async () => {
    const roles = [
      role({}),
      role({
        roleId: '0190a000-0000-7000-8000-0000000000a2',
        kind: 'default',
        seedCode: 'operator',
        permissionCount: 2,
      }),
      role({
        roleId: '0190a000-0000-7000-8000-0000000000a3',
        kind: 'custom',
        seedCode: null,
        name: 'Night shift',
        permissionCount: 0,
      }),
    ];
    render(await RolesTable({ roles }));
    expect(screen.getByRole('heading', { name: 'System' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Default' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Custom' })).toBeTruthy();
    expect(screen.getByText('All')).toBeTruthy();
    expect(screen.getByText('2 permissions')).toBeTruthy();
    expect(screen.getByText('None yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit Night shift' }).getAttribute('href')).toBe(
      '/roles/0190a000-0000-7000-8000-0000000000a3',
    );
  });

  it('gives every group the same fixed columns, one per header', async () => {
    const roles = [
      role({}),
      role({
        roleId: '0190a000-0000-7000-8000-0000000000a2',
        kind: 'default',
        seedCode: 'operator',
      }),
      role({
        roleId: '0190a000-0000-7000-8000-0000000000a3',
        kind: 'custom',
        seedCode: null,
        name: 'Night shift',
      }),
    ];
    for (const members of [new Map<string, number>(), null]) {
      const { container } = render(await RolesTable({ roles, members }));
      const tables = [...container.querySelectorAll('table')];
      expect(tables).toHaveLength(3);
      const layouts = tables.map((table) => {
        expect(table.className).toContain('table-fixed');
        const cols = [...table.querySelectorAll('col')].map((col) => col.className);
        expect(cols).toHaveLength(table.querySelectorAll('th').length);
        return cols.join(' ');
      });
      expect(new Set(layouts).size).toBe(1);
      cleanup();
    }
  });

  it('shows a Members column only when counts are given', async () => {
    const r = role({});
    render(await RolesTable({ roles: [r], members: new Map([[r.roleId, 2]]) }));
    expect(screen.getByRole('columnheader', { name: 'Members' })).toBeTruthy();
    expect(screen.getByText('2 admins')).toBeTruthy();
    cleanup();
    render(await RolesTable({ roles: [r], members: new Map() }));
    expect(screen.getByText('None')).toBeTruthy();
    cleanup();
    render(await RolesTable({ roles: [r], members: null }));
    expect(screen.queryByRole('columnheader', { name: 'Members' })).toBeNull();
  });

  it('offers View when a custom role cannot be edited, and Duplicate on the view', async () => {
    const locked = role({
      kind: 'custom',
      seedCode: null,
      name: 'Held',
      actions: { edit: { allowed: false, code: 'access.denied' }, delete: allowed },
    });
    render(await RolesTable({ roles: [locked] }));
    expect(screen.getByRole('link', { name: 'View Held' })).toBeTruthy();
    cleanup();
    render(await RoleView({ role: locked, catalogue, canDuplicate: true }));
    expect(screen.getByRole('link', { name: 'Duplicate' }).getAttribute('href')).toBe(
      `/roles/new?from=${locked.roleId}`,
    );
  });

  it('says when there are no custom roles yet', async () => {
    render(await RolesTable({ roles: [role({})] }));
    expect(screen.getByText('No custom roles yet')).toBeTruthy();
  });

  it('shows a system role read-only with every permission of the scope', async () => {
    render(await RoleView({ role: role({}), catalogue }));
    expect(screen.getByRole('heading', { name: 'Platform Administrator' })).toBeTruthy();
    expect(
      screen.getByText(
        "System role. It always has every permission in this panel and can't be changed or deleted.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Protected')).toBeTruthy();
  });

  it('shows a custom role by name with its own permissions and no read-only banner', async () => {
    render(
      await RoleView({
        role: role({
          kind: 'custom',
          seedCode: null,
          name: 'Night shift',
          permissionKeys: ['identity.admin-account.view'],
          permissionCount: 1,
        }),
        catalogue,
      }),
    );
    expect(screen.getByRole('heading', { name: 'Night shift' })).toBeTruthy();
    expect(screen.queryByText(/can't be changed/)).toBeNull();
    expect(screen.getByText('1 of 3 permissions selected')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows a default role with its banner and the Default type', async () => {
    render(
      await RoleView({
        role: role({
          kind: 'default',
          seedCode: 'operator',
          permissionKeys: ['identity.admin-account.view'],
          permissionCount: 1,
        }),
        catalogue,
      }),
    );
    expect(screen.getByText("Default role from Mondapac Drive. It can't be changed.")).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.queryByText('Protected')).toBeNull();
  });

  it('marks a protected permission of a custom role', async () => {
    render(
      await RoleView({
        role: role({
          kind: 'custom',
          seedCode: null,
          name: 'Ops',
          permissionKeys: ['identity.platform-role.manage'],
          permissionCount: 1,
        }),
        catalogue,
      }),
    );
    expect(screen.getByText('Protected')).toBeTruthy();
  });

  it('falls back to the generic custom name when the name is missing or blank', async () => {
    render(
      await RoleView({ role: role({ kind: 'custom', seedCode: null, name: '  ' }), catalogue }),
    );
    expect(screen.getByRole('heading', { name: 'Custom role' })).toBeTruthy();
  });

  it('shows the empty custom group when the API returns no roles at all', async () => {
    render(await RolesTable({ roles: [] }));
    expect(screen.getByText('No custom roles yet')).toBeTruthy();
  });

  it('never shows a raw seed code or the role name as markup', async () => {
    render(
      await RoleView({
        role: role({ kind: 'custom', seedCode: null, name: '<b>x</b>', permissionKeys: [] }),
        catalogue,
      }),
    );
    expect(screen.getByRole('heading', { name: '<b>x</b>' })).toBeTruthy();
    expect(document.querySelector('h1 b')).toBeNull();
  });

  it('groups keys by resource and humanises a name without a copy key', () => {
    expect(groupByResource(['b.x.two', 'a.y.one', 'b.x.one'])).toEqual([
      ['a.y', ['a.y.one']],
      ['b.x', ['b.x.one', 'b.x.two']],
    ]);
    expect(humanise('admin-account')).toBe('Admin account');
  });

  it('marks the current tab and shows no tabs without labels', () => {
    const labels = {
      nav: messages.identity.members.tab.label,
      admins: messages.identity.members.tab.admins,
      roles: messages.identity.members.tab.roles,
    };
    const { rerender } = render(<TeamTabs active="roles" labels={labels} />);
    expect(screen.getByRole('link', { name: 'Roles' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Admins' }).getAttribute('aria-current')).toBeNull();
    rerender(<TeamTabs active="admins" labels={null} />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
