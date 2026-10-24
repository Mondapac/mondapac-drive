/** The part of a translator the messages need; server and client translators both fit. */
export interface OpsTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/**
 * The sentence for an API refusal code: the screen's own message first (`scope.error.<code>`),
 * then the shared one, else a generic sentence. Never the raw code.
 */
export function messageFor(t: OpsTranslator, code: string, scope?: string): string {
  if (scope !== undefined && t.has(`${scope}.error.${code}`)) return t(`${scope}.error.${code}`);
  if (t.has(`ops.error.${code}`)) return t(`ops.error.${code}`);
  return t('ops.error.unknown');
}
