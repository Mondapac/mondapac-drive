// Violation: a module never runs raw SQL or opens a transaction; only platform/ does (P 12.2 rule 4).
declare const db: Record<string, (...args: unknown[]) => unknown>;

export function violation(): unknown[] {
  return [
    db.$queryRaw('SELECT 1'),
    db.$executeRaw('SELECT 1'),
    db.$queryRawUnsafe('SELECT 1'),
    db.$executeRawUnsafe('SELECT 1'),
    db.$queryRawTyped('SELECT 1'),
    db.$transaction(() => 1),
  ];
}
