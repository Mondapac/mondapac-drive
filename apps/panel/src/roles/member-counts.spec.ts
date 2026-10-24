import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memberCounts } from './member-counts.ts';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../server/server-fetch.ts', () => ({ serverGet: mocks.get }));

const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000a2';
const account = (roleId: string | null, status: 'active' | 'disabled' = 'active') => ({
  type: 'account',
  status,
  role: roleId === null ? null : { roleId, kind: 'default', seedCode: null },
});

describe('memberCounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts active accounts per role across pages, not invitations or disabled accounts', async () => {
    mocks.get
      .mockResolvedValueOnce({
        kind: 'ok',
        body: { items: [account(A), account(A, 'disabled'), account(B)], next: 'p2' },
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        body: {
          items: [account(A), account(null), { type: 'invitation', role: { roleId: B } }],
          next: null,
        },
      });
    const counts = await memberCounts();
    expect(counts?.get(A)).toBe(2);
    expect(counts?.get(B)).toBe(1);
    expect(mocks.get).toHaveBeenNthCalledWith(2, 'identity/admin/team?after=p2');
  });

  it('gives up (null) when a page fails or the list never ends', async () => {
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    expect(await memberCounts()).toBeNull();
    mocks.get.mockResolvedValue({ kind: 'ok', body: { items: [], next: 'more' } });
    expect(await memberCounts()).toBeNull();
  });
});
