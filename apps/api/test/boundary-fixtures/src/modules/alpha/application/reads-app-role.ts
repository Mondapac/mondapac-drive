// Violation: a module never reads the process role (P 12.2 rule 3).
declare const config: { appRole: string };

export function violates(): string {
  return config.appRole;
}
