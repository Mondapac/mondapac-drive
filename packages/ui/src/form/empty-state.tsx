import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';

export type EmptyStateSize = 'page' | 'card' | 'compact';

export interface EmptyStateProps {
  readonly icon: IconName;
  readonly title: string;
  readonly body?: string;
  /** An optional next step, such as a button or a link. */
  readonly action?: ReactNode;
  /**
   * Figma EmptyState sizes: page (the whole page is empty; its title is the page h1), card (a
   * region on a page; h2, framed) and compact (inside a table or card that is already framed; h3).
   */
  readonly size?: EmptyStateSize;
}

const FRAME: Record<EmptyStateSize, string> = {
  page: 'px-6 py-16',
  card: 'rounded-lg border border-line bg-surface px-6 py-10',
  compact: 'px-4 py-8',
};
const TITLE: Record<EmptyStateSize, string> = {
  page: 'text-2xl font-semibold text-fg',
  card: 'text-base font-medium text-fg',
  compact: 'text-base font-medium text-fg',
};

/** Figma EmptyState: an icon tile, the region's heading, a line of help and an optional action. */
export function EmptyState({ icon, title, body, action, size = 'card' }: EmptyStateProps) {
  const Heading = size === 'page' ? 'h1' : size === 'card' ? 'h2' : 'h3';
  return (
    <div className={`flex flex-col items-center gap-3 text-center ${FRAME[size]}`}>
      <span className="flex size-(--mp-size-control-lg) items-center justify-center rounded-full bg-muted text-icon">
        <Icon name={icon} />
      </span>
      <Heading className={`break-words ${TITLE[size]}`}>{title}</Heading>
      {body === undefined ? null : <p className="max-w-prose text-sm text-fg-muted">{body}</p>}
      {action ?? null}
    </div>
  );
}
