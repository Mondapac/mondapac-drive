// The accessible name of a row's button when every row shows the same label: "Settle: Noor
// Haddad" instead of a list of identical "Settle" buttons. It starts with the visible label
// (WCAG 2.5.3), without the trailing ellipsis that only marks a dialog.

type Translate = (key: 'row-action', values: { action: string; item: string }) => string;

export function rowName(t: Translate, label: string, item: string): string {
  return t('row-action', { action: label.replace(/…$/u, '').trim(), item });
}
