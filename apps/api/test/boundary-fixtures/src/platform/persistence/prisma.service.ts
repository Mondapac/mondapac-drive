import { PrismaClient } from '../../generated/prisma/client';

// Allowed: platform/persistence owns the Prisma client.
export class PrismaService extends PrismaClient {}
