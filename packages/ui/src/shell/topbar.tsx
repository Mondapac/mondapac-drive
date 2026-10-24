import type { ReactNode } from 'react';

export interface Crumb {
  readonly label: string;
  readonly href: string;
}

export interface TopbarProps {
  readonly pageTitle: string;
  /**
   * The pages above this one, outermost first (for example Home, then Settings). From tablets up
   * the topbar shows them with the page as a breadcrumb, so it does not repeat the page's h1.
   */
  readonly trail?: readonly Crumb[];
  /** Name of the breadcrumb landmark. */
  readonly trailLabel?: string;
  /** Right-hand slot: Market chip, notifications, user menu. */
  readonly actions?: ReactNode;
}

export function Topbar({ pageTitle, trail = [], trailLabel, actions }: TopbarProps) {
  return (
    <header className="flex h-(--mp-size-topbar-phone) items-center justify-between gap-3 bg-surface pe-4 md:h-(--mp-size-topbar) md:px-6">
      {/* The page name, not a heading: each page has its own h1, so a page has one h1. On phones
       * the bar names the page; from tablets up the h1 is in view, so the bar shows the path. */}
      <p className="min-w-0 truncate text-lg font-semibold text-fg md:hidden">{pageTitle}</p>
      <nav aria-label={trailLabel} className="hidden min-w-0 md:block">
        <ol className="flex min-w-0 items-center gap-2 text-sm">
          {trail.map((crumb) => (
            <li key={crumb.href} className="flex shrink-0 items-center gap-2">
              <a href={crumb.href} className="text-fg-muted hover:text-fg hover:underline">
                {crumb.label}
              </a>
              <span aria-hidden="true" className="text-fg-muted">
                /
              </span>
            </li>
          ))}
          <li aria-current="page" className="min-w-0 truncate font-medium text-fg">
            {pageTitle}
          </li>
        </ol>
      </nav>
      <div className="flex shrink-0 items-center gap-3">{actions}</div>
    </header>
  );
}
