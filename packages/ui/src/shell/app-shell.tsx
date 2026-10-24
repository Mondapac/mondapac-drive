'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';
import { SIDEBAR_COLLAPSED, SIDEBAR_COOKIE } from './nav.ts';

export interface BottomTab {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly active: boolean;
}

export interface AppShellProps {
  readonly sidebar: ReactNode;
  readonly topbar: ReactNode;
  readonly children: ReactNode;
  /** Texts of the phone navigation (the app resolves them from its catalogue). */
  readonly labels: {
    readonly menu: string;
    readonly close: string;
    readonly more: string;
    /** Name of the bottom bar landmark. */
    readonly main: string;
    /** The sidebar toggle from 760 px, before and after it narrows the sidebar to icons. */
    readonly collapse: string;
    readonly expand: string;
  };
  /** The saved sidebar choice (the `SIDEBAR_COOKIE` cookie), so the first paint is right. */
  readonly collapsed?: boolean;
  /** Seller only (panels IA 4): tabs of the phone bottom bar; "More" is added by the shell. */
  readonly bottomTabs?: readonly BottomTab[];
  /** True when none of the tabs is active, so "More" shows as the active one. */
  readonly moreActive?: boolean;
}

/**
 * The one shell of both panels (kickoff 2, panels IA 4). From 760 px the sidebar is a column
 * that the toggle on its edge narrows to an icon rail; a pointer resting on the rail, or focus
 * inside it, opens it over the page until it leaves (Escape closes it). Below 760 px the same sidebar opens as a
 * drawer from the menu button (and, for the seller, from "More" in the bottom bar). There is no
 * icon rail on phones (D16, IA 4.1).
 */
// Peek pauses: long enough that a pointer crossing the rail does not open it, short enough to
// feel immediate when it rests there.
const OPEN_DELAY = 150;
const CLOSE_DELAY = 100;

export function AppShell({
  sidebar,
  topbar,
  children,
  labels,
  bottomTabs,
  moreActive,
  collapsed: savedCollapsed = false,
}: AppShellProps) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [peek, setPeek] = useState(false);
  const rail = collapsed && !peek;
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // After Escape the rail stays closed until focus leaves it and comes back.
  const dismissed = useRef(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const hasBar = bottomTabs !== undefined && bottomTabs.length > 0;

  useEffect(() => {
    const dialog = drawer.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    // The drawer is a phone control: widening the window past 760 px closes it.
    const query = window.matchMedia('(min-width: 760px)');
    const close = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    query.addEventListener('change', close);
    return () => query.removeEventListener('change', close);
  }, []);

  useEffect(() => () => clearTimeout(peekTimer.current), []);

  /** Opens or closes the peek after a short pause, so a pointer passing over does not flash it. */
  function peekLater(value: boolean, delay: number) {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(value), delay);
  }

  function toggle() {
    const next = !collapsed;
    clearTimeout(peekTimer.current);
    setCollapsed(next);
    setPeek(false);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? SIDEBAR_COLLAPSED : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <div
      className={`grid min-h-screen grid-cols-1 bg-page transition-[grid-template-columns] duration-200 motion-reduce:transition-none ${collapsed ? 'md:grid-cols-[var(--mp-size-sidebar-collapsed)_minmax(0,1fr)]' : 'md:grid-cols-[var(--mp-size-sidebar)_minmax(0,1fr)]'}`}
    >
      {/* The column keeps its width; the panel inside widens over the page while peeking. */}
      <aside
        data-collapsed={collapsed}
        className="relative z-20 hidden md:sticky md:top-0 md:block md:h-screen"
      >
        {/* First in tab order, and outside the panel so pointing at it never opens the panel;
            while the panel is open it sits on the open edge and keeps it open. */}
        <button
          type="button"
          aria-label={collapsed ? labels.expand : labels.collapse}
          aria-expanded={!collapsed}
          onClick={toggle}
          onMouseEnter={() => {
            if (peek) clearTimeout(peekTimer.current);
          }}
          onMouseLeave={() => {
            if (peek) peekLater(false, CLOSE_DELAY);
          }}
          className={`absolute top-[calc(var(--mp-size-topbar)/2)] z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-full border border-line-control bg-surface text-fg-secondary transition-[inset-inline-start] duration-200 hover:bg-muted hover:text-fg motion-reduce:transition-none ${rail ? 'start-[calc(var(--mp-size-sidebar-collapsed)-0.875rem)]' : 'start-[calc(var(--mp-size-sidebar)-0.875rem)]'}`}
        >
          <Icon
            name="chevrons-left"
            className={collapsed ? 'rotate-180 rtl:rotate-0' : 'rtl:rotate-180'}
          />
        </button>
        <div
          data-rail={rail}
          onMouseEnter={() => {
            if (collapsed) peekLater(true, OPEN_DELAY);
          }}
          onMouseLeave={() => peekLater(false, CLOSE_DELAY)}
          onFocus={() => {
            if (collapsed && !dismissed.current) {
              clearTimeout(peekTimer.current);
              setPeek(true);
            }
          }}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            dismissed.current = false;
            peekLater(false, 0);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !peek) return;
            dismissed.current = true;
            clearTimeout(peekTimer.current);
            setPeek(false);
          }}
          className={`group/rail flex h-full flex-col overflow-x-hidden border-e border-line bg-surface transition-[width] duration-200 motion-reduce:transition-none ${collapsed ? 'absolute inset-y-0 start-0' : ''} ${rail ? 'w-(--mp-size-sidebar-collapsed)' : 'w-(--mp-size-sidebar)'} ${collapsed && peek ? 'shadow-(--mp-shadow-elevation-floating)' : ''}`}
        >
          {sidebar}
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        {/* The top bar stays in view while the page scrolls, as the sidebar does. */}
        <div className="sticky top-0 z-10 flex items-stretch border-b border-line bg-surface">
          <button
            type="button"
            aria-label={labels.menu}
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex min-h-12 min-w-12 items-center justify-center text-fg md:hidden"
          >
            <Icon name="menu" />
          </button>
          <div className="min-w-0 flex-1">{topbar}</div>
        </div>
        <main className={`min-w-0 flex-1 p-4 sm:p-6 ${hasBar ? 'pb-24 md:pb-6' : ''}`}>
          {children}
        </main>
      </div>
      <dialog
        ref={drawer}
        aria-label={labels.menu}
        data-density="touch"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClick={(event) => {
          // A click on the backdrop targets the dialog element itself; the panel inside fills it.
          if (event.target === drawer.current) setOpen(false);
        }}
        className="m-0 h-full max-h-none w-[min(20rem,85vw)] max-w-none bg-transparent p-0 text-fg backdrop:bg-scrim md:hidden"
      >
        <div className="relative flex h-full flex-col bg-surface">
          <button
            type="button"
            aria-label={labels.close}
            onClick={() => setOpen(false)}
            className="absolute end-1 top-1 flex min-h-12 min-w-12 items-center justify-center text-fg-secondary"
          >
            <Icon name="x" />
          </button>
          {open ? sidebar : null}
        </div>
      </dialog>
      {hasBar ? (
        <nav
          aria-label={labels.main}
          className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {bottomTabs.map((tab) => (
            <a
              key={tab.id}
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              className={`flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 text-xs font-medium ${tab.active ? 'text-link' : 'text-fg-secondary'}`}
            >
              <Icon name={tab.icon} />
              <span className="max-w-full text-center leading-tight">{tab.label}</span>
            </a>
          ))}
          <button
            type="button"
            aria-expanded={open}
            aria-current={moreActive === true || open ? 'page' : undefined}
            onClick={() => setOpen(true)}
            className={`flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 text-xs font-medium ${moreActive === true || open ? 'text-link' : 'text-fg-secondary'}`}
          >
            <Icon name="menu" />
            <span className="max-w-full text-center leading-tight">{labels.more}</span>
          </button>
        </nav>
      ) : null}
    </div>
  );
}
