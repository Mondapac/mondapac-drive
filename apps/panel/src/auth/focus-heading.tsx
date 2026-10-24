'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The heading of a state reached without a page load. It takes focus when it appears so that
 * assistive technology announces the new state (identity ux 6).
 */
export function FocusHeading({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h2 ref={ref} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">
      {children}
    </h2>
  );
}
