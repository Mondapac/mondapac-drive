import type { ReactNode } from 'react';

export interface ActionRowProps {
  /** The buttons, primary first. */
  readonly children: ReactNode;
}

/**
 * A row of form or card actions. On phones the buttons stack at full width, so every action
 * in a panel has the same width; from `sm` they sit side by side at their own width and wrap.
 */
export function ActionRow({ children }: ActionRowProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">{children}</div>
  );
}
