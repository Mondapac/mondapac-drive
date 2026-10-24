// Cached Intl formatters keyed by locale and options. The locale is the Market's (PANEL_LOCALE,
// passed in by the caller); nothing here names a country or a language.
const dates = new Map<string, Intl.DateTimeFormat>();
const numbers = new Map<string, Intl.NumberFormat>();

/** A DateTimeFormat for the locale, built once per locale and options. */
export function dateFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dates.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, options);
    dates.set(key, format);
  }
  return format;
}

/** A NumberFormat for the locale, built once per locale and options. */
export function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numbers.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, options);
    numbers.set(key, format);
  }
  return format;
}
