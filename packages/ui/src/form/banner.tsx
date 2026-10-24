import type { ReactNode } from 'react';

export type BannerTone = 'info' | 'success' | 'critical' | 'attention';

const TONE: Record<BannerTone, string> = {
  info: 'border-info-border bg-info-banner text-info-fg',
  success: 'border-success-bg bg-success-bg text-success-fg',
  critical: 'border-critical-border bg-critical-bg text-critical-fg',
  attention: 'border-attention-bg bg-attention-bg text-attention-fg',
};

export interface BannerProps {
  readonly tone: BannerTone;
  /** A bold first line; the children are the body under it. */
  readonly title?: string;
  readonly children?: ReactNode;
}

/** An inline message. Critical banners are announced at once; others politely. */
export function Banner({ tone, title, children }: BannerProps) {
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={`rounded-md border px-4 py-3 text-sm ${TONE[tone]}`}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}
