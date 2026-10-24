// Security headers of every response (ADR-0034 decision 6): a nonce-based Content-Security-Policy,
// frame-ancestors none, nosniff, a strict referrer policy, COOP, a restrictive Permissions-Policy
// and, in production, HSTS. Pure so it is tested without a server.

/**
 * `mapOrigins` are the live map's tile origins (PANEL_MAP_STYLE_URL): MapLibre fetches tiles,
 * glyphs and sprites from them and decodes images into blobs; its worker is the panel's own file.
 */
export function contentSecurityPolicy(
  nonce: string,
  development: boolean,
  mapOrigins: readonly string[] = [],
): string {
  const map = mapOrigins.length === 0 ? '' : ` ${mapOrigins.join(' ')}`;
  const directives = [
    "default-src 'self'",
    // Next's dev runtime needs eval; production does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    // Tailwind output is a linked stylesheet; React inline style attributes need this.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${map === '' ? '' : ` blob:${map}`}`,
    "font-src 'self'",
    `connect-src 'self'${map}`,
    ...(map === '' ? [] : ["worker-src 'self'"]),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}

export function securityHeaders(
  nonce: string,
  development: boolean,
  mapOrigins: readonly string[] = [],
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': contentSecurityPolicy(nonce, development, mapOrigins),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (!development) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}
