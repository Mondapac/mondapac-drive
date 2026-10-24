import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet, { type HelmetOptions } from 'helmet';

/**
 * Response headers of every answer (slice 0 item 6, Hassan): helmet's set with HSTS for two
 * years, `nosniff`, `Referrer-Policy: no-referrer` and a CSP that allows nothing, plus
 * `Cache-Control: no-store`, because answers depend on request headers (platform-foundations
 * 5.1). Only Swagger UI under `/docs` gets a CSP that lets its own page load.
 */

const TWO_YEARS_IN_SECONDS = 2 * 365 * 24 * 60 * 60;

function helmetWith(directives: Record<string, string[]>): RequestHandler {
  const options: HelmetOptions = {
    contentSecurityPolicy: { useDefaults: false, directives },
    strictTransportSecurity: { maxAge: TWO_YEARS_IN_SECONDS, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
  };
  return helmet(options);
}

/** The API answers JSON only: nothing in it may load, run or be framed. */
export const API_CSP = { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } as const;

/** Swagger UI's page: its own scripts, styles and images, still never framed. */
export const DOCS_CSP = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  // Swagger UI sets inline styles; scripts stay `'self'` only. /docs is off in production.
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
} as const;

/** `/docs` and the assets below it; `/docs-json` is a JSON answer like any other. */
function isDocsPage(path: string): boolean {
  return path === '/docs' || path.startsWith('/docs/');
}

export function securityHeaders(options: { readonly docsEnabled: boolean }): RequestHandler {
  const api = helmetWith(toMutable(API_CSP));
  const docs = helmetWith(toMutable(DOCS_CSP));
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    (options.docsEnabled && isDocsPage(req.path) ? docs : api)(req, res, next);
  };
}

function toMutable(
  directives: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(directives).map(([key, value]) => [key, [...value]]));
}
