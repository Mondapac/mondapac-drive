// Violation: only main.ts and platform/worker/ read appRole (P 12.2 rule 3).
declare const config: { appRole: string };

export function violates(): unknown[] {
  return [config.appRole, config.appRole === 'worker'];
}
