// Allowed: platform/ owns raw SQL and $transaction (P 12.2 rule 4).
declare const db: {
  $queryRaw: (sql: string) => unknown;
  $transaction: (fn: () => unknown) => unknown;
};

export function allowed(): unknown[] {
  return [db.$queryRaw('SELECT 1'), db.$transaction(() => 1)];
}
