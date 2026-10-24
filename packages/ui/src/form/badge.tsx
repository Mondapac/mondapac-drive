import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'info' | 'attention' | 'critical' | 'success';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  info: 'bg-info-bg text-info-fg',
  attention: 'bg-attention-bg text-attention-fg',
  critical: 'bg-critical-bg text-critical-fg',
  success: 'bg-success-bg text-success-fg',
};

export interface BadgeProps {
  readonly tone: BadgeTone;
  readonly children: ReactNode;
}

/** A short status label. The text always says the status; colour is never the only signal. */
export function Badge({ tone, children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
