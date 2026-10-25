import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { rowName } from './row-name.ts';

describe('rowName', () => {
  const t = createTranslator({ locale: 'en-AU', messages });

  it('starts with the visible label and names the row', () => {
    expect(rowName(t, 'Verify…', 'Driver licence')).toBe('Verify: Driver licence');
    expect(rowName(t, 'Settle', 'Noor Haddad')).toBe('Settle: Noor Haddad');
  });
});
