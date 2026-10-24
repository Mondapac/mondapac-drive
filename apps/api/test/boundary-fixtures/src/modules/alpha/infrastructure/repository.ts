import { PrismaClient } from '../../../generated/prisma/client';

// Allowed: infrastructure may use the Prisma client.
export const repository = new PrismaClient();
