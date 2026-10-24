import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseId } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import { accountRoleAssigned, AccountRoleAssigned } from './index';

// `identity.account-role.assigned` (PA 5 row 6b): the scope of the role, never a merchant id (the
// merchant of a merchant's integration account is in its own audit row). The ids are Market-free,
// so one fixture covers both Markets.

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>('01990000-0000-7000-8000-000000000001');
const ROLE = id<'Role'>('01990000-0000-7000-8000-0000000000a1');
const common = { accountId: ACCOUNT, boundSubjectId: ACCOUNT, roleId: ROLE, founding: true };

describe('accountRoleAssigned (identity.account-role.assigned)', () => {
  it('declares no merchant or seller field', () => {
    expect(Object.keys(AccountRoleAssigned.after ?? {}).sort()).toEqual([
      'accountId',
      'boundSubjectId',
      'founding',
      'roleId',
      'scope',
    ]);
  });

  it.each(['platform', 'merchant', 'courier'] as const)('names the %s scope', (scope) => {
    expect(accountRoleAssigned(ACCOUNT, { ...common, scope })).toEqual(
      expect.objectContaining({
        action: 'identity.account-role.assigned',
        targetId: ACCOUNT,
        after: expect.objectContaining({ scope }) as unknown,
      }),
    );
  });
});

// Hassan I-7 (7a round-1 review): the scope rule above holds only if no code builds the entry
// around the builder. Every TypeScript file of the API's source (specs included) is scanned for
// a member access to `AccountRoleAssigned.entry`; only this module's audit catalogue may hold one.
describe('AccountRoleAssigned.entry is reached only through accountRoleAssigned (Hassan I-7)', () => {
  const sourceRoot = path.resolve(__dirname, '../../../..');
  const catalogue = path.resolve(__dirname, 'index.ts');
  const ENTRY =
    /\bAccountRoleAssigned\s*(?:\?\.|\.)\s*entry\b|\bAccountRoleAssigned\s*\[\s*['"`]entry/;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('finds the builder in the catalogue and nowhere else', () => {
    const files = sources(sourceRoot);
    expect(files).toContain(catalogue);
    const offenders = files.filter(
      // This spec names the forms on purpose, as strings.
      (file) => file !== catalogue && file !== __filename && ENTRY.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
    expect(ENTRY.test(readFileSync(catalogue, 'utf8'))).toBe(true);
  });

  it('would catch the forms of a bypass', () => {
    for (const bypass of [
      'AccountRoleAssigned.entry(id, { after })',
      'AccountRoleAssigned ?. entry(id, x)',
      "AccountRoleAssigned['entry'](id, x)",
    ]) {
      expect(ENTRY.test(bypass)).toBe(true);
    }
    expect(ENTRY.test('accountRoleAssigned(id, after)')).toBe(false);
  });
});
