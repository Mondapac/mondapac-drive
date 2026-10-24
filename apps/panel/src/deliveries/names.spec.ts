import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/server-fetch.ts', () => ({ serverGet: vi.fn() }));

import { serverGet } from '../server/server-fetch.ts';
import { namesFor } from './names.ts';

const get = vi.mocked(serverGet);
const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';
const account = (accountId: string, status: string) => ({
  type: 'account',
  accountId,
  email: `${accountId}@example.test`,
  displayName: null,
  status,
});

beforeEach(() => vi.clearAllMocks());

describe('namesFor', () => {
  it('reads every page of couriers, so later couriers reach the dispatch picker', async () => {
    get
      .mockResolvedValueOnce({
        kind: 'ok',
        body: { items: [account(A, 'active')], next: A },
      } as never)
      .mockResolvedValueOnce({
        kind: 'ok',
        body: { items: [account(B, 'active')], next: null },
      } as never);

    const names = await namesFor(new Set(['identity.courier-account.view']));

    expect(get.mock.calls.map(([path]) => path)).toEqual([
      'identity/admin/couriers?limit=100',
      `identity/admin/couriers?limit=100&after=${A}`,
    ]);
    expect(names.activeCouriers.map((row) => row.accountId)).toEqual([A, B]);
  });

  it('reads nothing without the keys', async () => {
    const names = await namesFor(new Set());
    expect(get).not.toHaveBeenCalled();
    expect(names.couriers.size).toBe(0);
  });
});
