import { describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { adminNav } from './nav.ts';

describe('admin nav', () => {
  it('has a label and a Home shortcut sentence for every item', () => {
    const nav: Record<string, string> = messages.nav;
    const home: Record<string, string> = messages.home;
    for (const item of adminNav.items) {
      expect(nav[item.labelKey.replace(/^nav\./, '')], item.id).toBeTypeOf('string');
      if (item.id !== 'home') expect(home[item.id], item.id).toBeTypeOf('string');
    }
  });
});
