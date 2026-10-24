import { THEME_SCRIPT } from '@mondapac-drive/ui';

// The theme head script as a same-origin file, so the page loads it with the CSP nonce instead
// of inline HTML (ADR-0034 decision 6 bans raw HTML).
export function GET(): Response {
  return new Response(THEME_SCRIPT, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
