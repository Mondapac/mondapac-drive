import { parseId } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { ContactEmailOf } from './contact-email-of.use-case';

const accountId = (() => {
  const parsed = parseId('01990000-0000-7000-8000-0000000000a1');
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Account'>;
})();

describe.each([['AU'], ['ZZ']] as const)('identity.contact-email-of in market %s', (code) => {
  it('refuses a customer, a seller, an admin and an anonymous caller', async () => {
    const query = new ContactEmailOf(openGate(), undefined as never);
    await expectSystemOnly(code, (context) =>
      query.execute(context, { kind: 'customer', accountId }),
    );
  });
});
