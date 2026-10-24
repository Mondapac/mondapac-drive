// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeSetupQr } from '../../test/decode-qr.ts';
import { SetupQr } from './setup-qr.tsx';

afterEach(cleanup);

/** The shape the API issues (`otpauthUri` in identity/domain/otpauth.ts): fixed TOTP parameters. */
function issued(issuer: string, account: string, secret: string): string {
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${query}`;
}

function decoded(uri: string): string | null {
  render(<SetupQr uri={uri} label="QR" intro="intro" fallback="fallback" />);
  return decodeSetupQr(screen.getByTestId('setup-qr'));
}

describe('enrolment QR code', () => {
  it.each([
    [
      'a plain issuer and address',
      issued('Mondapac Drive', 'a@example.com', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'),
    ],
    [
      'an issuer with a space and a plus address',
      issued('Monda Pac Halal', 'jo+admin@example.com.au', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
    ],
    [
      'a non-ASCII issuer',
      issued('Mondäpac é', 'zoë@example.com', 'MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK'),
    ],
  ])('decodes to exactly the issued otpauth URI for %s', (_name, uri) => {
    expect(decoded(uri)).toBe(uri);
  });

  it('carries every parameter an authenticator app needs', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const url = new URL(decoded(issued('Mondapac Drive', 'a@example.com', secret)) ?? 'x:');
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Mondapac Drive:a@example.com');
    expect(url.searchParams.get('secret')).toBe(secret);
    expect(url.searchParams.get('issuer')).toBe('Mondapac Drive');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});
