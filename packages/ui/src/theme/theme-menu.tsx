'use client';

import { useState } from 'react';
import type { IconName } from '../icon/icon.tsx';
import { Menu } from '../overlay/menu.tsx';
import { THEME_COOKIE, type ThemeChoice } from './theme.ts';

const ICONS: Record<ThemeChoice, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const ORDER: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export interface ThemeMenuProps {
  /** The choice saved in the cookie when the page was rendered. */
  readonly choice: ThemeChoice;
  /** Texts from the app's catalogue: the trigger's name and one label per choice. */
  readonly labels: { readonly menu: string } & Record<ThemeChoice, string>;
}

// A display preference, not a security value; Secure only keeps it off plain-http requests.
function secure(): string {
  return window.location.protocol === 'https:' ? '; secure' : '';
}

/** Applies a theme choice at once and keeps it for later visits (the cookie the server reads). */
export function applyThemeChoice(next: ThemeChoice) {
  const root = document.documentElement;
  root.setAttribute('data-theme-choice', next);
  if (next === 'system') {
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax${secure()}`;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
  } else {
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax${secure()}`;
    root.setAttribute('data-theme', next);
  }
}

/** The topbar's theme control: System, Light or Dark, applied at once and kept for later visits. */
export function ThemeMenu({ choice: saved, labels }: ThemeMenuProps) {
  const [choice, setChoice] = useState(saved);

  function choose(next: ThemeChoice) {
    setChoice(next);
    applyThemeChoice(next);
  }

  return (
    <Menu
      // The name carries the current choice, so a screen reader hears it on the trigger.
      label={`${labels.menu}: ${labels[choice]}`}
      title={`${labels.menu}: ${labels[choice]}`}
      icon={ICONS[choice]}
      width="narrow"
      items={ORDER.map((item) => ({
        id: item,
        label: labels[item],
        icon: ICONS[item],
        checked: item === choice,
        onSelect: () => choose(item),
      }))}
    />
  );
}
