// Violation: application/ takes a unit of work from the platform; it never calls $transaction.
declare const db: { $transaction: (fn: () => unknown) => unknown };

export function violation(): unknown {
  return db.$transaction(() => 1);
}
