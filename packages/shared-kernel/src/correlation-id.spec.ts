import { parseCorrelationId } from './correlation-id';

describe('parseCorrelationId', () => {
  it.each([
    ['a UUID', '017f22e2-79b0-7cc3-98c4-dc0c0c07398f'],
    ['the shortest value', 'abcdefgh'],
    ['every allowed kind of character', 'A.b_c-d9'],
    ['the longest value', 'a'.repeat(128)],
  ])('accepts %s', (_name, text) => {
    expect(parseCorrelationId(text)).toEqual({ ok: true, value: text });
  });

  it.each([
    ['empty', ''],
    ['too short', 'abcdefg'],
    ['too long', 'a'.repeat(129)],
    ['a space', 'abcd efgh'],
    ['a trailing newline', 'abcdefgh\n'],
    ['a second line', 'abcdefgh\nabcdefgh'],
    ['a quote', 'abcdefgh"'],
    ['a brace', '{abcdefgh}'],
    ['a slash', 'abcd/efgh'],
    ['a non-ASCII letter', 'abcdefgé'],
  ])('rejects %s', (_name, text) => {
    expect(parseCorrelationId(text)).toEqual({
      ok: false,
      error: { code: 'correlation-id.invalid' },
    });
  });

  it('rejects a value that is not a string at run time', () => {
    expect(parseCorrelationId(['abcdefgh'] as unknown as string).ok).toBe(false);
    expect(parseCorrelationId(new String('abcdefgh') as unknown as string).ok).toBe(false);
    expect(parseCorrelationId(undefined as unknown as string).ok).toBe(false);
  });
});
