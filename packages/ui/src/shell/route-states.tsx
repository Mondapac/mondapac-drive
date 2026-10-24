'use client';

import { useEffect, useRef } from 'react';
import { Button } from '../form/button.tsx';

/**
 * The page frame while a route renders on the server: the sidebar and topbar keep their place, so
 * moving between pages does not make the layout jump, and the content shows placeholder rows.
 */
export function RouteLoading({
  label,
  collapsed = false,
}: {
  /** Read by screen readers ("Loading the page"). */
  readonly label: string;
  /** The saved sidebar choice, so the placeholder column has the sidebar's width. */
  readonly collapsed?: boolean;
}) {
  return (
    <div
      className={`grid min-h-screen grid-cols-1 bg-page ${collapsed ? 'md:grid-cols-[var(--mp-size-sidebar-collapsed)_minmax(0,1fr)]' : 'md:grid-cols-[var(--mp-size-sidebar)_minmax(0,1fr)]'}`}
    >
      <div aria-hidden="true" className="hidden border-e border-line bg-surface md:block" />
      <div className="flex min-w-0 flex-col">
        <div
          aria-hidden="true"
          className="h-(--mp-size-topbar-phone) border-b border-line bg-surface md:h-(--mp-size-topbar)"
        />
        <main aria-busy="true" className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">
          <span role="status" className="sr-only">
            {label}
          </span>
          <div aria-hidden="true" className="flex flex-col gap-4 motion-safe:animate-pulse">
            <span className="h-7 w-1/3 rounded-sm bg-muted" />
            <span className="h-4 w-2/3 max-w-(--mp-size-form-max) rounded-sm bg-muted" />
            <ul className="divide-y divide-line-row rounded-lg border border-line bg-surface">
              {[0, 1, 2].map((row) => (
                <li key={row} className="flex flex-col gap-2 p-4">
                  <span className="h-3 w-2/5 rounded-sm bg-muted" />
                  <span className="h-3 w-3/5 rounded-sm bg-muted" />
                </li>
              ))}
            </ul>
          </div>
        </main>
      </div>
    </div>
  );
}

export interface RouteErrorProps {
  readonly title: string;
  readonly message: string;
  readonly retryLabel: string;
  /** Renders the route again (Next's `reset`). */
  readonly onRetry: () => void;
  readonly homeLabel: string;
  readonly homeHref: string;
  /** Next's error digest: lets support find the server log line without showing the error. */
  readonly reference?: string;
  readonly referenceLabel?: string;
}

/** A page that failed to render: what happened, a retry and a way home, never the raw error. */
export function RouteError({
  title,
  message,
  retryLabel,
  onRetry,
  homeLabel,
  homeHref,
  reference,
  referenceLabel,
}: RouteErrorProps) {
  // Focus lands on the message, so keyboard and screen-reader users start there, Try again a Tab
  // away.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <main className="flex min-h-screen items-center justify-center bg-page p-4">
      <div
        role="alert"
        className="flex w-full max-w-(--mp-size-form-max) flex-col gap-4 rounded-lg border border-line bg-surface p-6"
      >
        <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold text-fg outline-none">
          {title}
        </h1>
        <p className="text-fg-muted">{message}</p>
        {reference !== undefined && referenceLabel !== undefined && (
          <p className="text-sm text-fg-muted">
            {referenceLabel} <code className="wrap-anywhere text-fg">{reference}</code>
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button onClick={onRetry}>{retryLabel}</Button>
          <a
            href={homeHref}
            className="inline-flex h-(--mp-size-control) items-center justify-center rounded-md border border-line-control bg-surface px-4 font-medium text-fg hover:bg-muted"
          >
            {homeLabel}
          </a>
        </div>
      </div>
    </main>
  );
}
