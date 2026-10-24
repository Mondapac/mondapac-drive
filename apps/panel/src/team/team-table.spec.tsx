// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { TeamTable } from './team-table.tsx';
import type { AccountRow, InvitationRow, TeamPage } from './types.ts';

vi.mock('./row-actions.tsx', () => ({ RowActions: () => null }));
vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));

const hint = { allowed: true, code: null };
const account = (over: Partial<AccountRow>): AccountRow => ({
  type: 'account',
  accountId: '0190a000-0000-7000-8000-000000000001',
  email: 'ada@example.test',
  displayName: 'Ada Admin',
  status: 'active',
  self: false,
  role: {
    roleId: '0190a000-0000-7000-8000-0000000000a1',
    kind: 'system',
    seedCode: 'platform-administrator',
  },
  actions: { changeRole: hint, disable: hint, enable: hint, resetSecondFactor: hint },
  ...over,
});
const invitation = (over: Partial<InvitationRow>): InvitationRow => ({
  type: 'invitation',
  invitationId: '0190a000-0000-7000-8000-000000000002',
  email: 'new@example.test',
  role: { roleId: '0190a000-0000-7000-8000-0000000000a2', kind: 'default', seedCode: 'operator' },
  invitedByAccountId: null,
  status: 'pending',
  createdAt: '2026-10-08T00:00:00Z',
  expiresAt: null,
  actions: { resend: hint, revoke: hint },
  ...over,
});

async function show(page: TeamPage, after: string | null = null) {
  render(await TeamTable({ page, after, csrfToken: 'csrf' }));
}

describe('admin team table', () => {
  afterEach(cleanup);

  it('lists people, roles and statuses, and marks the own row', async () => {
    await show({
      items: [
        account({ self: true }),
        account({
          accountId: '0190a000-0000-7000-8000-000000000003',
          email: 'off@example.test',
          displayName: null,
          status: 'disabled',
          role: { roleId: '0190a000-0000-7000-8000-0000000000a3', kind: 'custom', seedCode: null },
        }),
        invitation({}),
        invitation({
          invitationId: '0190a000-0000-7000-8000-000000000005',
          role: {
            roleId: '0190a000-0000-7000-8000-0000000000a5',
            kind: 'default',
            seedCode: 'new-seed',
          },
        }),
        invitation({
          invitationId: '0190a000-0000-7000-8000-000000000004',
          status: 'expired',
          role: null,
        }),
      ],
      next: null,
    });
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(screen.getByRole('table', { name: 'Admins and pending invitations' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Person',
      'Role',
      'Status',
      'Actions',
    ]);
    expect(within(rows[1]!).getByText('(system role)')).toBeTruthy();
    expect(within(rows[1]!).getByText('You')).toBeTruthy();
    expect(within(rows[1]!).getByText('Platform Administrator')).toBeTruthy();
    expect(within(rows[1]!).getByText('Active')).toBeTruthy();
    expect(within(rows[2]!).getByText('off@example.test')).toBeTruthy();
    expect(within(rows[2]!).getByText('Custom role')).toBeTruthy();
    expect(within(rows[2]!).getByText('Deactivated')).toBeTruthy();
    expect(within(rows[3]!).getByText('Operator')).toBeTruthy();
    expect(within(rows[3]!).getByText('Invited')).toBeTruthy();
    // A seeded role without a copy key yet reads "Role", never its code.
    expect(within(rows[4]!).getByText('Role')).toBeTruthy();
    expect(within(rows[5]!).getByText('Invitation expired')).toBeTruthy();
    expect(within(rows[5]!).getByText('No role')).toBeTruthy();
  });

  it('says it is just the actor so far on an empty first page only', async () => {
    await show({ items: [], next: null });
    expect(screen.getByText("It's just you so far")).toBeTruthy();
    cleanup();
    await show({ items: [], next: null }, '0190a000-0000-7000-8000-000000000009');
    expect(screen.queryByText("It's just you so far")).toBeNull();
    expect(screen.getByText('There is nobody on this page.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
