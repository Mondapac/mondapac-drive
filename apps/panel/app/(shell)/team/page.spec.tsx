// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import type { ServerGet } from '../../../src/server/server-fetch.ts';
import type { TeamPage } from '../../../src/team/types.ts';
import TeamPageRoute from './page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/team/team-table.tsx', () => ({ TeamTable: () => <table /> }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const VIEW = 'identity.admin-account.view';
const ID = '0190a000-0000-7000-8000-000000000009';
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
const page = (next: string | null): TeamPage => ({ items: [], next });

async function show(after?: string | string[]) {
  render(await TeamPageRoute({ searchParams: Promise.resolve({ after }) }));
}

describe('admin team page', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  });
  afterEach(cleanup);

  it('shows the no-access state, with a way home, and does not call the API', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    await show();
    expect(screen.getByText("You don't have access to this page")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('asks for the first page without a valid cursor, and ignores a malformed or repeated one', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: page(null) } satisfies ServerGet<TeamPage>);
    await show('not-a-uuid');
    cleanup();
    await show([ID, ID]);
    expect(mocks.get).toHaveBeenNthCalledWith(1, 'identity/admin/team');
    expect(mocks.get).toHaveBeenNthCalledWith(2, 'identity/admin/team');
  });

  it('passes a valid cursor and links to the next page only when there is one', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: page(ID) } satisfies ServerGet<TeamPage>);
    await show(ID);
    expect(mocks.get).toHaveBeenCalledWith(`identity/admin/team?after=${ID}`);
    expect(screen.getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      `/team?after=${ID}`,
    );
    cleanup();
    mocks.get.mockResolvedValue({ kind: 'ok', body: page(null) });
    await show();
    expect(screen.queryByRole('link', { name: 'Next page' })).toBeNull();
  });

  it('sends a rejected session to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(show()).rejects.toThrow('redirect:/session-ended');
  });

  it('says something went wrong when the API is unavailable', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    await show();
    expect(screen.getByText(messages.identity.error.unknown)).toBeTruthy();
  });
});
