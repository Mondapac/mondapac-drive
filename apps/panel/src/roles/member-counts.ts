import { serverGet } from '../server/server-fetch.ts';
import type { TeamPage } from '../team/types.ts';

const MAX_PAGES = 20;

/**
 * Active admin accounts per role, counted from the team list (`GET identity/admin/team`).
 * Null when the list cannot be read in full (no access, a failed page or too many pages): the
 * Members column is then left out rather than shown wrong.
 */
export async function memberCounts(): Promise<ReadonlyMap<string, number> | null> {
  const counts = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: Awaited<ReturnType<typeof serverGet<TeamPage>>> = await serverGet<TeamPage>(
      `identity/admin/team${after === null ? '' : `?after=${encodeURIComponent(after)}`}`,
    );
    if (result.kind !== 'ok') return null;
    for (const row of result.body.items) {
      if (row.type === 'account' && row.status === 'active' && row.role !== null) {
        counts.set(row.role.roleId, (counts.get(row.role.roleId) ?? 0) + 1);
      }
    }
    if (result.body.next === null) return counts;
    after = result.body.next;
  }
  return null;
}
