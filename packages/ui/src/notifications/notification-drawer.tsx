'use client';

import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { Badge, type BadgeTone } from '../form/badge.tsx';
import { Button } from '../form/button.tsx';
import { EmptyState } from '../form/empty-state.tsx';
import { Icon, type IconName } from '../icon/icon.tsx';
import { useModal } from '../overlay/dialog.tsx';
import { initials } from '../shell/account-menu.tsx';
import { Tabs } from '../shell/tabs.tsx';
import { badgeCount, NOTICE_FILTERS, type NoticeFilter } from './notices.ts';

/** The colour of a notice's type, by token (plan 6c): orders success, reviews info, and so on. */
export type NoticeTone = Exclude<BadgeTone, 'critical'>;

const AVATAR: Record<NoticeTone, string> = {
  success: 'bg-success-bg text-success-fg',
  info: 'bg-info-bg text-info-fg',
  attention: 'bg-attention-bg text-attention-fg',
  neutral: 'bg-neutral-bg text-neutral-fg',
};

/** One notice as the drawer shows it; the panel builds the text and the link from its kind. */
export interface NoticeItem {
  readonly id: string;
  /**
   * The page of the item the notice is about (for example the seller order); null where the
   * panel has no such page yet, so the row is a button that only marks the notice read.
   */
  readonly href: string | null;
  /** Whose notice it is, shown as initials; null shows the type icon alone. */
  readonly ownerName: string | null;
  readonly icon: IconName;
  readonly tone: NoticeTone;
  /** The sentence, with the owner or the item in bold. */
  readonly message: ReactNode;
  /** When, as the reader reads it (for example "5 min ago"), and as an ISO instant. */
  readonly time: string;
  readonly dateTime: string;
  /** The notice's group, such as Orders. */
  readonly category: string;
  readonly read: boolean;
}

export type NoticeListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly items: readonly NoticeItem[];
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
    };

export interface NotificationBellProps {
  readonly unread: number;
  readonly expanded: boolean;
  readonly onClick: () => void;
  /** Accessible name with the count, e.g. "Notifications, 3 unread". */
  readonly label: string;
}

/** The topbar bell: an icon button with the unread badge (nothing at 0, "99+" above 99). */
export function NotificationBell({ unread, expanded, onClick, label }: NotificationBellProps) {
  const count = badgeCount(unread);
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onClick}
      className="relative flex size-(--mp-size-control) items-center justify-center rounded-full text-icon hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Icon name="bell" />
      {count === '' ? null : (
        <span
          aria-hidden="true"
          className="absolute start-1/2 top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-critical-solid px-1 text-xs font-semibold leading-none text-on-accent ring-2 ring-surface"
        >
          {count}
        </span>
      )}
    </button>
  );
}

export interface NotificationDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly unread: number;
  readonly filter: NoticeFilter;
  readonly onFilter: (filter: NoticeFilter) => void;
  readonly list: NoticeListState;
  /** A click on a notice row; the panel marks it read and opens its page, if it has one. */
  readonly onOpenItem: (item: NoticeItem, event: MouseEvent<HTMLElement>) => void;
  readonly onMarkAll: () => void;
  readonly markingAll: boolean;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  /** The per-device sound switch; absent where the panel has no sound. */
  readonly sound?: { readonly on: boolean; readonly onToggle: () => void };
  readonly labels: {
    readonly title: string;
    readonly close: string;
    /** Name of the tab row. */
    readonly filters: string;
  } & Record<NoticeFilter, string> & {
      /** The count next to the title, e.g. "3 unread". */
      readonly unreadCount: string;
      readonly soundOn: string;
      readonly soundOff: string;
      readonly markAll: string;
      readonly loadMore: string;
      readonly unreadItem: string;
      readonly empty: Record<NoticeFilter, { readonly title: string; readonly body: string }>;
      readonly error: string;
      readonly retry: string;
      readonly loading: string;
    };
}

const ICON_BUTTON =
  'flex size-(--mp-size-control) shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus';

function NoticeAvatar({ item }: { readonly item: NoticeItem }) {
  const letters = item.ownerName === null ? '' : initials(item.ownerName);
  return (
    <span aria-hidden="true" className="relative mt-0.5 shrink-0">
      <span
        className={`flex size-10 items-center justify-center rounded-full text-sm font-semibold ${AVATAR[item.tone]}`}
      >
        {letters === '' ? <Icon name={item.icon} /> : letters}
      </span>
      {letters === '' ? null : (
        <span
          className={`absolute -bottom-1 -end-1 flex size-5 items-center justify-center rounded-full ring-2 ring-surface [&>svg]:size-3 ${AVATAR[item.tone]}`}
        >
          <Icon name={item.icon} />
        </span>
      )}
    </span>
  );
}

const ROW =
  'flex gap-3 px-4 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus sm:px-6';

/** The inside of a notice row: avatar, sentence, time and group, and the unread mark. */
function NoticeRow({
  item,
  unreadLabel,
}: {
  readonly item: NoticeItem;
  readonly unreadLabel: string;
}) {
  return (
    <>
      <NoticeAvatar item={item} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-words text-sm text-fg">{item.message}</span>
        <span className="text-xs text-fg-muted">
          <time dateTime={item.dateTime}>{item.time}</time>
          <span aria-hidden="true"> · </span>
          {item.category}
        </span>
      </span>
      {item.read ? null : (
        <span className="mt-2 flex shrink-0 items-start">
          <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
          <span className="sr-only">{unreadLabel}</span>
        </span>
      )}
    </>
  );
}

/**
 * The notices drawer (plan 6c): a modal panel from the inline-end edge, 480 px wide from 1280 px,
 * 420 px on tablets and the whole screen below 640 px, over a dimmed and blurred page (no blur
 * when the reader asks for reduced motion). Built on the native `<dialog>` as the shared Dialog
 * is: the browser traps focus and closes on Escape, and focus returns to the bell.
 */
export function NotificationDrawer({
  open,
  onClose,
  unread,
  filter,
  onFilter,
  list,
  onOpenItem,
  onMarkAll,
  markingAll,
  onLoadMore,
  onRetry,
  sound,
  labels,
}: NotificationDrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useModal(ref, open);

  const empty = labels.empty[filter];
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-density="touch"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The backdrop: the panel inside fills the dialog, so only a click outside targets it.
        if (event.target === ref.current) onClose();
      }}
      className="m-0 ms-auto h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-start text-fg backdrop:bg-scrim backdrop:backdrop-blur-sm motion-reduce:backdrop:backdrop-blur-none sm:w-(--mp-size-sheet) xl:w-(--mp-size-sheet-wide)"
    >
      {open ? (
        <div className="flex h-full flex-col border-line bg-surface sm:border-s shadow-(--mp-shadow-elevation-floating)">
          <div className="flex items-center gap-2 px-4 pt-3 sm:px-6">
            <h2 id={titleId} className="min-w-0 truncate text-lg font-semibold">
              {labels.title}
            </h2>
            {unread > 0 ? (
              <Badge tone="info">
                <span aria-hidden="true">{badgeCount(unread)}</span>
                <span className="sr-only">{labels.unreadCount}</span>
              </Badge>
            ) : null}
            <span className="flex-1" />
            {sound === undefined ? null : (
              <button
                type="button"
                aria-pressed={sound.on}
                aria-label={sound.on ? labels.soundOn : labels.soundOff}
                title={sound.on ? labels.soundOn : labels.soundOff}
                onClick={sound.onToggle}
                className={ICON_BUTTON}
              >
                <Icon name={sound.on ? 'volume' : 'volume-off'} />
              </button>
            )}
            <button
              type="button"
              aria-label={labels.close}
              onClick={onClose}
              className={ICON_BUTTON}
            >
              <Icon name="x" />
            </button>
          </div>
          {/* The tab line runs edge to edge, as the rows below do. */}
          <div className="border-b border-line px-4 sm:px-6 [&>nav]:border-b-0">
            <Tabs
              label={labels.filters}
              items={NOTICE_FILTERS.map((id) => ({ id, label: labels[id] }))}
              activeId={filter}
              onSelect={(id) => onFilter(id as NoticeFilter)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.kind === 'loading' ? (
              <div role="status">
                <span className="sr-only">{labels.loading}</span>
                {/* Placeholder rows shaped like the notices: an avatar circle and two lines. */}
                <ul aria-hidden="true" className="divide-y divide-line-row">
                  {[0, 1, 2, 3].map((row) => (
                    <li
                      key={row}
                      className="flex gap-3 px-4 py-3 motion-safe:animate-pulse sm:px-6"
                    >
                      <span className="mt-0.5 size-10 shrink-0 rounded-full bg-muted" />
                      <span className="flex flex-1 flex-col gap-2 pt-1">
                        <span className="h-3 w-4/5 rounded-sm bg-muted" />
                        <span className="h-3 w-2/5 rounded-sm bg-muted" />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : list.kind === 'error' ? (
              <div role="alert" className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                <span className="flex size-(--mp-size-control-lg) items-center justify-center rounded-full bg-critical-bg text-critical-fg">
                  <Icon name="bell" />
                </span>
                <p className="max-w-prose text-sm text-fg-muted">{labels.error}</p>
                <Button variant="secondary" onClick={onRetry}>
                  {labels.retry}
                </Button>
              </div>
            ) : list.items.length === 0 ? (
              <EmptyState size="compact" icon="bell" title={empty.title} body={empty.body} />
            ) : (
              <>
                <ul className="divide-y divide-line-row">
                  {list.items.map((item) => (
                    <li key={item.id}>
                      {item.href === null ? (
                        <button
                          type="button"
                          onClick={(event) => onOpenItem(item, event)}
                          className={`${ROW} w-full text-start ${item.read ? '' : 'bg-subtle'}`}
                        >
                          <NoticeRow item={item} unreadLabel={labels.unreadItem} />
                        </button>
                      ) : (
                        <a
                          href={item.href}
                          onClick={(event) => onOpenItem(item, event)}
                          className={`${ROW} ${item.read ? '' : 'bg-subtle'}`}
                        >
                          <NoticeRow item={item} unreadLabel={labels.unreadItem} />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
                {list.hasMore ? (
                  <div className="flex justify-center px-4 py-3">
                    <Button variant="secondary" loading={list.loadingMore} onClick={onLoadMore}>
                      {labels.loadMore}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
          <div className="flex justify-end border-t border-line px-4 py-3 sm:px-6">
            <Button
              variant="secondary"
              block
              className="sm:w-auto"
              disabled={list.kind !== 'ready' || unread === 0}
              loading={markingAll}
              onClick={onMarkAll}
            >
              <Icon name="check" className="me-2" />
              {labels.markAll}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
