import { comparablePassword } from '../../domain/password-policy';
import { CheckedInCommonPasswords } from './checked-in-common-passwords';
import { COMMON_PASSWORDS } from './common-passwords.data';

describe('the checked-in common-password list (identity design 6.5)', () => {
  const list = new CheckedInCommonPasswords();

  it('holds only entries the length rule cannot refuse, in the compared form, sorted and unique', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(300);
    for (const entry of COMMON_PASSWORDS) {
      expect([...entry].length).toBeGreaterThanOrEqual(15);
      expect(comparablePassword(entry)).toBe(entry);
    }
    expect([...new Set(COMMON_PASSWORDS)].sort()).toEqual(COMMON_PASSWORDS);
  });

  it("holds no entry with '@' (an e-mail address, not a password; Hassan I1)", () => {
    expect(COMMON_PASSWORDS.filter((entry) => entry.includes('@'))).toEqual([]);
  });

  it('finds a known long common password in any case', () => {
    expect(list.isCommon(comparablePassword('1QAZ2WSX3EDC4RFV'))).toBe(true);
    expect(list.isCommon(comparablePassword('123456789qwerty'))).toBe(true);
  });

  it('does not refuse an ordinary passphrase', () => {
    expect(list.isCommon(comparablePassword('lantern harbour biscuit'))).toBe(false);
  });
});
