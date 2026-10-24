'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Badge } from '../form/badge.tsx';
import { Icon, type IconName } from '../icon/icon.tsx';
import { applyThemeChoice } from '../theme/theme-menu.tsx';
import type { ThemeChoice } from '../theme/theme.ts';

const THEME_ICONS: Record<ThemeChoice, IconName> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
};
const THEME_ORDER: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** A page of the signed-in user's own account, such as My profile or Security. */
export interface AccountMenuLink {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
}

export interface AccountMenuProps {
  readonly name: string;
  readonly email: string;
  /** A short label next to the name, such as the user's role. */
  readonly badge?: string;
  /** The account's own pages, in order. Later user settings are added here as links. */
  readonly links: readonly AccountMenuLink[];
  /** The theme saved in the cookie when the page was rendered. */
  readonly theme: ThemeChoice;
  readonly labels: {
    /** Accessible name of the trigger, e.g. "Account menu for Ada". */
    readonly trigger: string;
    /** Name of the list of the account's own pages, e.g. "Your account". */
    readonly pages: string;
    readonly theme: string;
    readonly signOut: string;
    /** Shown on the sign-out button while it is signing out. */
    readonly signingOut: string;
  } & Record<ThemeChoice, string>;
  /** Signs out; true when the page is leaving, false to stay with an error. */
  readonly onSignOut: () => Promise<boolean>;
  /** Shown above the sign-out button after a failed sign-out. */
  readonly signOutError?: string;
}

/** Up to two initials from the name, by user-perceived character, for the avatar. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  return picked
    .map((word) => Array.from(word ?? '')[0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

function Avatar({ name, large = false }: { readonly name: string; readonly large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'inline-flex shrink-0 items-center justify-center rounded-full bg-info-bg font-semibold text-info-fg ring-2 ring-accent ring-offset-2 ring-offset-surface',
        large ? 'size-12 text-base' : 'size-9 text-sm',
      ].join(' ')}
    >
      {initials(name)}
    </span>
  );
}

const ROW =
  'flex min-h-(--mp-size-control) w-full items-center gap-(--mp-space-2-5) rounded-md px-3 text-start text-sm text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-focus';

/**
 * The topbar's account menu (john 2026-10-16): the user's avatar opens a panel with who is
 * signed in, links to their own account pages, the theme, and sign-out at the bottom. A
 * disclosure, not a WAI-ARIA menu, since it holds a choose-one group and a button; Escape and a
 * click outside close it, and focus returns to the avatar.
 */
export function AccountMenu({
  name,
  email,
  badge,
  links,
  theme: saved,
  labels,
  onSignOut,
  signOutError,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(saved);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const themeId = useId();

  useEffect(() => {
    if (!open) return undefined;
    panel.current?.querySelector<HTMLElement>('a, button')?.focus();
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function chooseTheme(next: ThemeChoice) {
    setTheme(next);
    applyThemeChoice(next);
  }

  // WAI-ARIA radio group: arrows choose the next or previous theme and move focus to it; the
  // horizontal arrows follow the reading direction.
  function onThemeKey(event: KeyboardEvent<HTMLDivElement>) {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = ['ArrowDown', rtl ? 'ArrowLeft' : 'ArrowRight'];
    const back = ['ArrowUp', rtl ? 'ArrowRight' : 'ArrowLeft'];
    const step = forward.includes(event.key) ? 1 : back.includes(event.key) ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = THEME_ORDER.indexOf(theme);
    const next = THEME_ORDER[(at + step + THEME_ORDER.length) % THEME_ORDER.length] ?? theme;
    chooseTheme(next);
    event.currentTarget
      .querySelectorAll<HTMLElement>('[role="radio"]')
      [THEME_ORDER.indexOf(next)]?.focus();
  }

  async function signOut() {
    setPending(true);
    setFailed(false);
    if (await onSignOut()) return;
    setPending(false);
    setFailed(true);
  }

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={labels.trigger}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex size-(--mp-size-control) items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Avatar name={name} />
      </button>
      {open ? (
        <div
          ref={panel}
          id={panelId}
          // Focusable, so a click on the panel's own padding or text keeps focus inside it.
          tabIndex={-1}
          className="absolute end-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface shadow-lg outline-none"
        >
          <div className="flex items-center gap-3 border-b border-line p-4">
            <Avatar name={name} large />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold text-fg">{name}</p>
              <p className="break-all text-sm text-fg-muted">{email}</p>
            </div>
            {badge === undefined ? null : <Badge tone="info">{badge}</Badge>}
          </div>
          {links.length > 0 ? (
            <nav aria-label={labels.pages} className="border-b border-line p-2">
              <ul>
                {links.map((link) => (
                  <li key={link.id}>
                    <a href={link.href} className={ROW}>
                      <Icon name={link.icon} className="text-icon" />
                      <span className="min-w-0 flex-1">{link.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <span
                id={themeId}
                className="flex min-w-0 items-center gap-(--mp-space-2-5) text-sm text-fg"
              >
                <Icon name={THEME_ICONS[theme]} className="text-icon" />
                {labels.theme}
              </span>
              <div
                role="radiogroup"
                aria-labelledby={themeId}
                onKeyDown={onThemeKey}
                className="inline-flex shrink-0 rounded-md border border-line-control p-0.5"
              >
                {THEME_ORDER.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={item === theme}
                    // One tab stop for the group; arrows move between the choices.
                    tabIndex={item === theme ? 0 : -1}
                    aria-label={labels[item]}
                    title={labels[item]}
                    onClick={() => chooseTheme(item)}
                    className={[
                      'inline-flex size-(--mp-size-control) items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-focus',
                      item === theme ? 'bg-selected text-fg' : 'text-fg-muted hover:text-fg',
                    ].join(' ')}
                  >
                    <Icon name={THEME_ICONS[item]} />
                  </button>
                ))}
              </div>
            </div>
            {failed && signOutError !== undefined ? (
              <p role="alert" className="text-sm text-critical-fg">
                {signOutError}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={pending}
              aria-busy={pending}
              className="inline-flex h-(--mp-size-control) w-full items-center justify-center gap-2 rounded-md border border-line-control bg-surface px-4 text-sm font-medium text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-wait disabled:text-fg-muted"
            >
              <Icon name="log-out" />
              <span aria-live="polite">{pending ? labels.signingOut : labels.signOut}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
