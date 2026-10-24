import { Icon } from '../icon/icon.tsx';

/** The way back to a parent list, above a page heading (48 px tall on phones). */
export function BackLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-12 items-center gap-2 text-sm font-medium text-link hover:underline md:min-h-0"
    >
      <Icon name="arrow-left" />
      {label}
    </a>
  );
}
