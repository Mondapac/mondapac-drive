import { createUseCaseGate } from './use-case-gate';

// Allowed (use-case-gate-is-built-by-authz): platform/authz builds the gate.
export const allowed = createUseCaseGate();
