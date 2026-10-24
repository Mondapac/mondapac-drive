import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './security-headers.ts';

describe('security headers', () => {
  it('uses the nonce and no unsafe-eval in production', () => {
    const csp = contentSecurityPolicy('abc', false);
    expect(csp).toContain("'nonce-abc'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('allows eval only in development', () => {
    expect(contentSecurityPolicy('abc', true)).toContain('unsafe-eval');
  });

  it('sends HSTS only outside development', () => {
    expect(securityHeaders('n', false)['strict-transport-security']).toBeDefined();
    expect(securityHeaders('n', true)['strict-transport-security']).toBeUndefined();
  });
});
