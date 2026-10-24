import { PrismaRoot } from '../../../platform/persistence/prisma-root';

// Violation (persistence-root-is-private, platform persistence design 12.2 rule 2): a module's
// infrastructure imports nothing of platform/persistence/ but prisma.service.ts, so it never
// holds the client without the market guard.
export const violation = new PrismaRoot();
