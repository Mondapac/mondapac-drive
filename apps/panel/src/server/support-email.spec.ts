import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./config.ts', () => ({ panelConfig: () => ({ supportEmail: 'env@example.com' }) }));

const { supportEmail } = await import('./support-email.ts');

describe('supportEmail', () => {
  it('shows the address of the environment', async () => {
    await expect(supportEmail()).resolves.toBe('env@example.com');
  });
});
