import type { ReactNode } from 'react';

export interface CardProps {
  readonly title?: string;
  readonly children: ReactNode;
  /**
   * For a table (or any list) that runs edge to edge: the body has no padding or gap, and a rule
   * separates it from the heading. The card clips the children to its rounded corners.
   */
  readonly flush?: boolean;
}

/** A bordered group of fields or rows with an optional heading. */
export function Card({ title, children, flush = false }: CardProps) {
  return (
    <section
      className={`rounded-lg border border-line bg-surface ${flush ? 'overflow-hidden' : ''}`}
    >
      {title ? <h2 className="px-5 pt-5 text-lg font-semibold text-fg">{title}</h2> : null}
      {flush ? (
        <div className={title ? 'mt-4 border-t border-line' : ''}>{children}</div>
      ) : (
        <div className="flex flex-col gap-4 p-5">{children}</div>
      )}
    </section>
  );
}
