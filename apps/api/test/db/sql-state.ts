import type { Client } from 'pg';

/** Lock contention with a parallel spec: a deadlock or a lock timeout says nothing about the rule under test. */
const CONTENTION = new Set(['40P01', '55P03']);
const ATTEMPTS = 6;

/**
 * The SQLSTATE of a statement that must fail, or null when it succeeded. Statements that take
 * table-level locks (TRUNCATE ... CASCADE refused by a trigger only after it holds the locks) can
 * deadlock with another spec writing to the same tables in parallel; such a statement is tried
 * again a few times, so the answer is the rule's own state and never the contention. For
 * autocommit statements only: inside a transaction a failed statement aborts it (25P02).
 */
export async function sqlState(
  client: Client,
  text: string,
  values: unknown[] = [],
): Promise<string | null> {
  let state: string | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      state = (error as { code?: string }).code ?? 'unknown';
      if (!CONTENTION.has(state)) return state;
      // A failed statement outside a transaction leaves the connection usable.
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  return state;
}
