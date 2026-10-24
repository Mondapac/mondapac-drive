'use client';

import { useEffect, useRef, useState } from 'react';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** A link tab (a page of its own). Without it the tab is a button and calls `onSelect`. */
  readonly href?: string;
}

export interface TabsProps {
  /** Name of the tab row landmark. */
  readonly label: string;
  readonly items: readonly TabItem[];
  readonly activeId: string;
  /** Button tabs only: the tab the user picked. */
  readonly onSelect?: (id: string) => void;
}

const BASE =
  'flex min-h-12 shrink-0 items-center whitespace-nowrap border-b-2 px-1 focus-visible:outline-2 focus-visible:outline-focus';
const ACTIVE = `${BASE} border-accent font-medium text-fg`;
const IDLE = `${BASE} border-transparent text-fg-muted hover:text-fg`;

/**
 * The one tab row of both panels. It stays one line and scrolls sideways when the tabs do not
 * fit; a fade on the cut edge shows there is more, and the current tab is scrolled into view.
 * A link tab marks the current page with aria-current; a button tab is a toggle (aria-pressed).
 */
export function Tabs({ label, items, activeId, onSelect }: TabsProps) {
  const row = useRef<HTMLElement>(null);
  const [fade, setFade] = useState({ start: false, end: false, rtl: false });

  useEffect(() => {
    const element = row.current;
    if (element === null) return;
    const update = () => {
      // scrollLeft is negative in a right-to-left page, so compare magnitudes.
      const left = Math.abs(element.scrollLeft);
      const rest = element.scrollWidth - element.clientWidth - left;
      setFade({
        start: left > 1,
        end: rest > 1,
        rtl: getComputedStyle(element).direction === 'rtl',
      });
    };
    // Older engines (and jsdom) lack these; the row still scrolls without them.
    const current = element.querySelector<HTMLElement>(
      '[aria-current="page"], [aria-pressed="true"]',
    );
    if (typeof current?.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [activeId, items.length]);

  const mask =
    fade.start || fade.end
      ? `linear-gradient(to ${fade.rtl ? 'left' : 'right'}, ${fade.start ? 'transparent, black 2.5rem' : 'black'}, ${fade.end ? 'black calc(100% - 2.5rem), transparent' : 'black'})`
      : undefined;

  return (
    <nav
      ref={row}
      aria-label={label}
      style={mask === undefined ? undefined : { maskImage: mask, WebkitMaskImage: mask }}
      className="flex gap-4 overflow-x-auto sm:gap-6 border-b border-line [scrollbar-width:none]"
    >
      {items.map((item) => {
        const active = item.id === activeId;
        const className = active ? ACTIVE : IDLE;
        return item.href === undefined ? (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect?.(item.id)}
            className={className}
          >
            {item.label}
          </button>
        ) : (
          <a
            key={item.id}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={className}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
