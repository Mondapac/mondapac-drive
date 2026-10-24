import type { ReactNode } from 'react';

export type FieldStatusTone = 'checking' | 'success' | 'info' | 'critical';

const TONE: Record<FieldStatusTone, string> = {
  checking: 'text-fg-muted',
  success: 'text-success-fg',
  info: 'text-info-fg',
  critical: 'text-critical-fg',
};

export interface FieldStatusProps {
  readonly tone: FieldStatusTone;
  readonly children: ReactNode;
}

/** The result line under a control: a check in progress, or what the check found. */
export function FieldStatus({ tone, children }: FieldStatusProps) {
  return (
    <p role={tone === 'critical' ? 'alert' : 'status'} className={`text-sm ${TONE[tone]}`}>
      {children}
    </p>
  );
}
