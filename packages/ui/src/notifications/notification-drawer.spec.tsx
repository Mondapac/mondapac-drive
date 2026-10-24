import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  NotificationBell,
  NotificationDrawer,
  type NoticeItem,
  type NotificationDrawerProps,
} from './notification-drawer.tsx';

const labels: NotificationDrawerProps['labels'] = {
  title: 'Notifications',
  close: 'Close notifications',
  filters: 'Show notifications',
  unread: 'Unread',
  read: 'Read',
  all: 'All',
  unreadCount: '3 unread',
  soundOn: 'Sound on',
  soundOff: 'Sound off',
  markAll: 'Mark all as read',
  loadMore: 'Show older',
  unreadItem: 'Unread',
  empty: {
    unread: { title: "You're all caught up", body: 'New orders show up here.' },
    read: { title: 'Nothing read yet', body: 'b' },
    all: { title: 'No notifications yet', body: 'b' },
  },
  error: 'Notifications could not be loaded.',
  retry: 'Try again',
  loading: 'Loading notifications',
};

const item: NoticeItem = {
  id: 'n1',
  href: '/orders/o1',
  ownerName: null,
  icon: 'clipboard',
  tone: 'success',
  message: 'New order with 2 items',
  time: '5 minutes ago',
  dateTime: '2026-10-18T10:00:00Z',
  category: 'Orders',
  read: false,
};

function drawer(overrides: Partial<NotificationDrawerProps> = {}) {
  return renderToStaticMarkup(
    <NotificationDrawer
      open
      onClose={() => {}}
      unread={3}
      filter="unread"
      onFilter={() => {}}
      list={{ kind: 'ready', items: [item], hasMore: false, loadingMore: false }}
      onOpenItem={() => {}}
      onMarkAll={() => {}}
      markingAll={false}
      onLoadMore={() => {}}
      onRetry={() => {}}
      labels={labels}
      {...overrides}
    />,
  );
}

describe('NotificationBell', () => {
  it('shows no badge at 0 and caps it at "99+", with the count in its name', () => {
    const none = renderToStaticMarkup(
      <NotificationBell unread={0} expanded={false} onClick={() => {}} label="Notifications" />,
    );
    expect(none).not.toMatch(/bg-critical-solid/);
    const many = renderToStaticMarkup(
      <NotificationBell
        unread={240}
        expanded={false}
        onClick={() => {}}
        label="Notifications, 240 unread"
      />,
    );
    expect(many).toContain('>99+<');
    expect(many).toContain('aria-label="Notifications, 240 unread"');
    expect(many).toContain('aria-haspopup="dialog"');
  });
});

describe('NotificationDrawer', () => {
  it('opens from the end edge, full width on phones, 420 px on tablets and 480 px from 1280 px', () => {
    const html = drawer();
    expect(html).toMatch(
      /class="[^"]*\bms-auto\b[^"]*\bw-full\b[^"]*sm:w-\(--mp-size-sheet\)[^"]*xl:w-\(--mp-size-sheet-wide\)/,
    );
  });

  it('blurs the page behind it, but not for readers who ask for reduced motion', () => {
    const html = drawer();
    expect(html).toContain('backdrop:backdrop-blur-sm');
    expect(html).toContain('motion-reduce:backdrop:backdrop-blur-none');
  });

  it('offers Unread, Read and All as tabs with the current one pressed', () => {
    const html = drawer({ filter: 'read' });
    expect(html).toMatch(/aria-pressed="false"[^>]*>Unread</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Read</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>All</);
  });

  it('links each notice to its item and marks an unread one in words, not colour only', () => {
    const html = drawer();
    expect(html).toContain('href="/orders/o1"');
    expect(html).toContain('<time dateTime="2026-10-18T10:00:00Z">5 minutes ago</time>');
    expect(html).toMatch(/class="sr-only">Unread</);
  });

  it('shows a notice without a page as a button, not a link', () => {
    const html = drawer({
      list: {
        kind: 'ready',
        items: [{ ...item, href: null }],
        hasMore: false,
        loadingMore: false,
      },
    });
    expect(html).not.toContain('<a ');
    expect(html).toMatch(/<button type="button" class="flex[^"]*w-full text-start/);
  });

  it('shows the owner initials with the type icon on the corner when the owner is named', () => {
    const html = drawer({
      list: {
        kind: 'ready',
        items: [{ ...item, ownerName: 'Maryam R.' }],
        hasMore: false,
        loadingMore: false,
      },
    });
    expect(html).toContain('>MR<');
  });

  it('has empty, loading and error states, and disables Mark all with nothing unread', () => {
    const empty = drawer({
      unread: 0,
      list: { kind: 'ready', items: [], hasMore: false, loadingMore: false },
    });
    expect(empty).toContain('You&#x27;re all caught up');
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>.*Mark all as read/);
    expect(drawer({ list: { kind: 'loading' } })).toContain('Loading notifications');
    const error = drawer({ list: { kind: 'error' } });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Try again');
  });

  it('shows the sound switch only where the panel has a sound', () => {
    expect(drawer()).not.toContain('Sound on');
    const html = drawer({ sound: { on: true, onToggle: () => {} } });
    expect(html).toMatch(/aria-pressed="true" aria-label="Sound on"/);
  });
});
