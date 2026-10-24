'use client';

import type { MouseEvent } from 'react';
import { Icon } from '../icon/icon.tsx';
import {
  NotificationBell,
  NotificationDrawer,
  type NoticeItem,
  type NoticeListState,
  type NotificationDrawerProps,
} from './notification-drawer.tsx';
import type { FeedNotice, NoticeFeed } from './use-notice-feed.ts';

export interface NoticeCenterProps<N extends FeedNotice> {
  readonly feed: NoticeFeed<N>;
  /** Builds a drawer row from a panel notice; `now` is when its page arrived. */
  readonly toItem: (notice: N, now: number) => NoticeItem;
  readonly onOpenItem: (item: NoticeItem, event: MouseEvent<HTMLElement>) => void;
  readonly labels: NotificationDrawerProps['labels'] & {
    /** The bell's name with the count, e.g. "Notifications, 3 unread". */
    readonly bell: string;
    readonly enableSound: string;
  };
}

/**
 * A panel's topbar notifications (packages 2 and 3): the "enable sound" hint while the browser
 * blocks a sound that is switched on, the bell, the polite live region and the drawer.
 */
export function NoticeCenter<N extends FeedNotice>({
  feed,
  toItem,
  onOpenItem,
  labels,
}: NoticeCenterProps<N>) {
  const { page } = feed;
  const list: NoticeListState =
    page.state === 'ready'
      ? {
          kind: 'ready',
          items: page.items.map((notice) => toItem(notice, page.now)),
          hasMore: page.next !== null,
          loadingMore: page.loadingMore,
        }
      : { kind: page.state };
  return (
    <div className="me-3 flex items-center gap-1">
      {feed.sound.on && feed.sound.blocked ? (
        <button
          type="button"
          onClick={feed.sound.enable}
          className="inline-flex min-h-(--mp-size-control-sm) min-w-(--mp-size-control-sm) items-center justify-center gap-1.5 rounded-full border border-transparent px-2 text-xs font-medium text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus sm:border-line-control sm:px-3"
        >
          <Icon name="volume-off" />
          {/* Phones show the icon alone; the name stays for screen readers. */}
          <span className="sr-only sm:not-sr-only">{labels.enableSound}</span>
        </button>
      ) : null}
      <NotificationBell
        unread={feed.unread}
        expanded={feed.open}
        onClick={feed.openDrawer}
        label={labels.bell}
      />
      <span className="sr-only" aria-live="polite">
        {feed.announcement}
      </span>
      <NotificationDrawer
        open={feed.open}
        onClose={feed.close}
        unread={feed.unread}
        filter={feed.filter}
        onFilter={feed.chooseFilter}
        list={list}
        onOpenItem={onOpenItem}
        onMarkAll={feed.markAll}
        markingAll={feed.markingAll}
        onLoadMore={feed.loadMore}
        onRetry={feed.retry}
        sound={{ on: feed.sound.on, onToggle: feed.sound.toggle }}
        labels={labels}
      />
    </div>
  );
}
