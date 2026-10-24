// The header assertion of the CI boot probe (slice 0 item 6, platform-foundations section 7):
// the built API, as started in CI, sends the security headers on a 200, a 404 and a 400.
// The 400 is the JSON parser's: slice 0 has no market-scoped route, so the market guard's 400
// (5.1) is asserted by test/http-hardening.e2e.spec.ts until the first such route lands.
// Usage: node scripts/check-http-headers.mjs [base URL], default http://localhost:3000.

const base = process.argv[2] ?? 'http://localhost:3000';

const EXPECTED = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none';frame-ancestors 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const ABSENT = ['x-powered-by', 'access-control-allow-origin'];

const probes = [
  { name: 'GET /health', status: 200, request: () => fetch(`${base}/health`) },
  { name: 'GET an unknown route', status: 404, request: () => fetch(`${base}/no-such-route`) },
  {
    name: 'POST malformed JSON',
    status: 400,
    request: () =>
      fetch(`${base}/health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
  },
];

let failures = 0;
for (const probe of probes) {
  const problems = [];
  let response;
  try {
    response = await probe.request();
  } catch (error) {
    problems.push(`request failed: ${error.cause?.code ?? error.message}`);
  }
  if (response) {
    if (response.status !== probe.status) {
      problems.push(`status ${response.status}, expected ${probe.status}`);
    }
    for (const [name, value] of Object.entries(EXPECTED)) {
      const actual = response.headers.get(name);
      if (actual !== value) problems.push(`${name}: ${actual ?? '(missing)'}, expected ${value}`);
    }
    for (const name of ABSENT) {
      if (response.headers.has(name)) problems.push(`${name} must not be sent`);
    }
  }
  failures += problems.length;
  if (problems.length === 0) {
    console.log(`ok   ${probe.name}`);
  } else {
    // A GitHub Actions annotation, so a failure shows on the pull request.
    console.log(`::error title=HTTP headers::${probe.name}: ${problems.join('; ')}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
