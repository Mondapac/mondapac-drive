/**
 * Nest injection token of the platform's `UseCaseGate` (identity design 5.2). A module's
 * provider of a use case injects this token and passes the gate to the use case's constructor;
 * the gate class itself is never a value outside `platform/authz/` (security review of slice
 * 1c, M1).
 */
export const USE_CASE_GATE = Symbol('USE_CASE_GATE');
