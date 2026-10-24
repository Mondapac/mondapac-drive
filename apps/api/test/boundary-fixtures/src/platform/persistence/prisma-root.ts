import { PrismaClient } from '../../generated/prisma/client';

// The base client, without the market guard: private to platform/persistence/.
export class PrismaRoot extends PrismaClient {}
