// Pure helpers of the panel bell (in-app notifications package 2), shared by both panels.

/** The read-state filters of the drawer (john 2026-10-17): unread first, then read, then all. */
export const NOTICE_FILTERS = ['unread', 'read', 'all'] as const;
export type NoticeFilter = (typeof NOTICE_FILTERS)[number];

/** The bell's badge text: nothing at 0, the count up to 99, then "99+" (john 2026-10-17). */
export function badgeCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** How often the seller panel asks for the unread count while its tab is visible. */
export const SELLER_POLL_MILLISECONDS = 30_000;

/** How often the admin panel asks, also only while its tab is visible (package 3). */
export const ADMIN_POLL_MILLISECONDS = 60_000;

/**
 * Whether a poll's newest unread notice should ring. Notice ids are UUID v7, so a later notice
 * has a greater id: only a notice of a ringing kind newer than the last one heard rings. A burst
 * of orders between two polls rings once, the same notice never rings twice, and reading the
 * newest (so an older unread one becomes the newest) rings nothing. With nothing heard yet (the
 * first poll on this device) nothing rings: notices already waiting when the panel opens are
 * shown by the badge.
 */
export function shouldRing(
  newest: { readonly id: string; readonly kind: string } | null,
  lastHeard: string | null,
  ringingKinds: ReadonlySet<string>,
): boolean {
  if (newest === null || lastHeard === null || !ringingKinds.has(newest.kind)) return false;
  return newest.id.toLowerCase() > lastHeard.toLowerCase();
}

/** Remembered after a first poll with nothing unread: sorts before every UUID. */
export const HEARD_NONE = '0';

/** What to remember as heard after a poll: the later of the two ids (UUID v7 order). */
export function laterNotice(newestId: string | null, lastHeard: string | null): string {
  if (newestId === null) return lastHeard ?? HEARD_NONE;
  if (lastHeard === null) return newestId.toLowerCase();
  return newestId.toLowerCase() > lastHeard.toLowerCase() ? newestId.toLowerCase() : lastHeard;
}
