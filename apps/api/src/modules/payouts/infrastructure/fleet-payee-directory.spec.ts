import type { CallContext } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import { MAX_PAYEE_PROFILES, type PayeeProfile } from '../../fleet';
import { FleetPayeeDirectory } from './fleet-payee-directory';

describe.each(['AU', 'ZZ'])('FleetPayeeDirectory in market %s', (code) => {
  const context = testCallContext(
    testMarketContext(code, PLATFORM_TENANT_ID),
    'system',
    'payees-spec-0001',
  );
  const profile = (courierId: string): PayeeProfile => ({
    courierId,
    employmentType: 'contractor',
    taxRegistered: true,
    businessIdVerified: false,
  });

  it('maps fleet profiles to payees, and leaves out ids fleet does not know', async () => {
    const fleet = {
      payeeProfiles: jest.fn((_: CallContext, ids: readonly string[]) =>
        Promise.resolve(ids.filter((id) => id !== 'unknown').map(profile)),
      ),
    };

    const payees = await new FleetPayeeDirectory(fleet).payees(context, ['c-1', 'unknown', 'c-1']);

    expect([...payees.entries()]).toEqual([
      [
        'c-1',
        {
          courierId: 'c-1',
          engagement: 'contractor',
          taxRegistered: true,
          businessIdVerified: false,
        },
      ],
    ]);
    expect(fleet.payeeProfiles).toHaveBeenCalledWith(context, ['c-1', 'unknown']);
  });

  it("reads in batches of fleet's maximum, with the caller's context", async () => {
    const ids = Array.from({ length: MAX_PAYEE_PROFILES * 2 + 1 }, (_, i) => `c-${i}`);
    const fleet = {
      payeeProfiles: jest.fn((_: CallContext, batch: readonly string[]) =>
        Promise.resolve(batch.map(profile)),
      ),
    };

    const payees = await new FleetPayeeDirectory(fleet).payees(context, ids);

    expect(payees.size).toBe(ids.length);
    expect(fleet.payeeProfiles.mock.calls.map(([, batch]) => batch.length)).toEqual([
      MAX_PAYEE_PROFILES,
      MAX_PAYEE_PROFILES,
      1,
    ]);
    expect(fleet.payeeProfiles.mock.calls.every(([given]) => given === context)).toBe(true);
  });

  it('throws when fleet cannot read, rather than answering no payee', async () => {
    const fleet = {
      payeeProfiles: () => Promise.reject(new Error('fleet.payee-profiles.unavailable')),
    };

    await expect(new FleetPayeeDirectory(fleet).payees(context, ['c-1'])).rejects.toThrow(
      'fleet.payee-profiles.unavailable',
    );
  });
});
