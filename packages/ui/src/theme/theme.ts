// Panel colour theme (owner decision 2026-10-16, option A): follow the system light or dark
// setting unless the user picks one, which is kept in a cookie. Not a client module, so the
// server layouts read these names as values.

export const THEME_COOKIE = 'mp-theme';

export type ThemeChoice = 'system' | 'light' | 'dark';

/** The saved choice from the cookie's value; anything else follows the system. */
export function themeChoice(value: string | undefined): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * Served as /theme.js and loaded in <head> before the page paints: under "system" it sets `data-theme` from the system
 * setting and keeps it in step when that setting changes. A saved choice is already on the
 * <html> element from the server, so the script leaves it alone.
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,m=window.matchMedia('(prefers-color-scheme: dark)');function a(){if(d.getAttribute('data-theme-choice')==='system')d.setAttribute('data-theme',m.matches?'dark':'light')}a();m.addEventListener('change',a)})()`;
