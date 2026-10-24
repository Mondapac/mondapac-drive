import { checkReading, needsColdChain } from '../src/domain/cold-chain';
import { MARKETS } from './markets';

describe.each(MARKETS)('cold-chain check in $marketId', (settings) => {
  const { chilled, frozen } = settings.coldChain;

  it('needs no reading for ambient goods', () => {
    expect(needsColdChain('ambient')).toBe(false);
    expect(checkReading('ambient', '', settings.coldChain)).toEqual({ kind: 'not-required' });
  });

  it('asks for a reading for chilled and frozen goods', () => {
    expect(checkReading('chilled', ' ', settings.coldChain)).toEqual({
      kind: 'missing',
      maxCelsius: chilled.maxCelsius,
    });
    expect(checkReading('frozen', '', settings.coldChain).kind).toBe('missing');
  });

  it('accepts a reading at the Market limit and warns just above it', () => {
    expect(checkReading('chilled', String(chilled.maxCelsius), settings.coldChain)).toEqual({
      kind: 'ok',
      reading: chilled.maxCelsius,
      maxCelsius: chilled.maxCelsius,
    });
    expect(checkReading('chilled', String(chilled.maxCelsius + 0.5), settings.coldChain)).toEqual({
      kind: 'breach',
      reading: chilled.maxCelsius + 0.5,
      maxCelsius: chilled.maxCelsius,
    });
    expect(checkReading('frozen', String(frozen.maxCelsius - 2), settings.coldChain).kind).toBe(
      'ok',
    );
    expect(checkReading('frozen', String(frozen.maxCelsius + 1), settings.coldChain).kind).toBe(
      'breach',
    );
  });

  it('reads a decimal comma and a typographic minus', () => {
    expect(checkReading('frozen', '−20,5', settings.coldChain)).toMatchObject({ reading: -20.5 });
  });

  it('refuses text and readings outside the range the API accepts', () => {
    for (const input of ['cold', '61', '-41', '4.123', '--4']) {
      expect(checkReading('chilled', input, settings.coldChain).kind).toBe('invalid');
    }
  });
});

it('uses each Market its own limit', () => {
  const [au, zz] = MARKETS;
  expect(au.coldChain.chilled.maxCelsius).not.toBe(zz.coldChain.chilled.maxCelsius);
  const reading = String(
    Math.min(au.coldChain.chilled.maxCelsius, zz.coldChain.chilled.maxCelsius) + 0.5,
  );
  const kinds = MARKETS.map(
    (settings) => checkReading('chilled', reading, settings.coldChain).kind,
  );
  expect(kinds).toContain('breach');
  expect(kinds).toContain('ok');
});
