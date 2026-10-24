// The audit writer's implementation (docs/design/domain/platform-audit.md 2): private to
// platform/persistence/. A module reaches only its own bound AUDIT_WRITER token.
export function createAuditWriter(owner: string): { readonly owner: string } {
  return { owner };
}
