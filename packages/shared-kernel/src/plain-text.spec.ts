import { parsePlainText } from './plain-text';

describe('parsePlainText', () => {
  it('refuses other controls, format characters, lone surrogates, noncharacters and separators', () => {
    for (const text of [
      'a\u0000b',
      'a\u001Bb',
      'a\u0085b',
      'a\u009Bb',
      'a\u2028b',
      'a\u2029b',
      'a\u0600b',
      'a\uFFF9b',
      'a\uD800b',
      'a\uFFFEb',
    ]) {
      expect(parsePlainText(text)).toEqual({
        ok: false,
        error: { code: 'text.invisible-character', offset: 1, character: 'other' },
      });
    }
  });

  it('keeps the line feed, carriage return and tab of a long text', () => {
    expect(parsePlainText('line one\r\nline\ttwo').ok).toBe(true);
  });

  it('accepts ordinary text in several scripts, unchanged', () => {
    for (const text of ['Olive oil 500 ml', 'روغن زیتون', 'जैतून का तेल', '', '日本語 テキスト']) {
      expect(parsePlainText(text)).toEqual({ ok: true, value: text });
    }
  });

  it('refuses bidi controls and default-ignorable characters, naming the offset', () => {
    const cases: [string, number][] = [
      ['ab‮cd', 2],
      ['⁦x', 0],
      ['soft­hyphen', 4],
      ['a​b', 1],
      ['a﻿b', 1],
      ['a⁠b', 1],
      ['a️b', 1],
      ['a\u{E0041}b', 1],
    ];
    for (const [text, offset] of cases) {
      expect(parsePlainText(text)).toEqual({
        ok: false,
        error: { code: 'text.invisible-character', offset, character: 'other' },
      });
    }
  });

  it('counts the offset in UTF-16 units, as a text area does', () => {
    expect(parsePlainText('\u{1F600}​')).toEqual({
      ok: false,
      error: { code: 'text.invisible-character', offset: 2, character: 'other' },
    });
  });

  it('accepts ZWNJ between two Arabic-script letters (Persian)', () => {
    const text = 'می‌خواهم';
    expect(parsePlainText(text)).toEqual({ ok: true, value: text });
  });

  it('accepts ZWNJ after a vowel sign that follows an Arabic letter', () => {
    const text = 'بَ‌ب';
    expect(parsePlainText(text)).toEqual({ ok: true, value: text });
  });

  it('accepts ZWJ between Indic-script characters', () => {
    const text = 'क्‍ष';
    expect(parsePlainText(text)).toEqual({ ok: true, value: text });
  });

  it('refuses ZWNJ and ZWJ outside a joining script, naming which', () => {
    expect(parsePlainText('a‌b')).toEqual({
      ok: false,
      error: { code: 'text.invisible-character', offset: 1, character: 'ZWNJ' },
    });
    expect(parsePlainText('a‍b')).toEqual({
      ok: false,
      error: { code: 'text.invisible-character', offset: 1, character: 'ZWJ' },
    });
  });

  it('refuses ZWNJ at either end, next to a space or a digit, or beside another joiner', () => {
    for (const text of ['‌ب', 'ب‌', 'ب ‌ب', 'ب‌1', 'ب‌‌ب', 'ب‌‍ب']) {
      expect(parsePlainText(text).ok).toBe(false);
    }
  });

  it('refuses ZWNJ between an Arabic letter and a Latin letter', () => {
    expect(parsePlainText('ب‌a').ok).toBe(false);
  });

  it('reports the first refused character only', () => {
    expect(parsePlainText('a​b‮c')).toEqual({
      ok: false,
      error: { code: 'text.invisible-character', offset: 1, character: 'other' },
    });
  });

  it('refuses a value that is not a string', () => {
    expect(parsePlainText(null as unknown as string).ok).toBe(false);
  });
});
