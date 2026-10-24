import { parseContentHash } from './content-hash';

const HEX = '0123456789abcdef'.repeat(4);

describe('parseContentHash (platform-audit.md 6.3)', () => {
  it.each([`sha256:${HEX}`, `hmac-sha256:${HEX}`, `sha256:${'0'.repeat(64)}`])(
    'accepts %s',
    (value) => {
      expect(parseContentHash(value)).toEqual({ ok: true, value });
    },
  );

  it.each([
    ['no prefix', HEX],
    ['an unknown algorithm', `md5:${HEX}`],
    ['upper-case hex', `sha256:${HEX.toUpperCase()}`],
    ['upper-case prefix', `SHA256:${HEX}`],
    ['63 digits', `sha256:${HEX.slice(1)}`],
    ['65 digits', `sha256:${HEX}0`],
    ['a non-hex digit', `sha256:${HEX.slice(1)}g`],
    ['a trailing newline', `sha256:${HEX}\n`],
    ['a leading space', ` sha256:${HEX}`],
    ['base64', 'sha256:ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8='],
    ['an empty string', ''],
    ['a number', 1],
    ['null', null],
  ])('refuses %s, without echoing it', (_case, value) => {
    expect(parseContentHash(value)).toEqual({
      ok: false,
      error: { code: 'content-hash.malformed' },
    });
  });
});
