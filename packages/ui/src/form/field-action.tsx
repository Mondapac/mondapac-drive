import type { ReactNode } from 'react';

export interface FieldActionProps {
  readonly children: ReactNode;
  /** The breakpoint where the row turns from stacked to one line (default `sm`). */
  readonly from?: 'sm' | 'lg';
}

/**
 * A control with no label of its own (a Search button, a filter checkbox) placed on one line
 * with labelled fields: it takes the same label line and gap as `TextField` and `Select`, so it
 * lines up with their inputs. The row uses `items-start`, so help or error text under a field
 * never moves it. Below `from` the row stacks and the spacer is dropped.
 */
export function FieldAction({ children, from = 'sm' }: FieldActionProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        aria-hidden="true"
        className={`hidden text-sm font-medium ${from === 'lg' ? 'lg:block' : 'sm:block'}`}
      >
        &nbsp;
      </span>
      <div className="flex min-h-(--mp-size-control) items-center">{children}</div>
    </div>
  );
}
