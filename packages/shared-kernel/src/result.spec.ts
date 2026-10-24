import { err, ok } from './result';
import type { Result } from './result';

describe('Result', () => {
  it('ok() carries the value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err() carries the error with its stable code', () => {
    expect(err({ code: 'thing.invalid' })).toEqual({ ok: false, error: { code: 'thing.invalid' } });
  });

  it('narrows on the ok flag', () => {
    const halve = (n: number): Result<number, { readonly code: 'number.odd' }> =>
      n % 2 === 0 ? ok(n / 2) : err({ code: 'number.odd' });

    const even = halve(8);
    const odd = halve(7);

    expect(even.ok && even.value).toBe(4);
    expect(!odd.ok && odd.error.code).toBe('number.odd');
  });

  it('has no value on an error and no error on a success', () => {
    expect(ok('x')).not.toHaveProperty('error');
    expect(err({ code: 'x.invalid' })).not.toHaveProperty('value');
  });
});
