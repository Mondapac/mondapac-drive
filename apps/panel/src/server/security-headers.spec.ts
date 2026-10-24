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

describe('live map origins', () => {
  it('adds nothing for a panel without a base map', () => {
    const csp = contentSecurityPolicy('abc', false);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("img-src 'self' data:;");
    expect(csp).not.toContain('worker-src');
    expect(csp).not.toContain('blob:');
  });

  it("allows the tile origins for fetches and images, and the panel's own worker", () => {
    const csp = contentSecurityPolicy('abc', false, ['https://tiles.example.com']);
    expect(csp).toContain("connect-src 'self' https://tiles.example.com");
    expect(csp).toContain("img-src 'self' data: blob: https://tiles.example.com");
    expect(csp).toContain("worker-src 'self';");
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
  });
});
