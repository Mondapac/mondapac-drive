import { useLocale } from 'next-intl';
import { formatInstant } from './format.ts';

/** A date over its time, so a narrow column never breaks inside either. */
export function When({ iso, missing }: { readonly iso: string | null; readonly missing: string }) {
  const locale = useLocale();
  if (iso === null) return <span className="text-fg-muted">{missing}</span>;
  const text = formatInstant(iso, locale);
  const split = text.lastIndexOf(', ');
  if (split < 0) return <span className="whitespace-nowrap">{text}</span>;
  return (
    <span className="block">
      <span className="block whitespace-nowrap">{text.slice(0, split)}</span>
      <span className="block whitespace-nowrap text-xs text-fg-muted">{text.slice(split + 2)}</span>
    </span>
  );
}
