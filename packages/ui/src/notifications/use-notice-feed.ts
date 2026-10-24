'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chime } from './chime.ts';
import { laterNotice, shouldRing, type NoticeFilter } from './notices.ts';

/** The fields of a notice the bell reads; each panel's notices carry their own params. */
export interface FeedNotice {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly read: boolean;
}

/**
 * The panel's call to its own relay, as its `callApi` makes it. Only the status of a failure is
 * read: 401 and 403 stop the polling.
 */
export type NoticeCall = <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  csrfToken?: string,
) => Promise<
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly failure: { readonly status: number } }
>;

export interface NoticeFeedOptions {
  readonly call: NoticeCall;
  /** The notice routes, e.g. `notifications/seller/notices`. */
  readonly base: string;
  readonly csrfToken: string;
  /** How often the unread count is asked for while the tab is visible. */
  readonly pollMilliseconds: number;
  /**
   * Names this panel's browser state, e.g. `mp.seller.notices`: `<name>.heard` (the newest
   * notice already rung) and `<name>.sound` (the switch) in local storage, shared by the panel's
   * tabs; the BroadcastChannel `<name>`; and the Web Lock `<name>.sound`.
   */
  readonly storageName: string;
  /** The kinds that play the sound. */
  readonly ringingKinds: ReadonlySet<string>;
  /** Whether the sound is on on a device that never set the switch (seller on, admin off). */
  readonly soundByDefault: boolean;
  readonly chime: Chime;
  /** The live region's text when the count rises, e.g. "3 unread notifications". */
  readonly announce: (count: number) => string;
}

export interface NoticeFeedPage<N extends FeedNotice> {
  readonly state: 'loading' | 'error' | 'ready';
  readonly items: readonly N[];
  readonly next: string | null;
  readonly loadingMore: boolean;
  /** When the page arrived, for the relative times. */
  readonly now: number;
}

export interface NoticeFeed<N extends FeedNotice> {
  readonly unread: number;
  readonly open: boolean;
  readonly openDrawer: () => void;
  readonly close: () => void;
  readonly filter: NoticeFilter;
  readonly chooseFilter: (filter: NoticeFilter) => void;
  readonly page: NoticeFeedPage<N>;
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly markAll: () => void;
  readonly markingAll: boolean;
  /** Marks one notice read, shows it read in the list, and asks for the count again. */
  readonly markRead: (id: string) => Promise<void>;
  readonly sound: {
    readonly on: boolean;
    /** The switch is on but the browser still blocks sound on this page. */
    readonly blocked: boolean;
    readonly toggle: () => void;
    /** From a click on the "enable sound" control. */
    readonly enable: () => void;
  };
  /** The polite live region's text. */
  readonly announcement: string;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the sound may then ring once per tab, which is still a single signal.
  }
}

/** Runs `task` in one tab at a time where the browser has Web Locks; elsewhere just runs it. */
async function exclusive(lock: string, task: () => void): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    task();
    return;
  }
  await locks.request(lock, () => task());
}

/**
 * The state behind a panel's topbar bell (in-app notifications packages 2 and 3): the unread
 * badge, polled while the tab is visible (paused while hidden, asked again on return), the
 * notices list with its Unread / Read / All filter, and the sound. The sound rings once per burst
 * of new notices of a ringing kind, in one tab, never on notices already waiting when the panel
 * opens, and never as the only signal: the badge changes and a polite live region says so.
 */
export function useNoticeFeed<N extends FeedNotice>(options: NoticeFeedOptions): NoticeFeed<N> {
  const { base, csrfToken, pollMilliseconds, storageName, ringingKinds, soundByDefault, chime } =
    options;
  // The panel's call and text may be new functions on each render; the effects read the latest.
  const latest = useRef(options);
  latest.current = options;
  const heardKey = `${storageName}.heard`;
  const soundKey = `${storageName}.sound`;
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NoticeFilter>('unread');
  const [page, setPage] = useState<NoticeFeedPage<N>>({
    state: 'loading',
    items: [],
    next: null,
    loadingMore: false,
    now: 0,
  });
  const [markingAll, setMarkingAll] = useState(false);
  const [soundOn, setSoundOn] = useState(soundByDefault);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const soundOnRef = useRef(soundByDefault);
  const lastUnread = useRef<number | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const pollRef = useRef<() => Promise<void>>(async () => {});
  const listRequest = useRef(0);

  const loadList = useCallback(
    async (show: NoticeFilter, before: string | null = null) => {
      const request = ++listRequest.current;
      if (before === null) {
        setPage((current) => ({ ...current, state: 'loading', items: [], next: null }));
      } else {
        setPage((current) => ({ ...current, loadingMore: true }));
      }
      const query = before === null ? `show=${show}` : `show=${show}&before=${before}`;
      const result = await latest.current.call<{
        readonly items: readonly N[];
        readonly next: string | null;
      }>('GET', `${base}?${query}`);
      if (request !== listRequest.current) return;
      if (!result.ok) {
        setPage((current) =>
          before === null
            ? { state: 'error', items: [], next: null, loadingMore: false, now: Date.now() }
            : { ...current, loadingMore: false },
        );
        return;
      }
      const body = result.body;
      setPage((current) => ({
        state: 'ready',
        items: before === null ? body.items : [...current.items, ...body.items],
        next: body.next,
        loadingMore: false,
        now: Date.now(),
      }));
    },
    [base],
  );

  const heard = useCallback(
    async (newest: Pick<FeedNotice, 'id' | 'kind'> | null) => {
      let rang = false;
      await exclusive(soundKey, () => {
        const last = readStored(heardKey);
        rang = shouldRing(newest, last, ringingKinds);
        writeStored(heardKey, laterNotice(newest?.id ?? null, last));
      });
      if (!rang) return;
      channel.current?.postMessage('rang');
      if (soundOnRef.current && !(await chime.play())) setSoundBlocked(true);
    },
    [chime, heardKey, soundKey, ringingKinds],
  );

  // The badge: poll while the tab is visible; pause while hidden; ask at once on return.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastPoll = 0;

    async function poll() {
      lastPoll = Date.now();
      const result = await latest.current.call<{
        readonly unread: number;
        readonly newest: FeedNotice | null;
      }>('GET', `${base}/unread-count`);
      if (stopped) return;
      if (!result.ok) {
        // Signed out, or no longer allowed: the badge stops asking until the next page load.
        if (result.failure.status === 401 || result.failure.status === 403) {
          stopped = true;
          clearInterval(timer);
        }
        return;
      }
      const { unread: count, newest } = result.body;
      if (lastUnread.current !== null && count > lastUnread.current) {
        setAnnouncement(latest.current.announce(count));
      }
      lastUnread.current = count;
      setUnread(count);
      await heard(newest);
    }
    pollRef.current = poll;

    function schedule() {
      clearInterval(timer);
      if (stopped || document.visibilityState !== 'visible') return;
      timer = setInterval(() => void poll(), pollMilliseconds);
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        if (!stopped) void poll();
        schedule();
      } else {
        clearInterval(timer);
      }
    }
    function onFocus() {
      // Focus often follows a visibility change; skip it when that poll has just run.
      if (!stopped && Date.now() - lastPoll > 5_000) void poll();
    }

    if (typeof BroadcastChannel === 'function') {
      channel.current = new BroadcastChannel(storageName);
      channel.current.onmessage = () => {
        if (!stopped) void poll();
      };
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    if (document.visibilityState === 'visible') void poll();
    schedule();
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      channel.current?.close();
      channel.current = null;
    };
  }, [base, heard, pollMilliseconds, storageName]);

  // The per-device sound switch, and whether the browser still blocks sound on this page.
  useEffect(() => {
    const stored = readStored(soundKey);
    const on = soundByDefault ? stored !== 'off' : stored === 'on';
    soundOnRef.current = on;
    setSoundOn(on);
    if (!on) return undefined;
    let done = false;
    void chime.unlock().then((ready) => {
      if (!done) setSoundBlocked(!ready);
    });
    // Any click or key on the page lets sound play; the hint then goes away by itself.
    const unlock = () => {
      void chime.unlock().then((ready) => {
        if (ready && !done) setSoundBlocked(false);
      });
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      done = true;
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, [chime, soundKey, soundByDefault]);

  function toggleSound() {
    const next = !soundOn;
    soundOnRef.current = next;
    setSoundOn(next);
    writeStored(soundKey, next ? 'on' : 'off');
    if (next) {
      void chime.unlock().then((ready) => setSoundBlocked(!ready));
    } else {
      setSoundBlocked(false);
    }
  }

  async function markRead(id: string) {
    await latest.current.call('POST', `${base}/${id}/read`, {}, csrfToken);
    setPage((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
    }));
    void pollRef.current();
  }

  async function markAll() {
    setMarkingAll(true);
    const result = await latest.current.call('POST', `${base}/read-all`, {}, csrfToken);
    setMarkingAll(false);
    if (!result.ok) return;
    lastUnread.current = 0;
    setUnread(0);
    void loadList(filter);
  }

  return {
    unread,
    open,
    openDrawer: () => {
      setOpen(true);
      void loadList(filter);
    },
    close: () => setOpen(false),
    filter,
    chooseFilter: (next) => {
      setFilter(next);
      void loadList(next);
    },
    page,
    loadMore: () => {
      if (page.next !== null) void loadList(filter, page.next);
    },
    retry: () => void loadList(filter),
    markAll: () => void markAll(),
    markingAll,
    markRead,
    sound: {
      on: soundOn,
      blocked: soundBlocked,
      toggle: toggleSound,
      enable: () => void chime.unlock().then((ready) => setSoundBlocked(!ready)),
    },
    announcement,
  };
}
