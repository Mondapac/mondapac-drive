// Typed navigation config and its filter (panels IA section 3 and 7). The sidebar, the
// drawer and the bottom bar all render the one filtered config; filtering is presentation
// only, the server authorises every route and call (ADR-0018).

import type { IconName } from '../icon/icon.tsx';

export interface NavItem {
  readonly id: string;
  /** Message key of the label (text lives in the app's catalogue, ADR-0033 decision 10). */
  readonly labelKey: string;
  readonly href: string;
  /** Every item has an icon from the shared set (Figma NavItem). */
  readonly icon: IconName;
  readonly group?: string;
  /** Permission keys; the item shows with any one of them. Absent means always shown. */
  readonly anyOf?: readonly string[];
  /** Where the badge count comes from; the count itself is fetched by the app. */
  readonly badgeSource?: string;
}

export interface NavConfig {
  readonly items: readonly NavItem[];
}

/** The items the caller may see, in config order. An item with no `anyOf` is always shown. */
export function visibleNavItems(
  config: NavConfig,
  permissionKeys: ReadonlySet<string>,
): readonly NavItem[] {
  return config.items.filter(
    (item) => item.anyOf === undefined || item.anyOf.some((key) => permissionKeys.has(key)),
  );
}

// Here, not in the client shell, so a server component reads the same names as values.
/** Cookie that keeps the sidebar narrowed to icons across pages and visits. */
export const SIDEBAR_COOKIE = 'mp-sidebar';
export const SIDEBAR_COLLAPSED = 'collapsed';

/** The saved sidebar choice from the cookie's value; anything else is the full sidebar. */
export function sidebarCollapsed(value: string | undefined): boolean {
  return value === SIDEBAR_COLLAPSED;
}

/**
 * The breadcrumb above a page: the panel's first item (its home) and the active item, each only
 * when it is not the page itself. `label` resolves a label key through the app's messages.
 */
export function navTrail(
  items: readonly NavItem[],
  activeId: string,
  pageTitle: string,
  label: (key: string) => string,
): readonly { label: string; href: string }[] {
  const active = items.find((candidate) => candidate.id === activeId);
  const trail: { label: string; href: string }[] = [];
  for (const item of [items[0], active]) {
    if (item === undefined || trail.some((crumb) => crumb.href === item.href)) continue;
    const text = label(item.labelKey);
    // The active item is the page itself when the page carries its name (a menu page, not a tab
    // under it); the home item is the page itself when it is active.
    const isPage = item === active && (item === items[0] || text === pageTitle);
    if (!isPage) trail.push({ label: text, href: item.href });
  }
  return trail;
}
