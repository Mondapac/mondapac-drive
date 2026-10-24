import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/server/bff.ts', () => ({ relay: vi.fn() }));

import * as route from './route.ts';

describe('relay route', () => {
  // Next.js answers 405 to a method the route does not export; the setup saves use PUT.
  it('exports every method the allowlist uses', () => {
    expect(typeof route.GET).toBe('function');
    expect(typeof route.POST).toBe('function');
    expect(typeof route.PUT).toBe('function');
    expect(typeof route.DELETE).toBe('function');
  });
});
