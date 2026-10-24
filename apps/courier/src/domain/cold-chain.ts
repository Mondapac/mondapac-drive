import { temperatureReading, type ColdChainLimits, type Temperature } from '../api/schemas';

export type ColdChainCheck =
  | { readonly kind: 'not-required' }
  | { readonly kind: 'missing'; readonly maxCelsius: number }
  | { readonly kind: 'invalid'; readonly maxCelsius: number }
  | { readonly kind: 'ok'; readonly reading: number; readonly maxCelsius: number }
  | { readonly kind: 'breach'; readonly reading: number; readonly maxCelsius: number };

export function needsColdChain(temperature: Temperature): temperature is 'chilled' | 'frozen' {
  return temperature !== 'ambient';
}

/**
 * Checks what the courier typed against the Market's limit, which the API sends. The API makes
 * the same check (`cold-chain.breach`); the app warns before the goods change hands.
 */
export function checkReading(
  temperature: Temperature,
  input: string,
  limits: ColdChainLimits,
): ColdChainCheck {
  if (!needsColdChain(temperature)) return { kind: 'not-required' };
  const maxCelsius = limits[temperature].maxCelsius;
  const text = input.trim().replace(',', '.');
  if (text === '') return { kind: 'missing', maxCelsius };
  if (!/^[-−]?\d{1,2}(\.\d{1,2})?$/.test(text)) return { kind: 'invalid', maxCelsius };
  const reading = Number(text.replace('−', '-'));
  if (!temperatureReading.safeParse(reading).success) return { kind: 'invalid', maxCelsius };
  return reading > maxCelsius
    ? { kind: 'breach', reading, maxCelsius }
    : { kind: 'ok', reading, maxCelsius };
}
