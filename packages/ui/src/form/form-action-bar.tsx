import type { ReactNode } from 'react';

export interface FormActionBarProps {
  /** Left side: a saved or error message. */
  readonly status?: ReactNode;
  /** The buttons, primary last. */
  readonly children: ReactNode;
}

/** The save bar at the end of a form: a message on one side, the actions on the other. */
export function FormActionBar({ status, children }: FormActionBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <div className="min-w-0 text-sm text-fg-muted">{status}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
