const ACCENTED: Readonly<Record<string, string>> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'î',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'û',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Î',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Û',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

export const PSEUDO_OPEN = '⟦';
export const PSEUDO_CLOSE = '⟧';

/** One message in pseudo-English; `{{placeholders}}` stay as they are. */
export function pseudoText(text: string): string {
  const accented = text
    .split(/(\{\{\w+\}\})/)
    .map((part) =>
      part.startsWith('{{') ? part : part.replace(/[A-Za-z]/g, (ch) => ACCENTED[ch] ?? ch),
    )
    .join('');
  return `${PSEUDO_OPEN}${accented}${PSEUDO_CLOSE}`;
}

/** The whole message tree in pseudo-English. */
export function pseudoMessages<T>(messages: T): T {
  if (typeof messages === 'string') return pseudoText(messages) as T;
  return Object.fromEntries(
    Object.entries(messages as Record<string, unknown>).map(([key, value]) => [
      key,
      pseudoMessages(value),
    ]),
  ) as T;
}
