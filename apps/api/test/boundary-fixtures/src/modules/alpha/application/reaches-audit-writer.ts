import { createAuditWriter } from '../../../platform/persistence/audit/prisma-audit-writer';

// Violation (persistence-internals-are-private; platform-audit.md 2 and 16 "no module imports
// platform/persistence/audit"): application code cannot build a writer for another owner.
export const violation = createAuditWriter('beta');
