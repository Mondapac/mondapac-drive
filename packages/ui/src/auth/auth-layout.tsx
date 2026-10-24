import type { ReactNode } from 'react';

export type AuthPanel = 'seller' | 'admin';

export interface AuthShowcaseCard {
  readonly name: string;
  readonly detail: string;
}

export interface AuthLayoutProps {
  readonly panel: AuthPanel;
  /** The badge above the heading, for example "Seller account". */
  readonly badge: string;
  readonly title: string;
  readonly marketName: string;
  readonly supportLine: string;
  /** Showcase text and product-card names, from the app's catalogue (fictional). */
  readonly showcaseTitle: string;
  readonly showcaseCards: readonly AuthShowcaseCard[];
  readonly children: ReactNode;
}

/**
 * The Auth template (identity ux 3.1): a form column and, from 1024 px, the showcase panel (concept
 * 1A, product cards). The showcase is decoration: it carries no state and is hidden from
 * assistive technology.
 */
export function AuthLayout({
  panel,
  badge,
  title,
  marketName,
  supportLine,
  showcaseTitle,
  showcaseCards,
  children,
}: AuthLayoutProps) {
  const showcaseBackground = panel === 'seller' ? 'bg-showcase-seller' : 'bg-showcase-admin';
  return (
    <div className="grid min-h-screen grid-cols-1 bg-surface lg:grid-cols-[minmax(480px,45%)_1fr]">
      <main className="flex flex-col justify-between px-6 py-8 sm:px-12">
        <div className="text-sm font-semibold text-fg">{marketName}</div>
        <div className="mx-auto w-full max-w-(--mp-size-auth-card) py-10">
          <span className="inline-block rounded-md bg-selected px-2 py-1 text-xs font-medium text-link">
            {badge}
          </span>
          <h1 className="mt-3 mb-6 text-2xl font-semibold text-fg">{title}</h1>
          <div className="flex flex-col gap-5">{children}</div>
        </div>
        <p className="text-sm text-fg-muted">{supportLine}</p>
      </main>
      <aside
        aria-hidden="true"
        className={`hidden flex-col justify-center gap-6 p-12 text-on-showcase lg:flex ${showcaseBackground}`}
      >
        <p className="max-w-md text-3xl font-semibold">{showcaseTitle}</p>
        <ul className="flex max-w-md flex-col gap-3">
          {showcaseCards.map((card) => (
            <li
              key={card.name}
              className="rounded-lg border border-line-control bg-showcase-card px-4 py-3 text-fg"
            >
              <div className="font-medium">{card.name}</div>
              <div className="text-sm text-fg-muted">{card.detail}</div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
