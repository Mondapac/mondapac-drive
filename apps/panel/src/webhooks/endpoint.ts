/**
 * A merchant's endpoint as support sees it: scheme, host and path. Credentials in the URL and the
 * query (where a merchant may put a token) are never shown (security review, L1).
 */
export function endpointText(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '-';
  }
  return `${url.protocol}//${url.host}${url.pathname}${url.search === '' ? '' : '?…'}`;
}
