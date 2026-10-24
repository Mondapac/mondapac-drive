import { err, ok, type Result } from '@mondapac-drive/shared-kernel';

/**
 * The languages a panel user may choose. Only the Market's English catalogue exists today; a
 * language is added here in the same change that adds its message catalogue.
 */
export const PANEL_LANGUAGES = ['en'] as const;

export type PanelPreferencesInvalid = {
  readonly code: 'panel-preferences.invalid';
  readonly field: 'timezone' | 'locale';
};

/** The IANA zone ids this runtime knows, plus UTC (which the runtime list leaves out). */
const ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/**
 * A personal time zone: an IANA id this runtime knows, as written, or null for "no choice"
 * (the panel then keeps its own rule: an admin sees the Market's zone).
 * Time zone and language are display preferences of the account; they are not personal data
 * worth hiding, but they are still only ever shown to their holder.
 */
export function parseTimezone(raw: unknown): Result<string | null, PanelPreferencesInvalid> {
  if (raw === null) return ok(null);
  if (typeof raw !== 'string' || !ZONES.has(raw)) {
    return err({ code: 'panel-preferences.invalid', field: 'timezone' });
  }
  return ok(raw);
}

/** A panel language from {@link PANEL_LANGUAGES}, or null for "the Market's language". */
export function parsePanelLanguage(raw: unknown): Result<string | null, PanelPreferencesInvalid> {
  if (raw === null) return ok(null);
  if (typeof raw !== 'string' || !(PANEL_LANGUAGES as readonly string[]).includes(raw)) {
    return err({ code: 'panel-preferences.invalid', field: 'locale' });
  }
  return ok(raw);
}
